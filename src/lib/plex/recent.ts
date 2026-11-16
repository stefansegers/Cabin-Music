// "Recently added", per CD instead of per Plex album.
//
// Plex's own hub lists albums, and a compilation without an album artist is split into one "album"
// per track artist: nine out of ten tiles then open a single track. Here the newest tracks are
// grouped by their folder (a CD, discs merged), so a tile is the whole CD: the cover plays it, the
// text opens its page. A folder that IS one Plex album links to the normal album page.

import { serverFetch } from './media';
import { TYPE } from './library';
import { readJSON, writeJSON } from './storage';
import { STORAGE_PREFIX } from './config';
import { buildRelease, dirOf, releaseDir, releaseHref, type MixRelease, type ReleaseTrack } from './mixes.svelte';
import type { Metadata } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RecentRelease extends MixRelease {
	album: string | null; // ratingKey when the folder is exactly one Plex album
	artistKey: string | null; // the (first) track's artist, for singles
}

const FETCH = 600; // newest tracks to look at
const MAX = 16; // releases on Home

function cacheKey(sectionId: string) {
	return `${STORAGE_PREFIX}recent.${sectionId}`;
}

/** Last known list (instant render, and lookups by id from the release page after a reload). */
export function cachedRecent(sectionId: string): RecentRelease[] {
	return readJSON<{ releases: RecentRelease[] } | null>(cacheKey(sectionId), null)?.releases ?? [];
}

export function recentById(id: string): RecentRelease | null {
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i) ?? '';
		if (!k.startsWith(`${STORAGE_PREFIX}recent.`)) continue;
		const hit = cachedRecent(k.slice(`${STORAGE_PREFIX}recent.`.length)).find((r) => r.id === id);
		if (hit) return hit;
	}
	return null;
}

/** Where the text under a tile leads: a single → its artist (a one-track album page says little),
 *  one Plex album → the album page, a CD split over several Plex albums → its own page. */
export function recentHref(r: RecentRelease): string {
	if (r.keys.length === 1 && r.artistKey && r.artist) return `/artist/${r.artistKey}`;
	return r.album ? `/album/${r.album}` : releaseHref(r);
}

export async function loadRecent(sectionId: string, signal?: AbortSignal): Promise<RecentRelease[]> {
	const data = await serverFetch<any>(`/library/sections/${sectionId}/all`, {
		query: {
			type: TYPE.track,
			sort: 'addedAt:desc',
			checkFiles: 0,
			'X-Plex-Container-Start': 0,
			'X-Plex-Container-Size': FETCH
		},
		signal
	});
	const tracks: Metadata[] = data?.MediaContainer?.Metadata ?? [];
	type G = {
		tracks: ReleaseTrack[];
		albums: Set<string>;
		artist?: string;
	};
	const groups = new Map<string, G>(); // insertion order = newest first
	for (const t of tracks) {
		const d = dirOf(t);
		if (!d) continue;
		const id = releaseDir(d);
		const g = groups.get(id) ?? { tracks: [], albums: new Set<string>() };
		g.tracks.push({
			key: String(t.ratingKey),
			file: t.Media?.[0]?.Part?.[0]?.file ?? '',
			dur: t.duration ?? 0,
			thumb: t.parentThumb ?? t.thumb,
			disc: Number(t.parentIndex) || 0,
			idx: Number(t.index) || 0
		});
		if (t.parentRatingKey) g.albums.add(String(t.parentRatingKey));
		g.artist ??= t.grandparentRatingKey ? String(t.grandparentRatingKey) : undefined;
		groups.set(id, g);
	}
	let entries = [...groups];
	// The oldest group may be cut off by the fetch limit: leave it out.
	if (tracks.length >= FETCH && entries.length > 1) entries = entries.slice(0, -1);
	const list: RecentRelease[] = entries.slice(0, MAX).map(([id, g]) => ({
		...buildRelease(id, sectionId, g.tracks),
		album: g.albums.size === 1 ? [...g.albums][0] : null,
		artistKey: g.artist ?? null
	}));
	writeJSON(cacheKey(sectionId), { releases: list });
	return list;
}
