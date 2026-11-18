// Read-ahead, the way Plexamp does it: while a track plays, the NEXT one is downloaded whole into
// memory, so the track change starts at once and seeking in it never waits for the network. Over
// the car's mobile link every new request costs a round trip to the Plex server at home (and the
// server's read from its NAS), which is what made each track start slowly — big file or small.
//
// One track ahead, one file at a time, at the quality the user chose (original stays original).
// Tracks too big to hold in memory (long mixes) are left to stream as before; a gapless album run
// fetches its own data (gapless.ts), so this only covers the step into the next run.

import type { Metadata } from './types';
import { logEvent } from '$lib/stores/debug.svelte';

/** Larger tracks stream as usual: ~45 min of FLAC, a few hours of MP3. */
export const PREFETCH_MAX_BYTES = 160 * 1024 * 1024;

interface Entry {
	rk: string;
	url: string; // the source it was downloaded from
	ctrl: AbortController;
	blobUrl: string | null; // set once the download is complete
	failed: boolean;
}

let ahead: Entry | null = null; // the next track: downloading or ready
let playing: Entry | null = null; // the blob the element plays now (revoked when it moves on)

function drop(e: Entry | null) {
	if (!e) return;
	e.ctrl.abort();
	if (e.blobUrl) URL.revokeObjectURL(e.blobUrl);
}

/** Expected size of a track at the given bitrate (null = the original file). */
export function expectedBytes(t: Metadata, kbps: number | null): number {
	if (kbps) return ((t.duration ?? 0) / 1000) * kbps * 125;
	const size = t.Media?.[0]?.Part?.[0]?.size ?? 0;
	if (size > 0) return size;
	return ((t.duration ?? 0) / 1000) * (t.Media?.[0]?.bitrate || 1000) * 125;
}

/** Start downloading `t` from `url` (no-op when that is already under way or done). */
export function prefetch(t: Metadata, url: string): void {
	if (ahead && ahead.rk === t.ratingKey && ahead.url === url && !ahead.failed) return;
	drop(ahead);
	const e: Entry = { rk: t.ratingKey, url, ctrl: new AbortController(), blobUrl: null, failed: false };
	ahead = e;
	const t0 = Date.now();
	void (async () => {
		try {
			const r = await fetch(url, { cache: 'no-store', signal: e.ctrl.signal });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const blob = await r.blob();
			if (ahead !== e) return;
			e.blobUrl = URL.createObjectURL(blob);
			const mb = blob.size / 1048576;
			const s = (Date.now() - t0) / 1000;
			logEvent(`read-ahead ready: "${t.title}" ${mb.toFixed(1)} MB in ${s.toFixed(1)} s (${((mb * 8) / Math.max(s, 0.1)).toFixed(1)} Mbit/s)`);
		} catch (err) {
			if (e.ctrl.signal.aborted) return;
			e.failed = true;
			logEvent(`read-ahead failed: "${t.title}" — ${(err as Error)?.message ?? err}`);
		}
	})();
	logEvent(`read-ahead: "${t.title}"`);
}

/** Is `t` already prefetched (or being prefetched) from `url`? */
export function prefetching(t: Metadata, url: string): boolean {
	return !!ahead && ahead.rk === t.ratingKey && ahead.url === url && !ahead.failed;
}

/** The ready-to-play blob URL for `t`, taken over as the playing entry; null when not (yet) there.
 *  A download still under way for `t` is kept, in case the element asks again. */
export function takePrefetched(t: Metadata): string | null {
	if (!ahead || ahead.rk !== t.ratingKey || !ahead.blobUrl) return null;
	const prev = playing;
	playing = ahead;
	ahead = null;
	// The old blob is no longer the element's source once the caller sets the new one.
	if (prev) setTimeout(() => drop(prev), 0);
	return playing.blobUrl;
}

/** The element now plays something that is not a prefetched blob: let the old one go. */
export function releasePlaying(): void {
	const prev = playing;
	playing = null;
	if (prev) setTimeout(() => drop(prev), 0);
}

/** Forget the read-ahead (queue or quality changed). */
export function cancelPrefetch(): void {
	drop(ahead);
	ahead = null;
}

/** Is this URL one of ours (a blob)? */
export function isPrefetchUrl(url: string | undefined | null): boolean {
	return !!url && url.startsWith('blob:');
}
