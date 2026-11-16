// BPM, key (Camelot) and energy per track, from Mixed In Key's tags.
//
// Plex strips the tags from the MP3s it serves, so they come from an index made on the Plex machine
// (scripts/keyindex.mjs → Cloudflare KV → the Worker's /tags/<server>), matched on the track's file
// path. No index for this server (or no access): nothing is shown, everything else works as before.

import { session } from '$lib/stores/session.svelte';
import { ClientIdStore } from './storage';
import { logEvent } from '$lib/stores/debug.svelte';
import type { Metadata } from './types';

export interface KeyTags {
	bpm: number | null;
	key: string | null; // Camelot: "8A", "12B"
	energy: number | null;
}

const state = $state({ server: '', ready: false });
let prefix = '';
let byFile: Record<string, string> = {};
let loading: string | null = null;

async function load(machineId: string) {
	if (loading === machineId) return;
	loading = machineId;
	try {
		const h: Record<string, string> = {};
		if (session.token) h['X-Plex-Token'] = session.token;
		const cid = ClientIdStore.get();
		if (cid) h['X-Plex-Client-Identifier'] = cid;
		const res = await fetch(`/tags/${machineId}`, { credentials: 'same-origin', headers: h });
		if (!res.ok) {
			logEvent(`bpm/key index: ${res.status} — not shown`);
			return;
		}
		const data = (await res.json()) as { prefix?: string; tracks?: Record<string, string> };
		if (session.active?.machineId !== machineId) return;
		prefix = data.prefix ?? '';
		byFile = data.tracks ?? {};
		state.server = machineId;
		state.ready = true;
		logEvent(`bpm/key index: ${Object.keys(byFile).length} tracks`);
	} catch (e) {
		logEvent(`bpm/key index failed: ${(e as Error)?.message ?? e}`);
	} finally {
		loading = null;
	}
}

/** BPM / key / energy of a track, or null (not loaded yet, not tagged, or no index). Reactive: a
 *  list re-renders once the index arrives. */
export function keyTags(t: Metadata | null | undefined): KeyTags | null {
	const id = session.active?.machineId;
	if (!id) return null;
	if (state.server !== id) {
		void load(id);
		return null;
	}
	const file = t?.Media?.[0]?.Part?.[0]?.file;
	if (!file || !file.startsWith(prefix)) return null;
	const v = byFile[file.slice(prefix.length)];
	if (!v) return null;
	const [b, k, e] = v.split('|');
	return { bpm: b ? Number(b) : null, key: k || null, energy: e ? Number(e) : null };
}

/** Is the index here (so sorting by BPM / key means something)? */
export function hasKeyTags(): boolean {
	return state.ready && state.server === session.active?.machineId;
}

// --- Camelot wheel -------------------------------------------------------------------------------

/** "8A" → { n: 8, minor: true } */
export function parseCamelot(k: string | null | undefined): { n: number; minor: boolean } | null {
	const m = k?.match(/^(\d{1,2})([AB])$/);
	return m ? { n: Number(m[1]), minor: m[2] === 'A' } : null;
}

/** The wheel's colour for a key, as Mixed In Key draws it: neighbours on the wheel get neighbouring
 *  hues (1 = turquoise, 3 = green, 5 = orange, 7 = pink, 9 = purple, 11 = blue), so keys that mix
 *  well look alike. Minor (A) a deeper shade, major (B) a lighter one. */
export function camelotColor(k: string | null | undefined): string | null {
	const c = parseCamelot(k);
	if (!c) return null;
	const hue = (165 - (c.n - 1) * 30 + 360) % 360;
	return c.minor ? `hsl(${hue} 70% 42%)` : `hsl(${hue} 75% 58%)`;
}

/** Sort position on the wheel: 1A, 1B, 2A, 2B … 12B. */
export function camelotOrder(k: string | null | undefined): number {
	const c = parseCamelot(k);
	return c ? c.n * 2 + (c.minor ? 0 : 1) : 999;
}

/** How well two keys mix: 0 = same key, 1 = a neighbour (±1, or the relative major/minor), 2 = two
 *  steps (still workable), 3 = clashes / unknown. */
export function camelotDistance(a: string | null | undefined, b: string | null | undefined): number {
	const x = parseCamelot(a);
	const y = parseCamelot(b);
	if (!x || !y) return 3;
	const step = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
	if (x.minor === y.minor) return step === 0 ? 0 : step === 1 ? 1 : step === 2 ? 2 : 3;
	return step === 0 ? 1 : step === 1 ? 2 : 3;
}

// --- Harmonic flow: autoplay / Song radio pick what mixes well -----------------------------------

const FLOW_KEY = 'cabin.flow';
function readFlow(): boolean {
	try {
		return localStorage.getItem(FLOW_KEY) !== 'false';
	} catch {
		return true;
	}
}
export const flowOpts = $state({ on: typeof localStorage !== 'undefined' ? readFlow() : true });
export function setFlow(on: boolean): void {
	flowOpts.on = on;
	try {
		localStorage.setItem(FLOW_KEY, String(on));
	} catch {
		/* storage unavailable: setting lasts this session */
	}
}

/** Tempo step between two tracks, as a share of the first: half / double time count as the same. */
function tempoGap(a: number, b: number): number {
	return Math.min(Math.abs(a - b), Math.abs(a - 2 * b), Math.abs(2 * a - b)) / a;
}

/** How well `b` follows `a`: lower is better. Unknown key or tempo sits in the middle, so untagged
 *  songs still get picked, after the ones that clearly fit. */
function flowCost(a: KeyTags | null, b: KeyTags | null): number {
	const key = a?.key && b?.key ? camelotDistance(a.key, b.key) : 1.5; // 0 same … 3 clash
	let tempo = 1;
	if (a?.bpm && b?.bpm) {
		const g = tempoGap(a.bpm, b.bpm);
		tempo = g <= 0.06 ? 0 : g <= 0.12 ? 1 : 2;
	}
	return key * 2 + tempo;
}

/** `n` tracks from `pool`, chained so each one fits the one before it (starting from `seed`).
 *  Without the BPM/key index, or with the option off, the pool's own order is kept. */
export function flowPick(seed: Metadata, pool: Metadata[], n: number): Metadata[] {
	if (!flowOpts.on || !hasKeyTags() || pool.length <= 1) return pool.slice(0, n);
	const left = pool.slice();
	const out: Metadata[] = [];
	let prev = keyTags(seed);
	while (out.length < n && left.length) {
		let best = 0;
		let bestCost = Infinity;
		left.forEach((t, i) => {
			// A little randomness so the same seed doesn't always give the same run.
			const c = flowCost(prev, keyTags(t)) + Math.random() * 0.9;
			if (c < bestCost) (bestCost = c), (best = i);
		});
		const [t] = left.splice(best, 1);
		out.push(t);
		prev = keyTags(t) ?? prev;
	}
	return out;
}
