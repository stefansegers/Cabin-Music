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
