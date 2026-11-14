// Gapless playback for albums (DJ mixes split into tracks, live albums) on the ONE audio element.
//
// Why not two elements: the Tesla binds its media widget to the element that started playing, so
// swapping elements at a track boundary greys out its controls (see the history of player.svelte.ts).
// Instead the single element plays a MediaSource stream into which consecutive album tracks are
// appended back to back:
//  - each track is fetched as an MP3 from Plex's transcoder (raw FLAC can't go into MediaSource);
//  - MP3 encoders add ~1105 samples of silence up front and pad the end. Every track is placed with
//    timestampOffset = start − delay and clipped with appendWindow [start, start + duration], so the
//    silence is cut and track N+1 starts on the exact sample track N ends (verified: one contiguous
//    buffered range across the boundary);
//  - Chrome caps an audio SourceBuffer at ~12 MB, so tracks are appended in chunks just ahead of the
//    playhead and played audio is evicted behind it.
// The player keeps the timeline per track: it asks `segmentAt(currentTime)` and switches title/art
// when the playhead crosses into the next track — the element never changes.

import type { Metadata } from './types';
import { logEvent } from '$lib/stores/debug.svelte';

const MP3_DELAY_S = 1105 / 44100; // LAME/ffmpeg encoder delay + decoder delay at 44.1 kHz
const CHUNK = 512 * 1024; // bytes per appendBuffer
const AHEAD_S = 45; // keep this much audio buffered ahead of the playhead
const BEHIND_S = 15; // keep this much behind it (small seeks back stay instant)
const PUMP_MS = 1000;
const EMPTY = new Uint8Array(0);

export interface Segment {
	track: Metadata;
	start: number; // seconds on the stream timeline
	end: number;
}

interface Pending {
	seg: Segment;
	parts: Uint8Array[]; // MP3 data as it streams in from the transcoder
	next: number; // first part not appended yet
	placed: boolean; // timestampOffset + appendWindow set for this track
	complete: boolean; // download finished
	fetching: Promise<void> | null;
	failed: boolean;
}

// Plex runs ONE transcode per client at a time: a second start kills or refuses the first ("Failed
// to fetch"). So every track download — across streams — waits its turn in this chain.
let transcodeChain: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
	const run = transcodeChain.then(job, job);
	transcodeChain = run.catch(() => {});
	return run;
}

export function gaplessSupported(): boolean {
	return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg');
}

export class GaplessStream {
	readonly segments: Segment[] = [];
	private ms = new MediaSource();
	private sb: SourceBuffer | null = null;
	private url: string;
	private queue: Pending[] = []; // segments not fully appended yet, in order
	private timer: ReturnType<typeof setInterval> | null = null;
	private busy = false;
	private closed = false;
	private ended = false;
	private abort = new AbortController(); // cancels this stream's downloads when it is destroyed

	constructor(
		private a: HTMLAudioElement,
		private urlFor: (t: Metadata) => string | null,
		/** Next track to chain after `prev`, or null when the album run ends. */
		private nextAfter: (prev: Metadata) => Metadata | null,
		private onFail: (why: string) => void
	) {
		this.url = URL.createObjectURL(this.ms);
	}

	/** Attach to the element and start with `first`, playing from `offsetS` into it. */
	start(first: Metadata, offsetS = 0): void {
		this.ms.addEventListener(
			'sourceopen',
			() => {
				if (this.closed) return;
				try {
					this.sb = this.ms.addSourceBuffer('audio/mpeg');
				} catch (e) {
					this.fail(`addSourceBuffer: ${(e as Error)?.message ?? e}`);
					return;
				}
				this.enqueue(first);
				// Start further in: put the playhead there now. The pump buffers relative to the playhead,
				// so it keeps appending (and evicting behind) until the target is reached; the element
				// starts playing as soon as data at the target arrives.
				if (offsetS > 0) {
					try {
						this.a.currentTime = offsetS;
					} catch {
						/* not seekable yet: applied as the default start position */
					}
				}
				void this.pump();
				this.timer = setInterval(() => void this.pump(), PUMP_MS);
			},
			{ once: true }
		);
		this.a.src = this.url;
		this.a.load();
	}

	/** Which segment (and how far into it) a stream time falls in. */
	segmentAt(t: number): { seg: Segment; index: number } | null {
		for (let i = this.segments.length - 1; i >= 0; i--) {
			if (t >= this.segments[i].start - 0.05) return { seg: this.segments[i], index: i };
		}
		return this.segments.length ? { seg: this.segments[0], index: 0 } : null;
	}

	/** Is stream time `t` already buffered (so a seek there is instant)? */
	buffered(t: number): boolean {
		const b = this.sb?.buffered;
		if (!b) return false;
		for (let i = 0; i < b.length; i++) if (t >= b.start(i) && t < b.end(i) - 0.25) return true;
		return false;
	}

	/** The queue changed after the current track: drop what was chained after it and re-plan. */
	replanAfter(current: Metadata): void {
		if (this.closed) return;
		const i = this.segments.findIndex((s) => s.track.ratingKey === current.ratingKey);
		if (i < 0) return;
		const cut = this.segments[i].end;
		this.segments.splice(i + 1);
		this.queue = this.queue.filter((p) => p.seg.start < cut);
		this.ended = false;
		void this.withSb(async (sb) => {
			if (sb.buffered.length && sb.buffered.end(sb.buffered.length - 1) > cut) {
				sb.remove(cut, Infinity);
				await this.updateEnd();
			}
		});
		void this.pump();
	}

	destroy(): void {
		if (this.closed) return;
		this.closed = true;
		this.abort.abort();
		if (this.timer) clearInterval(this.timer);
		this.queue = [];
		URL.revokeObjectURL(this.url);
	}

	// --- internals ---

	private enqueue(track: Metadata) {
		const last = this.segments[this.segments.length - 1];
		const start = last ? last.end : 0;
		const seg = { track, start, end: start + (track.duration ?? 0) / 1000 };
		this.segments.push(seg);
		this.queue.push({ seg, parts: [], next: 0, placed: false, complete: false, fetching: null, failed: false });
	}

	/** Stream a track's MP3 in; the pump appends parts while the rest is still arriving, so playback
	 *  starts after the first chunk instead of after the whole track. */
	private fetchBytes(p: Pending) {
		if (p.complete || p.fetching || p.failed) return;
		const url = this.urlFor(p.seg.track);
		if (!url) {
			p.failed = true;
			return;
		}
		p.fetching = (async () => {
			for (let attempt = 0; attempt < 3 && !p.complete && !this.closed; attempt++) {
				try {
					await oneAtATime(async () => {
						if (this.closed) throw new Error('closed');
						const r = await fetch(url, { cache: 'no-store', signal: this.abort.signal });
						if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
						const reader = r.body.getReader();
						for (;;) {
							const { value, done } = await reader.read();
							if (value?.length) p.parts.push(value);
							if (done) break;
						}
						p.complete = true;
					});
				} catch (e) {
					if (this.closed) break;
					logEvent(`gapless fetch "${p.seg.track.title}" failed: ${(e as Error)?.message ?? e}`);
					// Data already appended can't be re-sent from the start: give up on the stream then.
					if (p.next > 0) break;
					p.parts = [];
					await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
				}
			}
			if (!p.complete && !this.closed) p.failed = true;
			p.fetching = null;
		})();
	}

	private updateEnd(): Promise<void> {
		const sb = this.sb!;
		return new Promise((res, rej) => {
			const ok = () => {
				sb.removeEventListener('error', bad);
				res();
			};
			const bad = () => {
				sb.removeEventListener('updateend', ok);
				rej(new Error('SourceBuffer error'));
			};
			sb.addEventListener('updateend', ok, { once: true });
			sb.addEventListener('error', bad, { once: true });
		});
	}

	private async withSb(fn: (sb: SourceBuffer) => Promise<void>) {
		const sb = this.sb;
		if (!sb || this.closed) return;
		while (sb.updating) await new Promise((r) => setTimeout(r, 20));
		await fn(sb);
	}

	private bufferedEnd(): number {
		const b = this.sb?.buffered;
		return b && b.length ? b.end(b.length - 1) : 0;
	}

	/** Keep ~AHEAD_S of audio buffered: evict behind, fetch ahead, append the next chunk. */
	private async pump() {
		if (this.busy || this.closed || !this.sb) return;
		this.busy = true;
		try {
			const now = this.a.currentTime;
			// Plan the next track of the album once the last planned one is being appended.
			const last = this.segments[this.segments.length - 1];
			if (last && !this.ended && this.queue.length <= 1) {
				const nxt = this.nextAfter(last.track);
				if (nxt) this.enqueue(nxt);
				else if (!this.queue.length) {
					this.ended = true;
					if (this.ms.readyState === 'open') await this.withSb(async () => this.ms.endOfStream());
					return;
				}
			}
			// Download the track being appended, then (once it is in) the one after it.
			const [head, second] = this.queue;
			if (head) this.fetchBytes(head);
			if (head?.complete && second) this.fetchBytes(second);

			const p = this.queue[0];
			if (!p) return;
			if (p.failed) {
				this.fail(`could not load "${p.seg.track.title}"`);
				return;
			}
			if (p.next >= p.parts.length) return; // nothing new has arrived yet
			if (this.bufferedEnd() - now > AHEAD_S && p.placed) return; // enough ahead

			await this.withSb(async (sb) => {
				// Evict played audio so the ~12 MB quota never fills.
				if (sb.buffered.length && sb.buffered.start(0) < now - BEHIND_S) {
					sb.remove(0, now - BEHIND_S);
					await this.updateEnd();
				}
				// Declare the stream as long as everything planned so far. Without this its duration is
				// just what has been appended, and the element clamps a seek ahead back to that end.
				const plannedEnd = this.segments[this.segments.length - 1]?.end ?? 0;
				if (this.ms.readyState === 'open' && !(this.ms.duration >= plannedEnd)) {
					this.ms.duration = plannedEnd;
				}
				if (!p.placed) {
					// Place this track: cut the encoder delay and the end padding exactly.
					sb.appendWindowStart = 0;
					sb.appendWindowEnd = Infinity;
					sb.timestampOffset = p.seg.start - MP3_DELAY_S;
					sb.appendWindowEnd = p.seg.end;
					sb.appendWindowStart = p.seg.start;
					p.placed = true;
				}
				// Gather arrived parts up to CHUNK bytes into one append.
				let size = 0;
				let upTo = p.next;
				while (upTo < p.parts.length && (size === 0 || size + p.parts[upTo].length <= CHUNK)) {
					size += p.parts[upTo].length;
					upTo++;
				}
				const chunk = new Uint8Array(size);
				let at = 0;
				for (let i = p.next; i < upTo; i++) {
					chunk.set(p.parts[i], at);
					at += p.parts[i].length;
				}
				try {
					sb.appendBuffer(chunk);
					await this.updateEnd();
				} catch (e) {
					if ((e as Error)?.name === 'QuotaExceededError') return; // retry next tick, after eviction
					throw e;
				}
				for (let i = p.next; i < upTo; i++) p.parts[i] = EMPTY; // free memory
				p.next = upTo;
				if (p.complete && p.next >= p.parts.length) this.queue.shift();
			});
		} catch (e) {
			this.fail(`append: ${(e as Error)?.message ?? e}`);
		} finally {
			this.busy = false;
		}
		// Keep going right away while there is room ahead (fills the first buffer quickly).
		const head = this.queue[0];
		const waiting = !!head && head.next < head.parts.length; // arrived but not appended yet
		if (!this.closed && waiting && this.bufferedEnd() - this.a.currentTime < AHEAD_S) {
			setTimeout(() => void this.pump(), 0);
		} else if (!this.closed && head && !head.complete && this.bufferedEnd() - this.a.currentTime < AHEAD_S) {
			setTimeout(() => void this.pump(), 150); // more data is on its way
		}
	}

	private fail(why: string) {
		if (this.closed) return;
		logEvent(`gapless off for this album: ${why}`);
		this.destroy();
		this.onFail(why);
	}
}
