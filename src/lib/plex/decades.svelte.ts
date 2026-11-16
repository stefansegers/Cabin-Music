// Decade radio — an endless station of tracks from one decade (the 80s, the 90s, …).
//
// Plex only knows the ALBUM's year, so compilations skew the picture: a 1985 hit on a 2003 "Back to
// the 80s" CD counts as 2000s, and an artist's 2010 "Greatest Hits" drags old songs into the 2010s.
// With "skip compilations" on (the default) the station leaves out LOOK-BACK albums — best-ofs,
// "classics", "back to the 80s", or a title naming a year outside the decade. Compilations OF their
// time stay in (a 1994 dance compilation is real 90s music; in this library that's half the 90s).

import { serverFetch } from './media';
import { TYPE } from './library';
import { readJSON, writeJSON } from './storage';
import { STORAGE_PREFIX } from './config';
import type { Metadata } from './types';
import { isMixTrack } from './mixes.svelte';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Decade {
	id: string; // `${sectionId}:${start}`
	sectionId: string;
	start: number; // 1980
	label: string; // "80s"
	albums: number; // albums from that decade (all, compilations included)
	thumbs: string[]; // up to 4 album covers for the tile
	hue: number;
}

const SKIP_KEY = STORAGE_PREFIX + 'decades.skipCompilations';
const HIDDEN_KEY = STORAGE_PREFIX + 'decades.hidden';
export const decadeOpts = $state({
	skipCompilations: readJSON<boolean>(SKIP_KEY, true) !== false,
	/** Decades (by start year, e.g. 1950) the user turned off for Home. */
	hidden: readJSON<number[]>(HIDDEN_KEY, [])
});
export function setSkipCompilations(on: boolean): void {
	decadeOpts.skipCompilations = on;
	writeJSON(SKIP_KEY, on);
}
export function toggleDecade(start: number): void {
	const h = decadeOpts.hidden;
	decadeOpts.hidden = h.includes(start) ? h.filter((x) => x !== start) : [...h, start];
	writeJSON(HIDDEN_KEY, decadeOpts.hidden);
}

const MIN_ALBUMS = 20;
const VARIOUS = /^(various( artists)?|va|v\.a\.|diverse( artiesten)?|verschillende artiesten|compilation)$/i;
// Titles of albums that look BACK: their year says when the CD came out, not when the songs did.
const LOOK_BACK =
	/\b(best of|the best|very best|greatest|grootste|hits collection|all the hits|collection|anthology|essentials?|retrospective|definitive|ultimate|platinum|gold(en)?|singles|classics?|klassiekers|back to|jaren ?\d0|\d0'?s|flashback|throwback|old ?school|forever|remember|retro|legends|anthems|decades?|all time|memories|nostalgi\w*|revival|evergreens?|oldies|remaster(ed)?|reissue|anniversary)\b/i;
const YEAR = /\b(19[5-9]\d|20[0-3]\d)\b/g;

/** True when the album's year probably isn't the song's year (for a station of `start`'s decade). */
export function isLookBack(albumTitle: string | undefined, start: number): boolean {
	const title = albumTitle ?? '';
	const years = [...title.matchAll(YEAR)].map((m) => Number(m[1]));
	// "Dance Top 100 1994" belongs to its year; "Hits of 1985" on a 2003 album does not.
	if (years.length) return years.some((y) => y < start || y > start + 9);
	// "90s Club" on a 90s album is just of its time — only another decade's name gives it away.
	const own = String(start).slice(2, 3);
	const rest = title.replace(new RegExp(`(jaren ?|')?${own}0'?s?\\b`, 'gi'), ' ');
	return LOOK_BACK.test(rest);
}
function isCompilationAlbum(a: Metadata): boolean {
	return VARIOUS.test((a.parentTitle ?? '').trim()) || LOOK_BACK.test(a.title ?? '');
}

/** "80s" for the 1900s, "2010s" from 2000 on (so the 2020s don't read as the 1920s). */
export function decadeLabel(start: number): string {
	return start >= 2000 ? `${start}s` : `${String(start).slice(2)}s`;
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}
function cacheKey(sectionId: string) {
	return `${STORAGE_PREFIX}decades.${sectionId}`;
}

/** Today's decade tiles from cache (instant render), or null when they still need building. */
export function cachedDecades(sectionId: string): Decade[] | null {
	const c = readJSON<{ day: string; decades: Decade[] } | null>(cacheKey(sectionId), null);
	return c && c.day === today() ? c.decades : null;
}

/** The decades this library has enough music for, newest first, each with a few covers. */
export async function buildDecades(sectionId: string, signal?: AbortSignal): Promise<Decade[]> {
	const cached = cachedDecades(sectionId);
	if (cached) return cached;

	const dir = await serverFetch<any>(`/library/sections/${sectionId}/decade`, {
		query: { type: TYPE.album },
		signal
	});
	const starts: number[] = (dir?.MediaContainer?.Directory ?? [])
		.map((d: any) => Number(d.key))
		.filter((n: number) => Number.isFinite(n) && n >= 1900);

	const decades = await Promise.all(
		starts.map(async (start): Promise<Decade | null> => {
			const data = await serverFetch<any>(`/library/sections/${sectionId}/all`, {
				query: {
					type: TYPE.album,
					decade: start,
					sort: 'random',
					'X-Plex-Container-Start': 0,
					'X-Plex-Container-Size': 40
				},
				signal
			});
			const c = data?.MediaContainer ?? {};
			const total = Number(c.totalSize ?? c.size ?? 0);
			if (total < MIN_ALBUMS) return null;
			const albums: Metadata[] = Array.isArray(c.Metadata) ? c.Metadata : [];
			const thumbs = [
				...new Set(albums.filter((a) => !isCompilationAlbum(a) && a.thumb).map((a) => a.thumb as string))
			].slice(0, 4);
			return {
				id: `${sectionId}:${start}`,
				sectionId,
				start,
				label: decadeLabel(start),
				albums: total,
				thumbs,
				hue: (start * 7) % 360
			};
		})
	);

	const list = decades.filter((d): d is Decade => !!d).sort((a, b) => b.start - a.start);
	writeJSON(cacheKey(sectionId), { day: today(), decades: list });
	return list;
}

/** A batch of random playable tracks from the decade (compilations left out when that's on). */
export async function decadeTracks(d: Decade, count = 30): Promise<Metadata[]> {
	const skip = decadeOpts.skipCompilations;
	const data = await serverFetch<any>(`/library/sections/${d.sectionId}/all`, {
		query: {
			type: TYPE.track,
			'album.decade': d.start,
			sort: 'random',
			'X-Plex-Container-Start': 0,
			// Oversample: look-back albums get filtered out client-side.
			'X-Plex-Container-Size': skip ? count * 3 : count
		}
	});
	const items: Metadata[] = data?.MediaContainer?.Metadata ?? [];
	const seen = new Set<string>();
	return items
		.filter((t) => {
			if (!t.Media?.[0]?.Part?.[0]?.key) return false;
			if (isMixTrack(t)) return false; // a fragment of a megamix is no song on its own
			if (skip && isLookBack(t.parentTitle, d.start)) return false;
			// One song per title+artist, so a hit that's on three albums plays once.
			const k = `${t.originalTitle ?? t.grandparentTitle ?? ''}|${t.title ?? ''}`.toLowerCase();
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		})
		.slice(0, count);
}
