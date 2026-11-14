// Cleaned-up genre / mood tags for browsing.
//
// Raw Plex tags from years of MP3 tagging are messy: "80's" next to "80s", "TECHNO/HOUSE",
// "house" vs "House". We fold them into groups:
//  - only the FIRST value of a combined tag counts ("TECHNO/HOUSE" → Techno; "Pop, Rock" → Pop) —
//    the user's rule: the first genre in a file is the real one;
//  - case, apostrophes, dashes and "&"/"and" are ignored when matching ("80's" = "80s");
//  - each group knows all its raw tag ids, so a group filters with `genre=id1,id2` (Plex ORs them).
// Album counts come from cheap `X-Plex-Container-Size=0` queries and are cached per library, so the
// page opens instantly and refreshes in the background.

import { serverFetch } from './media';
import { readJSON, writeJSON } from './storage';
import { STORAGE_PREFIX } from './config';
import { TYPE } from './library';

/* eslint-disable @typescript-eslint/no-explicit-any */

export type TagKind = 'genre' | 'mood';

export interface TagGroup {
	id: string; // normalized name — stable across refreshes
	name: string; // display name (the most-used spelling)
	ids: string[]; // raw Plex tag ids folded into this group
	count: number; // albums (approximate: an album with two variants counts twice — rare)
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const COUNT_CONCURRENCY = 12;
/** Groups smaller than this hide behind "Show all" — usually typos and one-off tags. */
export const SMALL_GROUP = 3;

/** First value of a combined tag: "TECHNO/HOUSE" → "TECHNO", "Pop, Rock" → "Pop". */
function firstValue(raw: string): string {
	return raw.split(/\s*[,;|/]\s*/)[0]?.trim() ?? '';
}

function normalize(name: string): string {
	return name
		.toLowerCase()
		.replace(/[’'`´]/g, '')
		.replace(/\s*&\s*/g, ' and ')
		.replace(/[-_.]+/g, ' ')
		.replace(/[()[\]{}#!?*"]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Nicer display for ALL-CAPS tags ("ELEKTRONIKUS ZENE" → "Elektronikus Zene"); keeps "EDM", "R&B". */
function tidy(name: string): string {
	if (name.length > 4 && name === name.toUpperCase() && /[A-Z]/.test(name)) {
		return name.toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
	}
	return name;
}

async function albumCount(sectionId: string, kind: TagKind, ids: string, signal?: AbortSignal): Promise<number> {
	const data = await serverFetch<any>(`/library/sections/${sectionId}/all`, {
		query: { type: TYPE.album, [kind]: ids, 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 0 },
		signal
	});
	const c = data?.MediaContainer ?? {};
	return Number(c.totalSize ?? c.size ?? 0);
}

/** Run `fn` over items with a small concurrency limit (keeps the Plex server and proxy happy). */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
	return out;
}

function cacheKey(sectionId: string, kind: TagKind) {
	return `${STORAGE_PREFIX}tags.${kind}.${sectionId}`;
}

export function cachedTagGroups(sectionId: string, kind: TagKind): TagGroup[] | null {
	const c = readJSON<{ at: number; groups: TagGroup[] } | null>(cacheKey(sectionId, kind), null);
	return c?.groups ?? null;
}

function cacheFresh(sectionId: string, kind: TagKind): boolean {
	const c = readJSON<{ at: number } | null>(cacheKey(sectionId, kind), null);
	return !!c && Date.now() - c.at < CACHE_TTL_MS;
}

/** Build the cleaned, counted groups for a library (album-level tags). */
export async function loadTagGroups(
	sectionId: string,
	kind: TagKind,
	opts: { force?: boolean; signal?: AbortSignal } = {}
): Promise<TagGroup[]> {
	if (!opts.force && cacheFresh(sectionId, kind)) return cachedTagGroups(sectionId, kind) ?? [];
	const data = await serverFetch<any>(`/library/sections/${sectionId}/${kind}`, {
		query: { type: TYPE.album },
		signal: opts.signal
	});
	const dirs: { key: string; title: string }[] = (data?.MediaContainer?.Directory ?? []).map((d: any) => ({
		key: String(d.key),
		title: String(d.title ?? '')
	}));
	const counts = await pool(dirs, COUNT_CONCURRENCY, (d) =>
		albumCount(sectionId, kind, d.key, opts.signal).catch(() => 0)
	);

	const groups = new Map<string, { names: Map<string, number>; ids: string[]; count: number }>();
	dirs.forEach((d, i) => {
		// Codes wrapped in brackets — "(CR)", "[RX]" — are tagging leftovers, not genres.
		if (/^\s*[([{].*[)\]}]\s*$/.test(d.title)) return;
		const first = firstValue(d.title);
		const id = normalize(first);
		if (!id || !/\p{L}/u.test(id)) return; // "(CR)"-style codes without letters are dropped
		const g = groups.get(id) ?? { names: new Map<string, number>(), ids: [] as string[], count: 0 };
		g.ids.push(d.key);
		g.count += counts[i];
		g.names.set(first, (g.names.get(first) ?? 0) + counts[i]);
		groups.set(id, g);
	});

	const result: TagGroup[] = [...groups.entries()]
		.map(([id, g]) => {
			const best = [...g.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? id;
			return { id, name: tidy(best), ids: g.ids, count: g.count };
		})
		.filter((g) => g.count > 0)
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

	writeJSON(cacheKey(sectionId, kind), { at: Date.now(), groups: result });
	return result;
}

/** Group lookup by raw tag (e.g. an album's first genre) — for autoplay and Daily Mixes. */
export function groupForTag(groups: TagGroup[], rawTitle: string): TagGroup | null {
	const id = normalize(firstValue(rawTitle));
	return groups.find((g) => g.id === id) ?? null;
}
