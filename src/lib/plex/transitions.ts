// Smooth transitions between songs, from Plex's loudness analysis (the same data Plexamp uses).
//
// Plex measures how a track's level builds up in its first seconds (startRamp) and dies away in its
// last seconds (endRamp): "dB seconds;dB seconds;…", where the seconds count from the start, or back
// from the end. The last entry is the track's normal level. From that we know:
//   - cutBefore: how long before the end the track has faded to near-silence → move on to the next
//     song there instead of sitting through the tail of a fade-out or trailing silence;
//   - fadeBefore: where the fade-out gets quiet → ease the volume down to the cut, so it is never abrupt;
//   - leadIn: how much near-silence the track starts with → skip it.
// Nothing ever plays at the same time (one audio element, so the car's media controls stay put).

import { serverFetch } from './media';

export interface Transition {
	cutBefore: number; // s before the end where we move on (0 = play to the end)
	fadeBefore: number; // s before the end where the volume starts easing down (≥ cutBefore)
	leadIn: number; // s of near-silence at the start to skip (0 = none)
}

const CUT_DB = 28; // below the track's normal level = near-silence (≈ −22 dB on Plex's scale)
const FADE_DB = 16; // quiet enough to start easing the volume down
const MAX_CUT_S = 12; // never skip more of an ending than this
const MAX_FADE_S = 4; // the volume ease lasts at most this long
const MAX_LEAD_S = 3;
const MIN_LEAD_S = 0.25;

type Ramp = { db: number; t: number }[];

function parseRamp(s: unknown): Ramp | null {
	if (typeof s !== 'string' || !s.trim()) return null;
	const pts = s
		.split(';')
		.map((p) => p.trim().split(/\s+/).map(Number))
		.filter((p) => p.length === 2 && p.every(Number.isFinite))
		.map(([db, t]) => ({ db, t }));
	return pts.length >= 2 ? pts : null;
}

/** The time at which the ramp (walking along its points) first reaches `db`, interpolated. */
function timeAt(ramp: Ramp, db: number): number {
	if (ramp[0].db >= db) return 0;
	for (let i = 1; i < ramp.length; i++) {
		const a = ramp[i - 1];
		const b = ramp[i];
		if (b.db >= db) return a.t + ((db - a.db) / (b.db - a.db || 1)) * (b.t - a.t);
	}
	return 0; // never gets that loud: don't touch it
}

export function transitionFrom(startRamp: unknown, endRamp: unknown): Transition {
	const end = parseRamp(endRamp);
	const start = parseRamp(startRamp);
	let cutBefore = 0;
	let fadeBefore = 0;
	if (end) {
		const level = end[end.length - 1].db;
		cutBefore = Math.min(MAX_CUT_S, timeAt(end, level - CUT_DB));
		fadeBefore = Math.min(cutBefore + MAX_FADE_S, Math.max(cutBefore, timeAt(end, level - FADE_DB)));
	}
	let leadIn = 0;
	if (start) {
		const t = timeAt(start, start[start.length - 1].db - CUT_DB);
		if (t >= MIN_LEAD_S) leadIn = Math.min(MAX_LEAD_S, t);
	}
	return { cutBefore, fadeBefore, leadIn };
}

const cache = new Map<string, Promise<Transition | null>>();

/** A track's transition points (cached; null when Plex has no loudness data for it). */
export function getTransition(ratingKey: string | undefined): Promise<Transition | null> {
	if (!ratingKey) return Promise.resolve(null);
	let p = cache.get(ratingKey);
	if (!p) {
		p = serverFetch<any>(`/library/metadata/${ratingKey}`, { query: { includeLoudnessRamps: 1 } })
			.then((data) => {
				const streams: any[] = data?.MediaContainer?.Metadata?.[0]?.Media?.[0]?.Part?.[0]?.Stream ?? [];
				const s = streams.find((x) => x.streamType === 2);
				return s && (s.startRamp || s.endRamp) ? transitionFrom(s.startRamp, s.endRamp) : null;
			})
			.catch(() => {
				cache.delete(ratingKey); // try again next time
				return null;
			});
		cache.set(ratingKey, p);
		if (cache.size > 300) cache.delete(cache.keys().next().value!);
	}
	return p;
}
