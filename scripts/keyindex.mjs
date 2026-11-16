#!/usr/bin/env node
// BPM + key index for Cabin Music.
//
// Plex strips the ID3 tags from the MP3s it serves, so the app can't read the BPM and key that
// Mixed In Key wrote into them. This script reads them straight from the files on the Plex machine
// (only reads: nothing in the files or in Plex changes), and puts a compact list on Cloudflare KV
// under `tags:<Plex machineIdentifier>`, where the Worker hands it to the app.
//
//   node scripts/keyindex.mjs [--root /Volumes/music] [--dry-run]
//
// Reads ID3v2 (TBPM, TKEY, TXXX:EnergyLevel) and FLAC Vorbis comments (BPM, INITIALKEY/KEY,
// ENERGY/ENERGYLEVEL). The key is stored as Camelot (8A, 12B…); a musical key ("Am", "E") is
// converted. Only the key field counts: Mixed In Key's comment field is not used.
//
// Incremental: a file whose size and mtime are unchanged since the last run isn't read again. The
// upload only happens when the list changed.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, def) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : def;
};
const ROOT = opt('--root', '/Volumes/music');
const DRY = args.includes('--dry-run');
const PLEX = opt('--plex', 'http://127.0.0.1:32400');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'cabin-music');
const STATE = path.join(STATE_DIR, 'keyindex-state.json');
const EXT = new Set(['.mp3', '.flac']);
const MAX_TAG = 32 * 1024 * 1024;

// --- Camelot -------------------------------------------------------------------------------------

const MINOR = { 'G#': 1, AB: 1, 'D#': 2, EB: 2, 'A#': 3, BB: 3, F: 4, C: 5, G: 6, D: 7, A: 8, E: 9, B: 10, 'F#': 11, GB: 11, 'C#': 12, DB: 12 };
const MAJOR = { B: 1, 'F#': 2, GB: 2, 'C#': 3, DB: 3, 'G#': 4, AB: 4, 'D#': 5, EB: 5, 'A#': 6, BB: 6, F: 7, C: 8, G: 9, D: 10, A: 11, E: 12 };

/** "8A", "08a", "Am", "A minor", "F#", "Gbm", "E maj" → Camelot ("8A", "12B"), or null. */
export function camelot(raw) {
	if (!raw) return null;
	const s = String(raw).trim().replace(/♯/g, '#').replace(/♭/g, 'b');
	let m = s.match(/^0?(1[0-2]|[1-9])\s*([AB])$/i);
	if (m) return `${Number(m[1])}${m[2].toUpperCase()}`;
	m = s.match(/^([A-G])\s*([#b]?)\s*(m|min|minor|maj|major)?$/i);
	if (!m) return null;
	const note = (m[1] + (m[2] === 'b' ? 'B' : m[2])).toUpperCase();
	const minor = /^m(in(or)?)?$/i.test(m[3] ?? '');
	const n = (minor ? MINOR : MAJOR)[note];
	return n ? `${n}${minor ? 'A' : 'B'}` : null;
}

// --- tag readers ---------------------------------------------------------------------------------

function decodeText(buf, enc) {
	let s;
	if (enc === 1 || enc === 2) {
		let b = buf;
		let le = enc === 1;
		if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) (le = true), (b = b.subarray(2));
		else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) (le = false), (b = b.subarray(2));
		if (!le) {
			const sw = Buffer.alloc(b.length - (b.length % 2));
			for (let i = 0; i + 1 < b.length; i += 2) (sw[i] = b[i + 1]), (sw[i + 1] = b[i]);
			b = sw;
		}
		s = b.toString('utf16le');
	} else s = buf.toString(enc === 3 ? 'utf8' : 'latin1');
	return s.replace(/\0+$/, '').split('\0');
}

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

function unsync(b) {
	const out = Buffer.alloc(b.length);
	let j = 0;
	for (let i = 0; i < b.length; i++) {
		out[j++] = b[i];
		if (b[i] === 0xff && b[i + 1] === 0x00) i++;
	}
	return out.subarray(0, j);
}

function parseId3(tag, ver, flags) {
	const out = {};
	let body = tag;
	if (flags & 0x80 && ver < 4) body = unsync(body);
	let p = 0;
	if (flags & 0x40) p = ver === 4 ? syncsafe(body, 0) : body.readUInt32BE(0) + 4;
	const idLen = ver === 2 ? 3 : 4;
	const hdr = ver === 2 ? 6 : 10;
	while (p + hdr <= body.length) {
		const id = body.toString('latin1', p, p + idLen);
		if (!/^[A-Z0-9]+$/.test(id)) break; // padding
		const size =
			ver === 2 ? body.readUIntBE(p + 3, 3) : ver === 4 ? syncsafe(body, p + 4) : body.readUInt32BE(p + 4);
		const data = body.subarray(p + hdr, p + hdr + size);
		p += hdr + size;
		if (!data.length) continue;
		if (id === 'TBPM' || id === 'TBP') out.bpm = decodeText(data.subarray(1), data[0])[0];
		else if (id === 'TKEY' || id === 'TKE') out.key = decodeText(data.subarray(1), data[0])[0];
		else if (id === 'TXXX' || id === 'TXX') {
			const [desc, val] = decodeText(data.subarray(1), data[0]);
			if (/^energy(level)?$/i.test(desc ?? '')) out.energy = val;
			else if (/^initial ?key$/i.test(desc ?? '') && !out.key) out.key = val;
			else if (/^bpm$/i.test(desc ?? '') && !out.bpm) out.bpm = val;
		}
	}
	return out;
}

function parseVorbis(b) {
	const out = {};
	let p = 0;
	const vlen = b.readUInt32LE(p);
	p += 4 + vlen;
	const n = b.readUInt32LE(p);
	p += 4;
	for (let i = 0; i < n && p + 4 <= b.length; i++) {
		const len = b.readUInt32LE(p);
		const s = b.toString('utf8', p + 4, p + 4 + len);
		p += 4 + len;
		const eq = s.indexOf('=');
		const k = s.slice(0, eq).toUpperCase();
		const v = s.slice(eq + 1);
		// Mixed In Key also writes KEY / ENERGY as base64 JSON ({"key":"10A",…}); the plain
		// INITIALKEY / ENERGYLEVEL win, the encoded ones are a fallback.
		if (k === 'BPM' || k === 'TEMPO') out.bpm ??= v;
		else if (k === 'INITIALKEY') out.key = v;
		else if (k === 'KEY') out.keyAlt ??= fromMik(v, 'key') ?? v;
		else if (k === 'ENERGYLEVEL') out.energy = v;
		else if (k === 'ENERGY') out.energyAlt ??= fromMik(v, 'energyLevel') ?? v;
	}
	if (!camelot(out.key) && out.keyAlt) out.key = out.keyAlt;
	if (!parseInt(out.energy, 10) && out.energyAlt) out.energy = out.energyAlt;
	return out;
}

/** Mixed In Key's base64-JSON tag value → one field of it, or null. */
function fromMik(v, field) {
	try {
		const j = JSON.parse(Buffer.from(v, 'base64').toString('utf8'));
		return j?.[field] != null ? String(j[field]) : null;
	} catch {
		return null;
	}
}

async function readTags(file) {
	const fh = await fs.open(file, 'r');
	try {
		const head = Buffer.alloc(10);
		await fh.read(head, 0, 10, 0);
		if (head.toString('latin1', 0, 3) === 'ID3') {
			const size = syncsafe(head, 6);
			if (size <= 0 || size > MAX_TAG) return {};
			const tag = Buffer.alloc(size);
			await fh.read(tag, 0, size, 10);
			return parseId3(tag, head[3], head[5]);
		}
		if (head.toString('latin1', 0, 4) === 'fLaC') {
			let pos = 4;
			for (;;) {
				const bh = Buffer.alloc(4);
				const { bytesRead } = await fh.read(bh, 0, 4, pos);
				if (bytesRead < 4) return {};
				const last = bh[0] & 0x80;
				const type = bh[0] & 0x7f;
				const len = bh.readUIntBE(1, 3);
				if (type === 4) {
					const b = Buffer.alloc(len);
					await fh.read(b, 0, len, pos + 4);
					return parseVorbis(b);
				}
				pos += 4 + len;
				if (last) return {};
			}
		}
		return {};
	} finally {
		await fh.close();
	}
}

// --- walk, index, upload -------------------------------------------------------------------------

async function* walk(dir) {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		// Hidden files, the NAS's recycle bin and our own folder of links aren't the library.
		if (e.name.startsWith('.') || e.name === '#recycle' || e.name === TODO_DIR) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else if (e.isFile() && EXT.has(path.extname(e.name).toLowerCase())) yield p;
	}
}

function entryOf(t) {
	const bpm = Math.round(parseFloat(String(t.bpm ?? '').replace(',', '.')));
	const key = camelot(t.key);
	const energy = parseInt(String(t.energy ?? ''), 10);
	const b = bpm >= 40 && bpm <= 250 ? bpm : '';
	const e = energy >= 1 && energy <= 10 ? energy : '';
	if (!b && !key) return null;
	return `${b}|${key ?? ''}|${e}`.replace(/\|+$/, '');
}

// A folder next to the library with a link to every library track that still has no BPM/key,
// split by letter: drag a letter folder into Mixed In Key, which writes the tags into the real file
// (tested: the link stays a link). Tracks that got their tags drop out on the next run.
const TODO_DIR = '_Mixed In Key - nog analyseren';
async function syncTodo(files) {
	const lib = path.join(ROOT, 'Music Library') + '/';
	const dir = path.join(ROOT, TODO_DIR);
	const want = new Map(); // link path → target (relative)
	for (const f of Object.keys(files).sort()) {
		if (!f.startsWith(lib) || files[f].v) continue;
		const rel = f.slice(lib.length);
		const letter = rel.split('/')[0] || '_';
		let name = path.basename(f);
		let link = path.join(dir, letter, name);
		if (want.has(link)) {
			name = `${path.basename(path.dirname(f))} - ${name}`;
			link = path.join(dir, letter, name);
		}
		want.set(link, path.relative(path.join(dir, letter), f));
	}
	let added = 0;
	let removed = 0;
	// Remove links that are no longer wanted (their track got tagged, or moved).
	for (const letter of await fs.readdir(dir).catch(() => [])) {
		const sub = path.join(dir, letter);
		for (const name of await fs.readdir(sub).catch(() => [])) {
			const link = path.join(sub, name);
			const st = await fs.lstat(link).catch(() => null);
			if (st?.isSymbolicLink() && !want.has(link)) {
				await fs.unlink(link);
				removed++;
			}
		}
		if (!(await fs.readdir(sub).catch(() => [])).length) await fs.rmdir(sub).catch(() => {});
	}
	for (const [link, target] of want) {
		if (await fs.lstat(link).catch(() => null)) continue;
		await fs.mkdir(path.dirname(link), { recursive: true });
		await fs.symlink(target, link);
		added++;
	}
	console.log(`keyindex: ${want.size} library tracks still without BPM/key in "${TODO_DIR}" (+${added} −${removed})`);
}

async function main() {
	const t0 = Date.now();
	await fs.access(ROOT).catch(() => {
		console.error(`keyindex: ${ROOT} is not mounted — nothing to do`);
		process.exit(1);
	});
	const ident = await fetch(`${PLEX}/identity`).then((r) => r.text());
	const machineId = ident.match(/machineIdentifier="([^"]+)"/)?.[1];
	if (!machineId) throw new Error('no Plex machineIdentifier from /identity');

	let state = { files: {}, hash: '' };
	try {
		state = JSON.parse(await fs.readFile(STATE, 'utf8'));
	} catch {
		/* first run */
	}
	const files = {};
	let read = 0;
	let seen = 0;
	const queue = [];
	const work = async (file) => {
		const st = await fs.stat(file).catch(() => null);
		if (!st) return; // vanished or a dangling link
		const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
		const old = state.files[file];
		if (old && old.s === sig) {
			files[file] = old;
			return;
		}
		let v = null;
		try {
			v = entryOf(await readTags(file));
		} catch {
			/* unreadable tag: no entry */
		}
		read++;
		files[file] = { s: sig, v };
	};
	for await (const file of walk(ROOT)) {
		seen++;
		queue.push(work(file));
		if (queue.length >= 16) await Promise.all(queue.splice(0));
	}
	await Promise.all(queue);

	const prefix = ROOT.endsWith('/') ? ROOT : ROOT + '/';
	const tracks = {};
	for (const [file, { v }] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (v) tracks[file.slice(prefix.length)] = v;
	}
	const body = JSON.stringify({ v: 1, prefix, tracks });
	const hash = crypto.createHash('sha256').update(body).digest('hex');
	const n = Object.keys(tracks).length;
	console.log(
		`keyindex: ${seen} files, ${read} read, ${n} with BPM/key, ${(body.length / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s`
	);

	if (hash !== state.hash && !DRY) {
		const out = path.join(STATE_DIR, 'keyindex.json');
		await fs.mkdir(STATE_DIR, { recursive: true });
		await fs.writeFile(out, JSON.stringify({ ...JSON.parse(body), at: new Date().toISOString() }));
		execFileSync(
			'npx',
			['wrangler', 'kv', 'key', 'put', `tags:${machineId}`, '--path', out, '--binding', 'CABIN_KV', '--remote'],
			{ cwd: REPO, stdio: 'inherit' }
		);
		console.log(`keyindex: uploaded tags:${machineId}`);
	} else console.log(DRY ? 'keyindex: dry run, not uploaded' : 'keyindex: unchanged, not uploaded');

	if (!DRY) await syncTodo(files);

	if (!DRY) {
		await fs.mkdir(STATE_DIR, { recursive: true });
		await fs.writeFile(STATE, JSON.stringify({ files, hash: DRY ? state.hash : hash }));
	}
}

main().catch((e) => {
	console.error(`keyindex failed: ${e?.stack ?? e}`);
	process.exit(1);
});
