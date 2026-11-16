// Gapless playback for albums (DJ mixes split into tracks, live albums) on the ONE audio element.
//
// Why not two elements: the Tesla binds its media widget to the element that started playing, so
// swapping elements at a track boundary greys out its controls (see the history of player.svelte.ts).
// Instead the single element plays a MediaSource stream into which consecutive album tracks are
// appended back to back:
//  - FLAC albums play the ORIGINAL files: MediaSource takes no raw .flac, so each file is repackaged
//    into fragmented MP4 in the browser (flacmp4.ts — frames copied byte for byte, lossless). FLAC
//    has no encoder delay/padding and STREAMINFO holds the exact sample count, so every track is
//    placed at exactly start = previous end. A seek far into a track fetches from a byte offset
//    (HTTP Range) and re-syncs on a frame, instead of downloading from the start;
//  - other formats come as MP3 from Plex's transcoder. MP3 encoders add ~1105 samples of silence up
//    front and pad the end, so those tracks are placed with timestampOffset = start − delay and
//    clipped with appendWindow [start, start + duration] (verified: one contiguous buffered range
//    across the boundary);
//  - Chrome caps an audio SourceBuffer at ~12 MB, so tracks are appended in chunks just ahead of the
//    playhead and played audio is evicted behind it.
// The player keeps the timeline per track: it asks `segmentAt(currentTime)` and switches title/art
// when the playhead crosses into the next track — the element never changes.

import type { Metadata } from './types';
import { logEvent } from '$lib/stores/debug.svelte';
import { FlacToMp4, initSegment, parseFlacHeader, type StreamInfo } from './flacmp4';

export type GaplessKind = 'flac' | 'mp3';
const MIME: Record<GaplessKind, string> = { flac: 'audio/mp4; codecs="flac"', mp3: 'audio/mpeg' };

const MP3_DELAY_S = 1105 / 44100; // LAME/ffmpeg encoder delay + decoder delay at 44.1 kHz
const CHUNK = 512 * 1024; // bytes per appendBuffer
const AHEAD_S = 45; // keep this much audio buffered ahead of the playhead
const BEHIND_S = 15; // keep this much behind it (small seeks back stay instant)
const PUMP_MS = 1000;
// Plex's duration for a transcoded MP3 can be a little longer than the audio it sends, which leaves a
// sliver of nothing (measured: 0.1 s) between two tracks. The element stalls on such a gap forever,
// so the playhead is moved over it — never over more than this.
const MAX_GAP_S = 2;
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
	exact: boolean; // seg.end is final (FLAC: from STREAMINFO) — the next track may be placed after it
	seekTo: number; // FLAC: start this far into the track (seconds) via an HTTP Range request
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const m = new Uint8Array(a.length + b.length);
	m.set(a);
	m.set(b, a.length);
	return m;
}

// Plex runs ONE transcode per client at a time: a second start kills or refuses the first ("Failed
// to fetch"). So every track download — across streams — waits its turn in this chain.
let transcodeChain: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
	const run = transcodeChain.then(job, job);
	transcodeChain = run.catch(() => {});
	return run;
}

export function gaplessSupported(kind: GaplessKind): boolean {
	return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(MIME[kind]);
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
		private kind: GaplessKind,
		private urlFor: (t: Metadata) => string | null,
		/** Next track to chain after `prev`, or null when the album run ends. */
		private nextAfter: (prev: Metadata) => Metadata | null,
		private onFail: (why: string) => void
	) {
		this.url = URL.createObjectURL(this.ms);
		a.addEventListener('waiting', this.onWaiting);
	}
	private onWaiting = () => this.jumpGap();

	/** Stalled with the next buffered range just ahead (the element stops ~0.4 s before a range's
	 *  end when nothing follows it directly): jump to that range. */
	private jumpGap() {
		const b = this.sb?.buffered;
		if (this.closed || !b || this.a.seeking || this.a.readyState >= 3) return;
		const t = this.a.currentTime;
		for (let i = 0; i < b.length; i++) {
			const gap = b.start(i) - t;
			if (gap > 0 && gap <= MAX_GAP_S) {
				logEvent(`gapless: skipped a ${gap.toFixed(2)} s gap at ${t.toFixed(1)} s`);
				this.a.currentTime = b.start(i) + 0.01;
				return;
			}
		}
	}

	/** Attach to the element and start with `first`, playing from `offsetS` into it. */
	start(first: Metadata, offsetS = 0): void {
		this.ms.addEventListener(
			'sourceopen',
			() => {
				if (this.closed) return;
				try {
					this.sb = this.ms.addSourceBuffer(MIME[this.kind]);
				} catch (e) {
					this.fail(`addSourceBuffer: ${(e as Error)?.message ?? e}`);
					return;
				}
				this.enqueue(first, offsetS);
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
		this.a.removeEventListener('waiting', this.onWaiting);
		this.abort.abort();
		if (this.timer) clearInterval(this.timer);
		this.queue = [];
		URL.revokeObjectURL(this.url);
	}

	// --- internals ---

	private enqueue(track: Metadata, seekTo = 0) {
		const last = this.segments[this.segments.length - 1];
		const start = last ? last.end : 0;
		const seg = { track, start, end: start + (track.duration ?? 0) / 1000 };
		this.segments.push(seg);
		this.queue.push({
			seg,
			parts: [],
			next: 0,
			placed: false,
			complete: false,
			fetching: null,
			failed: false,
			exact: this.kind === 'mp3', // MP3: Plex's duration is what we clip to
			seekTo: this.kind === 'flac' ? seekTo : 0
		});
	}

	/** FLAC: the exact track length comes from STREAMINFO (Plex's duration is rounded to ms). */
	private setExact(p: Pending, info: StreamInfo) {
		if (info.totalSamples > 0) p.seg.end = p.seg.start + info.totalSamples / info.sampleRate;
		p.exact = true;
	}

	/** FLAC: read STREAMINFO and where the audio starts, with small Range requests. */
	private async readFlacHead(url: string): Promise<{ info: StreamInfo; audioStart: number }> {
		let buf: Uint8Array = new Uint8Array(0);
		let want = 16 * 1024;
		for (let k = 0; k < 8; k++) {
			const r = await fetch(url, {
				headers: { Range: `bytes=${buf.length}-${want - 1}` },
				signal: this.abort.signal,
				cache: 'no-store'
			});
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const chunk = new Uint8Array(await r.arrayBuffer());
			buf = r.status === 206 ? concat(buf, chunk) : chunk; // 200: the server sent the whole file
			const res = parseFlacHeader(buf);
			if (!res) throw new Error('not a FLAC file');
			if ('info' in res) return res;
			want = Math.max(res.need, buf.length) + 16 * 1024;
		}
		throw new Error('FLAC header too large');
	}

	/** FLAC: download the original file (from a byte offset when seeking) and repackage it as fMP4
	 *  segments as the bytes arrive. */
	private fetchFlac(p: Pending, url: string) {
		p.fetching = (async () => {
			for (let attempt = 0; attempt < 3 && !p.complete && !this.closed; attempt++) {
				try {
					let remux: FlacToMp4 | null = null;
					let from = 0;
					const size = p.seg.track.Media?.[0]?.Part?.[0]?.size ?? 0;
					if (p.seekTo > 2 && size > 0) {
						const { info, audioStart } = await this.readFlacHead(url);
						this.setExact(p, info);
						const frac = Math.max(0, (p.seekTo - 3) / (p.seg.end - p.seg.start));
						from = Math.min(size - 1, audioStart + Math.floor(frac * (size - audioStart)));
						remux = new FlacToMp4(info, true);
						p.parts.push(initSegment(info));
					}
					const r = await fetch(url, {
						headers: from ? { Range: `bytes=${from}-` } : {},
						signal: this.abort.signal,
						cache: 'no-store'
					});
					if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
					if (from && r.status !== 206) {
						// Range ignored: parse from the top of the file instead.
						remux = null;
						p.parts = [];
					}
					const reader = r.body.getReader();
					let head: Uint8Array = new Uint8Array(0);
					for (;;) {
						const { value, done } = await reader.read();
						if (value?.length) {
							if (remux) {
								const seg = remux.push(value);
								if (seg) p.parts.push(seg);
							} else {
								head = concat(head, value);
								const res = parseFlacHeader(head);
								if (res === null) throw new Error('not a FLAC file');
								if ('info' in res) {
									this.setExact(p, res.info);
									p.parts.push(initSegment(res.info));
									remux = new FlacToMp4(res.info);
									const seg = remux.push(head.subarray(res.audioStart));
									if (seg) p.parts.push(seg);
									head = new Uint8Array(0);
								}
							}
						}
						if (done) break;
					}
					if (!remux) throw new Error('no FLAC header');
					const last = remux.push(EMPTY, true);
					if (last) p.parts.push(last);
					p.complete = true;
				} catch (e) {
					if (this.closed) break;
					logEvent(`gapless FLAC "${p.seg.track.title}" failed: ${(e as Error)?.message ?? e}`);
					if (p.next > 0) break; // already appended: can't restart cleanly
					p.parts = [];
					await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
				}
			}
			if (!p.complete && !this.closed) p.failed = true;
			p.fetching = null;
		})();
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
		if (this.kind === 'flac') {
			this.fetchFlac(p, url);
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

	/** Wait until the SourceBuffer has finished whatever it is doing. */
	private async idle(sb: SourceBuffer) {
		while (sb.updating && !this.closed) await new Promise((r) => setTimeout(r, 20));
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
			if (!this.a.paused) this.jumpGap();
			const now = this.a.currentTime;
			// Plan the next track of the album once the last planned one is being appended.
			const last = this.segments[this.segments.length - 1];
			// (FLAC: only once the current track's exact length is known, so the next starts on its last sample.)
			if (last && !this.ended && this.queue.length <= 1 && (!this.queue[0] || this.queue[0].exact)) {
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
				// The buffer can be busy again by now (a duration change, a replan's remove running
				// alongside): timestampOffset and appendBuffer both throw while it is updating.
				await this.idle(sb);
				if (!p.placed) {
					// A track whose last bytes end mid-frame leaves the parser inside a media segment, where
					// timestampOffset can't change. abort() resets the parser (dropping that partial frame,
					// which is past the previous track's appendWindowEnd anyway) and the append window.
					if (this.ms.readyState === 'open') sb.abort();
					// Place this track: cut the encoder delay and the end padding exactly.
					sb.appendWindowStart = 0;
					sb.appendWindowEnd = Infinity;
					sb.timestampOffset = p.seg.start - (this.kind === 'mp3' ? MP3_DELAY_S : 0);
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
					await this.idle(sb);
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
