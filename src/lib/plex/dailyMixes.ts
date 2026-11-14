// "Made for <name>" — Daily Mixes in the spirit of Spotify, built from the user's own listening.
//
// Taste = the first genre (cleaned up, see tags.ts) of recently played albums, weighted by recency.
// The top genres become Daily Mix 1…N. Playing one mixes familiar music (most-played tracks in that
// genre) with rediscoveries (random tracks from the genre), then autoplay carries on.
// The set of mixes is fixed per day (cached), so "Daily Mix 2" means the same thing all day.

import { getRecentAlbums, getGenreTracksShuffled } from './library';
import { cachedTagGroups, loadTagGroups, groupForTag, type TagGroup } from './tags';
import { readJSON, writeJSON } from './storage';
import { STORAGE_PREFIX } from './config';
import type { Metadata } from './types';

export interface DailyMix {
	id: string;
	n: number; // 1-based: "Daily Mix 1"
	sectionId: string;
	genre: string; // display name
	genreIds: string; // comma-joined raw tag ids (merged group)
	artists: string[]; // a few artists the mix leans on (subtitle)
	thumbs: string[]; // up to 4 album covers for the collage
	hue: number; // band colour
}

const MAX_MIXES = 6;
const MIN_GROUP_ALBUMS = 5;

function today(): string {
	return new Date().toISOString().slice(0, 10);
}
function cacheKey(sectionId: string) {
	return `${STORAGE_PREFIX}dailymix.${sectionId}`;
}

function hueOf(s: string): number {
	let h = 0;
	for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return h % 360;
}

/** Today's mixes from cache (instant render), or null when they still need building. */
export function cachedDailyMixes(sectionId: string): DailyMix[] | null {
	const c = readJSON<{ day: string; mixes: DailyMix[] } | null>(cacheKey(sectionId), null);
	return c && c.day === today() ? c.mixes : null;
}

export async function buildDailyMixes(sectionId: string, signal?: AbortSignal): Promise<DailyMix[]> {
	const cached = cachedDailyMixes(sectionId);
	if (cached) return cached;

	const [recent, groups] = await Promise.all([
		getRecentAlbums(sectionId, 300, signal),
		(async (): Promise<TagGroup[]> =>
			cachedTagGroups(sectionId, 'genre') ?? (await loadTagGroups(sectionId, 'genre', { signal })))()
	]);

	// Score genres by recency-weighted plays; remember which albums fed each one.
	const score = new Map<string, { group: TagGroup; w: number; albums: Metadata[] }>();
	recent.forEach((album, i) => {
		const first = album.Genre?.[0]?.tag;
		if (!first) return;
		const group = groupForTag(groups, first);
		if (!group || group.count < MIN_GROUP_ALBUMS) return;
		const entry = score.get(group.id) ?? { group, w: 0, albums: [] };
		entry.w += 1 + (1 - i / recent.length); // recent plays count up to double
		entry.albums.push(album);
		score.set(group.id, entry);
	});

	const mixes: DailyMix[] = [...score.values()]
		.sort((a, b) => b.w - a.w)
		.slice(0, MAX_MIXES)
		.map((e, i) => {
			const artists = [...new Set(e.albums.map((a) => a.parentTitle).filter((x): x is string => !!x))];
			const thumbs = [...new Set(e.albums.map((a) => a.thumb).filter((x): x is string => !!x))];
			return {
				id: `${sectionId}:${e.group.id}`,
				n: i + 1,
				sectionId,
				genre: e.group.name,
				genreIds: e.group.ids.join(','),
				artists: artists.slice(0, 3),
				thumbs: thumbs.slice(0, 4),
				hue: hueOf(e.group.id)
			};
		});

	writeJSON(cacheKey(sectionId), { day: today(), mixes });
	return mixes;
}

function shuffle<T>(a: T[]): T[] {
	const r = a.slice();
	for (let i = r.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[r[i], r[j]] = [r[j], r[i]];
	}
	return r;
}

/** The tracks for one mix: half favourites in the genre, half rediscoveries, mixed together. */
export async function dailyMixTracks(mix: DailyMix): Promise<Metadata[]> {
	const [favs, random] = await Promise.all([
		getGenreTracksShuffled(mix.sectionId, mix.genreIds, 80, undefined, { sort: 'viewCount:desc' }),
		getGenreTracksShuffled(mix.sectionId, mix.genreIds, 60)
	]);
	const seen = new Set<string>();
	const pick = [...shuffle(favs.filter((t) => (t.viewCount ?? 0) > 0)).slice(0, 25), ...random.slice(0, 35)];
	return shuffle(
		pick.filter((t) => {
			if (seen.has(t.ratingKey) || !t.Media?.[0]?.Part?.[0]?.key) return false;
			seen.add(t.ratingKey);
			return true;
		})
	).slice(0, 50);
}
