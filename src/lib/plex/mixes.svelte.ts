// Mixes & live albums: releases that play as one continuous piece — DJ mixes and megamixes split into
// tracks, live albums with the crowd running between songs.
//
// Plex can't tell: such a release often isn't even one album (no album artist → one "album" per
// track artist), and it has no "mix" or "live" field. What gives it away is the sound. Plex's
// loudness analysis measures how each track ends; a normal song fades or stops into silence, a track
// in a mix or a live set runs straight into the next. So: a FOLDER where most tracks end without
// silence is a mix or live album. (Measured on this library: every Turn Up The Bass, iT, Thunderdome,
// Buddha-Bar, DJ-Kicks and live album, and none of the ordinary compilations.)
//
// Those tracks are kept out of radio, autoplay, Daily Mixes and decades (a fragment of a megamix is
// no song to hear on its own), and Home lists the releases instead: one tap plays the whole CD, in
// order and gapless. The scan reads the whole library in pages (seconds) and is redone once a day.

import { serverFetch } from './media';
import { TYPE } from './library';
import { readJSON, writeJSON } from './storage';
import { STORAGE_PREFIX } from './config';
import { logEvent } from '$lib/stores/debug.svelte';
import type { Metadata } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MixRelease {
	id: string; // the release's folder (disc folders merged)
	sectionId: string;
	title: string;
	artist: string | null; // null for various artists
	keys: string[]; // track ratingKeys in play order
	thumb: string | null;
	durationMs: number;
}

const EXCLUDE_KEY = STORAGE_PREFIX + 'mixes.exclude';
export const mixOpts = $state({
	/** Keep mix and live tracks out of radio, autoplay, Daily Mixes, decades and shuffles. */
	exclude: readJSON<boolean>(EXCLUDE_KEY, true) !== false
});
export function setExcludeMixes(on: boolean): void {
	mixOpts.exclude = on;
	writeJSON(EXCLUDE_KEY, on);
}

const VERSION = 1; // bump when the detection changes, so caches rebuild
const MIN_TRACKS = 4;
const MIN_SHARE = 0.7; // of a folder's tracks must end without silence
const SILENCE_DB = 20; // an ending this far below the track's level counts as silence
const PAGE = 400;
const MAX_LIBRARY_SHARE = 0.5; // more of the library than this is mixes → it's a mixes library

function today(): string {
	return new Date().toISOString().slice(0, 10);
}
function cacheKey(sectionId: string) {
	return `${STORAGE_PREFIX}mixes.${sectionId}`;
}
type Cache = { day: string; v: number; releases: MixRelease[] };

/** Folder of a track's file ('' when unknown). */
export function dirOf(t: Metadata | null | undefined): string {
	const f = t?.Media?.[0]?.Part?.[0]?.file ?? '';
	const i = f.lastIndexOf('/');
	return i > 0 ? f.slice(0, i) : '';
}
/** "…/Thunderdome VII/Disc 02" → "…/Thunderdome VII": a release's discs belong together. */
function releaseDir(dir: string): string {
	return dir.replace(/\/(?:disc|disk|cd)[\s_-]*\d{1,2}$/i, '');
}

// Releases per section, and folder → release for the quick "is this a mix track?" check.
const releases = $state<Record<string, MixRelease[]>>({});
const byDir = new Map<string, MixRelease>();

function adopt(sectionId: string, list: MixRelease[]) {
	for (const [d, r] of byDir) if (r.sectionId === sectionId) byDir.delete(d);
	releases[sectionId] = list;
	for (const r of list) byDir.set(r.id, r);
}
function fromCache(sectionId: string): Cache | null {
	const c = readJSON<Cache | null>(cacheKey(sectionId), null);
	return c && c.v === VERSION && Array.isArray(c.releases) ? c : null;
}

/** The mix/live release a track belongs to, or null. */
export function mixReleaseOf(t: Metadata | null | undefined): MixRelease | null {
	const d = dirOf(t);
	return d ? (byDir.get(releaseDir(d)) ?? null) : null;
}
/** True for a track from a mix or live album (when keeping those out is on). */
export function isMixTrack(t: Metadata | null | undefined): boolean {
	return mixOpts.exclude && !!mixReleaseOf(t);
}
/** The list without tracks from mixes and live albums (unchanged when that option is off). */
export function withoutMixes<T extends Metadata>(list: T[]): T[] {
	if (!mixOpts.exclude || !byDir.size) return list;
	return list.filter((t) => !mixReleaseOf(t));
}

/** The releases of a section (reactive; empty until loaded or scanned). */
export function mixReleases(sectionId: string): MixRelease[] {
	return releases[sectionId] ?? [];
}

function rampOf(s: unknown): number[][] {
	if (typeof s !== 'string') return [];
	return s
		.split(';')
		.map((p) => p.trim().split(/\s+/).map(Number))
		.filter((p) => p.length === 2 && p.every(Number.isFinite));
}
/** Does the track run into the next one (no fade to silence at its end)? null when not measured. */
function endsWithoutSilence(t: any): boolean | null {
	const streams: any[] = t?.Media?.[0]?.Part?.[0]?.Stream ?? [];
	const s = streams.find((x) => x.streamType === 2);
	const end = rampOf(s?.endRamp);
	if (!end.length) return null;
	return end[0][0] > end[end.length - 1][0] - SILENCE_DB;
}

function cleanTitle(segment: string): string {
	return segment
		.replace(/\s*\((?:compilation|remix|single|soundtrack)\)\s*$/i, '')
		.replace(/_/g, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

async function scan(sectionId: string, signal?: AbortSignal): Promise<MixRelease[]> {
	const t0 = Date.now();
	type Dir = { n: number; runOn: number; tracks: { key: string; file: string; dur: number; thumb?: string }[] };
	const dirs = new Map<string, Dir>();
	const page = async (start: number) => {
		const data = await serverFetch<any>(`/library/sections/${sectionId}/all`, {
			query: {
				type: TYPE.track,
				includeLoudnessRamps: 1,
				includeElements: 'Stream', // without it a listing has no streams (and no ramps)
				checkFiles: 0,
				'X-Plex-Container-Start': start,
				'X-Plex-Container-Size': PAGE
			},
			signal,
			timeoutMs: 60_000
		});
		const c = data?.MediaContainer ?? {};
		for (const t of c.Metadata ?? []) {
			const file: string = t?.Media?.[0]?.Part?.[0]?.file ?? '';
			const i = file.lastIndexOf('/');
			if (i <= 0) continue;
			const dir = file.slice(0, i);
			const e = dirs.get(dir) ?? { n: 0, runOn: 0, tracks: [] };
			const runOn = endsWithoutSilence(t);
			if (runOn !== null) {
				e.n++;
				if (runOn) e.runOn++;
			}
			e.tracks.push({ key: String(t.ratingKey), file, dur: t.duration ?? 0, thumb: t.parentThumb ?? t.thumb });
			dirs.set(dir, e);
		}
		return Number(c.totalSize ?? 0);
	};
	const total = await page(0);
	const starts: number[] = [];
	for (let s = PAGE; s < total; s += PAGE) starts.push(s);
	const worker = async () => {
		while (starts.length) await page(starts.shift()!);
	};
	await Promise.all([worker(), worker(), worker(), worker()]);

	// Flag folders, then merge disc folders into one release.
	const merged = new Map<string, Dir['tracks']>();
	for (const [dir, e] of dirs) {
		if (e.n < MIN_TRACKS || e.runOn / e.n < MIN_SHARE) continue;
		const id = releaseDir(dir);
		merged.set(id, [...(merged.get(id) ?? []), ...e.tracks]);
	}
	const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
	const list: MixRelease[] = [...merged].map(([id, tracks]) => {
		tracks.sort((a, b) => byName(a.file, b.file));
		const parts = id.split('/');
		const title = cleanTitle(parts[parts.length - 1] ?? id);
		const up = parts[parts.length - 2] ?? '';
		// ".../D/DJ Dano/Manic Monday" → by DJ Dano; ".../Various Artists/…" or ".../V/…" → no artist.
		const artist = up.length > 1 && !/^(various( artists)?|va|music library|compilations?)$/i.test(up) ? up : null;
		return {
			id,
			sectionId,
			title,
			artist,
			keys: tracks.map((t) => t.key),
			thumb: tracks.find((t) => t.thumb)?.thumb ?? null,
			durationMs: tracks.reduce((a, t) => a + t.dur, 0)
		};
	});
	list.sort((a, b) => byName(a.title, b.title));
	// A library that is mostly mixes (a mixes library) is listened to as such: leave it alone.
	const all = [...dirs.values()].reduce((a, e) => a + e.tracks.length, 0);
	const flagged = list.reduce((a, r) => a + r.keys.length, 0);
	if (all && flagged / all > MAX_LIBRARY_SHARE) {
		logEvent(`mixes: section ${sectionId} is mostly mixes (${flagged}/${all}) — left as it is`);
		return [];
	}
	logEvent(`mixes: ${list.length} mix/live releases (${list.reduce((a, r) => a + r.keys.length, 0)} tracks) in ${Date.now() - t0} ms`);
	return list;
}

const scanning = new Map<string, Promise<MixRelease[]>>();

/** Load this section's releases: today's cache right away, otherwise a (background) scan. */
export function loadMixReleases(sectionId: string, signal?: AbortSignal): Promise<MixRelease[]> {
	const c = fromCache(sectionId);
	if (c) {
		if (!releases[sectionId]) adopt(sectionId, c.releases);
		if (c.day === today()) return Promise.resolve(c.releases);
	}
	let p = scanning.get(sectionId);
	if (!p) {
		p = scan(sectionId, signal)
			.then((list) => {
				adopt(sectionId, list);
				writeJSON(cacheKey(sectionId), { day: today(), v: VERSION, releases: list } satisfies Cache);
				return list;
			})
			.finally(() => scanning.delete(sectionId));
		scanning.set(sectionId, p);
	}
	return p;
}

/** The release's tracks, in order, ready to play. */
export async function mixReleaseTracks(r: MixRelease): Promise<Metadata[]> {
	const got = new Map<string, Metadata>();
	for (let i = 0; i < r.keys.length; i += 80) {
		const chunk = r.keys.slice(i, i + 80);
		const data = await serverFetch<any>(`/library/metadata/${chunk.join(',')}`);
		for (const t of data?.MediaContainer?.Metadata ?? []) got.set(String(t.ratingKey), t as Metadata);
	}
	return r.keys.map((k) => got.get(k)).filter((t): t is Metadata => !!t?.Media?.[0]?.Part?.[0]?.key);
}

// Folder → release from earlier days' caches, so filtering works before today's scan is done.
if (typeof localStorage !== 'undefined') {
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i) ?? '';
			const m = k.startsWith(`${STORAGE_PREFIX}mixes.`) ? k.slice(`${STORAGE_PREFIX}mixes.`.length) : '';
			if (!m || m === 'exclude') continue;
			const c = fromCache(m);
			if (c) adopt(m, c.releases);
		}
	} catch {
		/* storage unavailable: the scan fills it in */
	}
}
