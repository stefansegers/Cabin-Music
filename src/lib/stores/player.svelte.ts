// Playback engine: one HTMLAudioElement for the music (plus an inaudible keep-alive element, see
// below) managed by a runes store. Albums/playlists become a client-side queue; "Mixes for you"
// radio (server play queue) is layered on in playback.ts (3b).

import type { Metadata } from '$lib/plex/types';
import { playbackCandidates, artUrl, transcodeUrl, streamUrl } from '$lib/plex/media';
import { flowPick, keyTags } from '$lib/plex/keytags.svelte';
import { GaplessStream, gaplessSupported, type GaplessKind } from '$lib/plex/gapless';
import { bitrateFor } from '$lib/stores/quality.svelte';
import { session } from '$lib/stores/session.svelte';
import { dropLocalStream } from '$lib/plex/localStream';
import { cachedTagGroups, groupForTag } from '$lib/plex/tags';
import { getTransition, type Transition } from '$lib/plex/transitions';
import { mixReleaseOf, withoutMixes } from '$lib/plex/mixes.svelte';
import {
	getArtistStationKey,
	resolveMixStationKey,
	stationUri,
	createPlayQueue,
	pagePlayQueue,
	reportTimeline
} from '$lib/plex/playback';
import { getSonicallySimilar, getMetadata, getGenreTracksShuffled, getAll, TYPE } from '$lib/plex/library';
import { readJSON, writeJSON } from '$lib/plex/storage';
import { STORAGE_PREFIX } from '$lib/plex/config';
import { logEvent } from '$lib/stores/debug.svelte';

const KEY = STORAGE_PREFIX + 'player';
const KEEP_KEY = STORAGE_PREFIX + 'keepalive';

/** What the keep-alive element plays: an inaudible tone (default), digital silence, or nothing. */
export type KeepAlive = 'tone' | 'silent' | 'off';
const KEEP_MODES: KeepAlive[] = ['tone', 'silent', 'off'];
function loadKeepAlive(): KeepAlive {
	const v = readJSON<KeepAlive>(KEEP_KEY, 'tone');
	return KEEP_MODES.includes(v) ? v : 'tone';
}
export const keepAlive = $state({ mode: loadKeepAlive() });

// Autoplay: when the queue runs out, keep going with sonically similar music (no silence).
const AUTOPLAY_KEY = STORAGE_PREFIX + 'autoplay';
export const autoplay = $state({ on: readJSON<boolean>(AUTOPLAY_KEY, true) !== false });
export function setAutoplay(on: boolean): void {
	autoplay.on = on;
	writeJSON(AUTOPLAY_KEY, on);
	if (on) maybeAutoExtend();
}

/** Long tracks (DJ mixes, live sets) resume where you left off; short songs always start at 0. */
const RESUME_MIN_MS = 10 * 60 * 1000;
// Gapless albums: consecutive tracks of one album (DJ mixes, live albums) play without a gap on the
// SAME audio element through a MediaSource stream (see gapless.ts). Settings can turn it off.
const GAPLESS_KEY = STORAGE_PREFIX + 'gapless';
export const gapless = $state({ on: readJSON<boolean>(GAPLESS_KEY, true) !== false });
export function setGapless(on: boolean): void {
	gapless.on = on;
	writeJSON(GAPLESS_KEY, on);
}
const GAPLESS_MIN_MS = 20_000;
const GAPLESS_MAX_MS = 20 * 60 * 1000;
let stream: GaplessStream | null = null;
let gaplessBlocked = ''; // album (parentRatingKey) where the stream failed — play it the normal way

// Smooth transitions: from Plex's loudness analysis, move on to the next song once the current one
// has faded to near-silence (easing the volume down to it) and skip silence at the next song's start.
// Only between different albums — an album's tracks are left to flow as the artist made them — and
// never on a gapless stream. Nothing overlaps: one element, so the car's controls stay bound to it.
const SMOOTH_KEY = STORAGE_PREFIX + 'smooth';
export const smooth = $state({ on: readJSON<boolean>(SMOOTH_KEY, true) !== false });
export function setSmooth(on: boolean): void {
	smooth.on = on;
	writeJSON(SMOOTH_KEY, on);
	if (!on && audio) audio.volume = 1;
}
const SMOOTH_MIN_MS = 30_000;
const SMOOTH_MAX_MS = 20 * 60 * 1000; // DJ mixes and live sets play to their real end
const FADE_TO_DB = -14; // the volume ease ends this much lower (the track itself is already quiet)
let plan: { key: string; tr: Transition } | null = null; // current track's transition points
let leadInFor: string | null = null; // the next song was reached by a smooth transition: skip its silence
let lastTickT = 0;
let plannedFor: string | null = null; // track whose points were last requested (restore, fallbacks)

function smoothEligible(t: Metadata | null | undefined): t is Metadata {
	const d = t?.duration ?? 0;
	return !!t?.ratingKey && d >= SMOOTH_MIN_MS && d <= SMOOTH_MAX_MS;
}
/** The track that follows the current one, when a smooth transition into it is allowed. */
function smoothNext(cur: Metadata): Metadata | null {
	if (player.repeat === 'one') return null;
	const nxt = player.queue[player.index + 1] ?? (player.repeat === 'all' ? player.queue[0] : undefined);
	if (!nxt || nxt === cur) return null;
	if (releaseOf(cur) && releaseOf(nxt) === releaseOf(cur)) return null; // same album / mix CD
	return nxt;
}
/** Fetch the transition points of the song that just loaded (and warm the cache for the next). */
function planSmooth(track: Metadata) {
	plan = null;
	lastTickT = 0;
	plannedFor = track.ratingKey;
	if (!smooth.on || !smoothEligible(track)) return;
	void getTransition(track.ratingKey).then((tr) => {
		if (tr && currentTrack()?.ratingKey === track.ratingKey && !stream) plan = { key: track.ratingKey, tr };
	});
	const nxt = smoothNext(track);
	if (smoothEligible(nxt)) void getTransition(nxt.ratingKey);
}
/** Per timeupdate (normal playback only): ease the volume over the fade-out, then move on. */
function smoothTick(a: HTMLAudioElement) {
	const t = a.currentTime;
	const prevT = lastTickT;
	lastTickT = t;
	const cur = currentTrack();
	// A track that started some other way (restored after a reload): fetch its points now.
	if (smooth.on && cur && plannedFor !== cur.ratingKey) planSmooth(cur);
	if (!smooth.on || !plan || !cur || plan.key !== cur.ratingKey || !plan.tr.cutBefore) {
		if (a.volume !== 1) a.volume = 1;
		return;
	}
	const nxt = smoothNext(cur);
	// Plex's duration, from the same analysis as the ramps (a VBR MP3 can report a wildly wrong one).
	const dur = cur.duration ? cur.duration / 1000 : Number.isFinite(a.duration) ? a.duration : 0;
	const cutAt = dur - plan.tr.cutBefore;
	const fadeAt = dur - plan.tr.fadeBefore;
	if (!nxt || !dur || t < fadeAt) {
		if (a.volume !== 1) a.volume = 1;
		return;
	}
	// Only a song that plays INTO its ending moves on early — not a seek that lands there.
	const playedInto = prevT > 0 && t - prevT < 1.5;
	if (t >= cutAt) {
		if (!playedInto || prevT >= cutAt) return;
		logEvent(`smooth → "${nxt.title}" (${plan.tr.cutBefore.toFixed(1)} s early)${vis()}`);
		plan = null;
		leadInFor = nxt.ratingKey;
		reportNow('paused'); // final position, so Plex counts the play (as on 'ended')
		next(true);
		return;
	}
	const span = Math.max(0.01, cutAt - fadeAt);
	const frac = Math.min(1, Math.max(0, (t - fadeAt) / span));
	a.volume = Math.pow(10, (FADE_TO_DB * frac) / 20);
}
/** A song reached by a smooth transition starts after its leading silence (original files only — a
 *  transcode can't seek before it has data). */
function applyLeadIn(a: HTMLAudioElement, track: Metadata) {
	const wanted = leadInFor === track.ratingKey;
	leadInFor = null;
	if (!wanted || !smooth.on || !smoothEligible(track) || candidates[candidateIdx]?.includes('/transcode/')) return;
	void getTransition(track.ratingKey).then((tr) => {
		const at = tr?.leadIn ?? 0;
		if (!at || currentTrack()?.ratingKey !== track.ratingKey) return;
		const jump = () => {
			if (currentTrack()?.ratingKey !== track.ratingKey || a.currentTime > at) return;
			if (a.currentSrc.includes('/transcode/')) return; // fell back to a transcode meanwhile
			a.currentTime = at;
			player.currentTime = at;
			syncMediaPosition();
		};
		if (a.readyState >= 1) jump();
		else a.addEventListener('loadedmetadata', jump, { once: true });
	});
}

/** FLAC files can stream as the original (repackaged losslessly); everything else via MP3. A capped
 *  quality setting means the user wants MP3 to save data, so that wins. */
function isFlac(t: Metadata): boolean {
	const m = t.Media?.[0];
	return (m?.container ?? m?.audioCodec ?? '').toLowerCase() === 'flac';
}
function gaplessKind(t: Metadata): GaplessKind {
	return isFlac(t) && bitrateFor() == null && gaplessSupported('flac') ? 'flac' : 'mp3';
}
let streamKind: GaplessKind = 'mp3';

/** What plays as one piece: the album, or the whole CD for a mix/live release (whose tracks Plex
 *  often files as one "album" per track artist). */
function releaseOf(t: Metadata | null | undefined): string {
	return mixReleaseOf(t)?.id ?? t?.parentRatingKey ?? '';
}
function gaplessPair(a: Metadata | null | undefined, b: Metadata | null | undefined): boolean {
	if (!a || !b || !releaseOf(a) || releaseOf(a) !== releaseOf(b)) return false;
	if (isFlac(a) !== isFlac(b)) return false; // one stream = one format
	return [a, b].every((t) => {
		const d = t.duration ?? 0;
		return d >= GAPLESS_MIN_MS && d <= GAPLESS_MAX_MS;
	});
}
/** Queue index of a track, searching from the current position (the queue can repeat tracks). */
function queueIndexOf(t: Metadata): number {
	const from = Math.max(0, player.index);
	for (let i = from; i < player.queue.length; i++) if (player.queue[i].ratingKey === t.ratingKey) return i;
	return player.queue.findIndex((x) => x.ratingKey === t.ratingKey);
}
/** The track to chain after `prev` in the stream, or null when the album run ends. */
function gaplessNext(prev: Metadata): Metadata | null {
	if (player.repeat === 'one') return null;
	const i = queueIndexOf(prev);
	const nxt = i >= 0 ? player.queue[i + 1] : undefined;
	return gaplessPair(prev, nxt) ? nxt! : null;
}
function gaplessUrl(t: Metadata): string | null {
	const base = session.streamBase ?? undefined;
	return streamKind === 'flac' ? streamUrl(t, base) : transcodeUrl(t, bitrateFor() ?? 320, base);
}
function stopStream() {
	stream?.destroy();
	stream = null;
}

/** Where a long track should start: its Plex resume point, unless (nearly) finished or barely begun. */
function resumePointMs(t: Metadata | null | undefined): number {
	const dur = t?.duration ?? 0;
	const off = t?.viewOffset ?? 0;
	if (dur < RESUME_MIN_MS || off < 30_000 || off > dur - 120_000) return 0;
	return off;
}

export type Repeat = 'off' | 'all' | 'one';
export interface RadioState {
	playQueueID: number;
	lastItemID: number | null;
	artistKey: string;
}

export const player = $state({
	queue: [] as Metadata[],
	index: -1,
	playing: false,
	currentTime: 0,
	duration: 0,
	repeat: 'off' as Repeat,
	shuffle: false,
	expanded: false, // full-screen Now Playing open
	radio: null as RadioState | null
});

export function currentTrack(): Metadata | null {
	return player.index >= 0 && player.index < player.queue.length ? player.queue[player.index] : null;
}

// --- module-level, non-reactive ---
let base: Metadata[] = []; // original (pre-shuffle) order
// A SINGLE <audio> element plays the music; each track is a src swap on it.
let audio: HTMLAudioElement | null = null;
// The keep-alive: a second, looping, inaudible element that plays for as long as the player is
// logically playing. Chromium drops a page's media session (and its audio output stream) the instant
// its only playing element ends, and only rebuilds it once the next src has data. The working theory
// (the browser half is verified, the car half is not yet confirmed on a car) is that the car reads that
// lapse as "browser audio ended": it resumes its own media source for the length of the gap and, with
// the browser off screen, never lets the next track start. A second player that never ends keeps the
// session alive across every track change.
let keep: HTMLAudioElement | null = null;
let keepWanted = false; // what WE last asked of the keep-alive; anything else it does came from outside
let loadAt = 0; // when the current src was assigned (logs the load gap; 0 once it is playing)
let restored = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let candidates: string[] = []; // ordered playback URLs for the current track (quality + fallbacks)
let candidateIdx = 0;
let lastTimelineAt = 0;

function rand(n: number): number {
	return Math.floor(Math.random() * n);
}
function shuffled<T>(arr: T[]): T[] {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = rand(i + 1);
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

function el(): HTMLAudioElement | null {
	if (typeof Audio === 'undefined') return null;
	if (audio) return audio;
	// Use an <audio> element. (A <video> element earns richer car transport controls, BUT the Tesla
	// then treats playback as VIDEO and greys out ALL controls while driving — worse for a music app —
	// so we stay with <audio>, accepting the car's limited web-audio controls.) Attached to the DOM for
	// best-effort OS/car media recognition.
	const a = new Audio();
	a.preload = 'auto';
	if (typeof document !== 'undefined') {
		a.setAttribute('aria-hidden', 'true');
		document.body.appendChild(a);
	}
	a.addEventListener('timeupdate', () => {
		if (stream) onStreamTime(a.currentTime);
		else {
			player.currentTime = a.currentTime;
			smoothTick(a);
		}
		persistSoon();
		maybeReportTimeline();
	});
	a.addEventListener('durationchange', () => {
		if (stream) return; // the stream spans several tracks; per-track duration comes from Plex
		// A non-finite duration (chunked transcode) keeps the Plex duration that load() published.
		if (Number.isFinite(a.duration) && a.duration > 0) player.duration = a.duration;
		syncMediaPosition();
	});
	a.addEventListener('play', () => {
		if (!player.playing && !loadAt) logEvent(`resumed${vis()}`);
		player.playing = true;
		reportNow('playing');
		syncMediaPlaybackState();
		syncMediaPosition();
	});
	a.addEventListener('playing', () => {
		// Sound is really coming out now. Starting the keep-alive only here means the audible track is
		// what takes the car's audio, and the keep-alive just holds on to it.
		keepOn();
		syncMediaPosition(); // the published position kept running while the track loaded
		if (loadAt) {
			logEvent(`playing "${currentTrack()?.title ?? '?'}" after ${Date.now() - loadAt}ms${vis()}`);
			loadAt = 0;
		}
	});
	a.addEventListener('pause', () => {
		// The browser fires 'pause' right before 'ended' when a track finishes on its own. That is a
		// track change, not a pause — publishing it would tell the car the music stopped.
		if (a.ended) return;
		onPause();
	});
	a.addEventListener('ended', () => {
		logEvent(`ended "${currentTrack()?.title ?? '?'}"${vis()}`);
		reportNow('paused'); // final position, so Plex counts the play (the 'pause' listener used to send it)
		next(true);
	});
	a.addEventListener('error', onError);
	audio = a;
	setupMediaSessionHandlers();
	registerUnloadFlush();
	return audio;
}

/** ' (hidden)' while the page is off screen — the case the diagnostics log most needs to show. */
function vis(): string {
	return typeof document !== 'undefined' && document.visibilityState === 'hidden' ? ' (hidden)' : '';
}

// --- keep-alive ---
// 10 s of stereo 16-bit PCM in a WAV Blob. What makes it count for the browser's media session: it
// has an audio track, lasts over 5 s (shorter clips are "transient" and drop the car's controls),
// loops, and plays unmuted at full volume. Stereo so it shares the music's output stream.
// The 'tone' is 20 Hz at about −60 dBFS: tens of dB below what anyone can hear at 20 Hz, but above the
// −72 dBFS level at which Chromium calls a tab "audible". That covers a car that judges "browser audio
// stopped" by sound level, not just by session or stream state. Leave the element's volume at 1 —
// the level lives in the samples. Tune KEEP_AMP if a car needs more; Settings can switch to pure
// silence or turn the keep-alive off.
const KEEP_HZ = 20; // whole cycles per second → the loop point is seamless
const KEEP_AMP = 33; // peak, in 16-bit steps: 33/32768 ≈ −60 dBFS
function keepWav(amp: number): string {
	const rate = 44100;
	const n = rate * 10; // frames
	const buf = new ArrayBuffer(44 + n * 4);
	const v = new DataView(buf);
	const tag = (at: number, s: string) => {
		for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i));
	};
	tag(0, 'RIFF');
	v.setUint32(4, 36 + n * 4, true);
	tag(8, 'WAVE');
	tag(12, 'fmt ');
	v.setUint32(16, 16, true); // fmt chunk size
	v.setUint16(20, 1, true); // PCM
	v.setUint16(22, 2, true); // channels
	v.setUint32(24, rate, true);
	v.setUint32(28, rate * 4, true); // bytes per second
	v.setUint16(32, 4, true); // bytes per frame
	v.setUint16(34, 16, true); // bits per sample
	tag(36, 'data');
	v.setUint32(40, n * 4, true);
	if (amp) {
		for (let i = 0; i < n; i++) {
			const s = Math.round(amp * Math.sin((2 * Math.PI * KEEP_HZ * i) / rate));
			v.setInt16(44 + i * 4, s, true);
			v.setInt16(46 + i * 4, s, true);
		}
	}
	return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

/** Create the keep-alive (once). Called from every play request, so the first call is inside a user
 *  gesture: load() there also lifts a per-element autoplay lock, should the car's browser use one. */
function armKeep() {
	if (keep || keepAlive.mode === 'off' || typeof Audio === 'undefined') return;
	const k = new Audio(keepWav(keepAlive.mode === 'tone' ? KEEP_AMP : 0));
	k.loop = true;
	// The browser or the car can pause/resume every player behind our back (the widget's stop button,
	// a system suspend and resume). Follow it, so the music and the keep-alive never disagree.
	// Events arrive a task late, so only act on one that still matches the element's state and that we
	// did not ask for ourselves.
	k.addEventListener('pause', () => {
		if (k !== keep || !keepWanted || !k.paused) return;
		logEvent(`keep-alive paused externally${vis()}`);
		pause();
	});
	k.addEventListener('play', () => {
		if (k !== keep || keepWanted || k.paused) return;
		logEvent(`keep-alive resumed externally${vis()}`);
		play();
	});
	k.addEventListener('error', () => logEvent('keep-alive failed to load'));
	k.load();
	keep = k;
	logEvent(`keep-alive ready: ${keepAlive.mode}`);
}
function keepOn() {
	keepWanted = true;
	if (keep?.paused)
		void keep.play().catch((e: unknown) => logEvent(`keep-alive blocked: ${(e as Error)?.name ?? e}${vis()}`));
}
function keepOff() {
	keepWanted = false;
	keep?.pause();
}
/** Retire the keep-alive element; armKeep() builds a new one on the next play request. Unloading it
 *  (not just pausing) takes its player out of the media session, which then lets go of the audio. */
function dropKeep() {
	const k = keep;
	keep = null; // its listeners now ignore it
	keepWanted = false;
	if (!k) return;
	const url = k.src;
	k.pause();
	k.removeAttribute('src');
	k.load();
	URL.revokeObjectURL(url);
}

/** Choose what the keep-alive plays (Settings). Takes effect immediately. */
export function setKeepAlive(mode: KeepAlive): void {
	keepAlive.mode = mode;
	writeJSON(KEEP_KEY, mode);
	if (mode === 'off') logEvent('keep-alive off');
	dropKeep();
	if (player.playing) {
		armKeep();
		keepOn();
	}
}

/** The player is now paused — by the user, the car's widget, or the browser. */
function onPause() {
	player.playing = false;
	keepOff();
	logEvent(`paused${vis()}`);
	reportNow('paused');
	syncMediaPlaybackState();
	syncMediaPosition();
}

/** Playback is over (end of queue, queue emptied, nothing playable): let go of the media session
 *  entirely, as a single element does when its last track ends. */
function halt() {
	player.playing = false;
	dropKeep();
	syncMediaPlaybackState();
}

function playBlocked(e: unknown) {
	const name = (e as Error)?.name ?? String(e);
	if (name === 'AbortError') return; // superseded by a newer load() or pause() — not a failure
	logEvent(`play blocked: ${name}${vis()}`);
	if (name === 'NotAllowedError') onPause(); // the browser refused: we are paused, not playing
}
/** The current audio element (single element; kept as a helper so callers read clearly). */
function active(): HTMLAudioElement | null {
	return audio;
}
/** No-op now — single-element playback has nothing to prefetch. Kept so queue-mutation callers and
 *  the quality-change hook stay simple. */
function reprime() {
	// The queue changed: re-plan what the gapless stream chains after the current track.
	const t = currentTrack();
	if (stream && t) stream.replanAfter(t);
}

/** Gapless stream time → the current track + position. Crossing into the next segment advances the
 *  queue without touching the element: only title, artwork and timeline change. */
function onStreamTime(abs: number) {
	const hit = stream?.segmentAt(abs);
	if (!hit) return;
	const i = queueIndexOf(hit.seg.track);
	if (i >= 0 && i !== player.index) {
		const prevTrack = currentTrack();
		if (prevTrack?.ratingKey) {
			// The previous track finished: final timeline report so Plex counts the play.
			const d = prevTrack.duration ?? 0;
			void reportTimeline(prevTrack.ratingKey, 'stopped', d, d);
		}
		player.index = i;
		logEvent(`gapless → "${hit.seg.track.title}"${vis()}`);
		setNowPlayingMetadata(hit.seg.track);
		persist();
		maybeAutoExtend();
	}
	player.currentTime = Math.max(0, abs - hit.seg.start);
	player.duration = hit.seg.end - hit.seg.start;
	if (i !== player.index) syncMediaPosition();
}

/** Start the current track as a gapless stream (when its album continues in the queue). */
function startStream(a: HTMLAudioElement, track: Metadata, offsetS: number): boolean {
	const kind = gaplessKind(track);
	if (!gapless.on || !gaplessSupported(kind)) return false;
	if (releaseOf(track) && releaseOf(track) === gaplessBlocked) return false;
	if (!gaplessNext(track) || !gaplessPair(track, track)) return false;
	streamKind = kind;
	const s = new GaplessStream(a, kind, gaplessUrl, gaplessNext, () => {
		// Stream failed (transcoder, CORS, quota): continue this album the normal way from here.
		if (stream !== s) return;
		const t = currentTrack();
		const at = player.currentTime;
		const wasPlaying = player.playing;
		stream = null;
		gaplessBlocked = releaseOf(t);
		if (t) load(t, wasPlaying, at);
	}, (t) => {
		const k = keyTags(t);
		// Exact MP3 length for every splice; the leading silence is cut only on mix CDs.
		return { dur: k?.dur ?? null, lead: mixReleaseOf(t) ? (k?.lead ?? 0) : 0 };
	});
	stream = s;
	candidates = [];
	candidateIdx = 0;
	s.start(track, offsetS);
	logEvent(`gapless stream (${kind === 'flac' ? 'original FLAC' : 'MP3'}): "${track.title}" + rest of the album`);
	return true;
}

function load(track: Metadata, autoplay: boolean, startAtS?: number) {
	const a = el();
	if (!a) return;
	stopStream();
	a.volume = 1;
	plan = null;
	const startAt = startAtS ?? resumePointMs(track) / 1000;
	if (startStream(a, track, startAt)) {
		leadInFor = null;
		loadAt = Date.now();
		player.currentTime = startAt;
		player.duration = (track.duration ?? 0) / 1000;
		setNowPlayingMetadata(track);
		syncMediaPosition();
		if (autoplay) play();
		return;
	}
	candidates = playbackCandidates(track);
	candidateIdx = 0;
	if (!candidates.length) {
		logEvent(`no playable url for "${track.title}"`);
		halt();
		return;
	}
	a.src = candidates[0];
	a.load();
	loadAt = Date.now();
	if (startAtS !== undefined) {
		// An explicit start (gapless fallback, far seek): jump there once the media is ready.
		if (startAtS > 0)
			a.addEventListener(
				'loadedmetadata',
				() => {
					a.currentTime = startAtS;
				},
				{ once: true }
			);
	} else {
		resumeLongTrack(a, track);
		applyLeadIn(a, track);
	}
	planSmooth(track);
	// Publish the new track's timeline now, from Plex's duration, before anything plays. The position
	// must never be unset while two elements are playing: Chromium ≤150 answers that by wiping the
	// title and artwork from the system's media controls.
	player.currentTime = startAt;
	player.duration = (track.duration ?? 0) / 1000;
	setNowPlayingMetadata(track);
	syncMediaPosition();
	if (autoplay) play();
}

/** Start a long track (mix/live set) at its resume point. The point in the list we played from may be
 *  stale (it was fetched before the last listen), so the fresh one is fetched and wins if the track
 *  has not really started yet. */
function resumeLongTrack(a: HTMLAudioElement, track: Metadata) {
	if ((track.duration ?? 0) < RESUME_MIN_MS) return;
	const seekOnce = (ms: number) => {
		if (!ms) return;
		const apply = () => {
			if (currentTrack() !== track || a.currentTime > 15) return; // moved on, or user already seeked
			a.currentTime = ms / 1000;
			player.currentTime = ms / 1000;
			syncMediaPosition();
		};
		if (a.readyState >= 1) apply();
		else a.addEventListener('loadedmetadata', apply, { once: true });
	};
	const listed = resumePointMs(track);
	seekOnce(listed);
	void getMetadata(track.ratingKey)
		.then((fresh) => {
			const ms = resumePointMs(fresh ? { ...track, viewOffset: fresh.viewOffset ?? 0 } : null);
			if (ms && Math.abs(ms - listed) > 10_000) {
				logEvent(`resume "${track.title}" at ${Math.round(ms / 60000)} min`);
				seekOnce(ms);
			}
		})
		.catch(() => {});
}

function onError() {
	const a = active();
	const track = currentTrack();
	if (!a || !track) return;
	if (stream) {
		// The MediaSource stream broke: replay this track the normal way from where we were.
		logEvent(`gapless stream error for "${track.title}" — normal playback`);
		const at = player.currentTime;
		gaplessBlocked = releaseOf(track);
		stopStream();
		load(track, player.playing, at);
		return;
	}
	// An error on a paused (or just-restored) track must not start the music or walk the queue.
	const go = player.playing;
	// A failed LAN URL means we left home (or the LAN path broke): stop preferring it for later tracks.
	dropLocalStream(candidates[candidateIdx] ?? '');
	// Walk the fallback chain (e.g. transcode after a failed direct play, or vice-versa).
	candidateIdx++;
	if (candidateIdx < candidates.length) {
		logEvent(`playback fallback ${candidateIdx} for "${track.title}"`);
		a.src = candidates[candidateIdx];
		a.load();
		if (go) play();
		return;
	}
	logEvent(`playback failed for "${track.title}"${go ? ' — skipping' : ''}`);
	if (!go) return; // play() retries it
	if (player.repeat === 'one') halt(); // repeating a track that cannot play: nothing else to try
	else next(true);
}

function goTo(i: number) {
	// Next within a gapless album whose start is already buffered: just move the playhead.
	const target = player.queue[i];
	const a = active();
	if (stream && a && target) {
		const seg = stream.segments.find((s) => s.track.ratingKey === target.ratingKey);
		if (seg && stream.buffered(seg.start + 0.05)) {
			a.currentTime = seg.start + 0.01;
			onStreamTime(a.currentTime);
			if (!player.playing) play();
			return;
		}
	}
	player.index = i;
	const t = currentTrack();
	if (t) load(t, true);
	persist();
	maybeAutoExtend();
}

// --- public actions ---

/** Play a list of tracks starting at startIndex. opts.radio marks a continuous (radio) queue;
 *  opts.feed makes it an endless station that tops itself up from that source (e.g. a decade). */
export function playList(
	tracks: Metadata[],
	startIndex = 0,
	opts: { radio?: RadioState; shuffle?: boolean; feed?: Feed } = {}
): void {
	if (!tracks.length) return;
	feed = opts.feed ?? null;
	if (typeof opts.shuffle === 'boolean') player.shuffle = opts.shuffle;
	base = tracks.slice();
	const start = Math.max(0, Math.min(startIndex, tracks.length - 1));
	player.radio = opts.radio ?? null;
	if (player.shuffle && !opts.radio) {
		const cur = tracks[start];
		player.queue = [cur, ...shuffled(tracks.filter((_, i) => i !== start))];
		player.index = 0;
	} else {
		player.queue = tracks.slice();
		player.index = start;
	}
	const t = currentTrack();
	if (t) load(t, true);
	persist();
	maybeAutoExtend();
}

/** Append more tracks to the queue (used by radio paging in 3b). */
export function appendToQueue(tracks: Metadata[]): void {
	if (!tracks.length) return;
	player.queue = [...player.queue, ...tracks];
	base = [...base, ...tracks];
	reprime();
}

/** Start or resume. Every play request goes through here. Safe to call when already playing. */
export function play(): void {
	const a = el();
	if (!a) return;
	const t = currentTrack();
	// A track that failed to load while paused (say, restored before the car was online): try again.
	if (a.error && t) return load(t, true);
	armKeep();
	void a.play().catch(playBlocked);
}

/** Pause. Safe to call when already paused. */
export function pause(): void {
	if (audio && !audio.paused) audio.pause(); // → its 'pause' listener → onPause()
}

export function toggle(): void {
	if (player.playing) pause();
	else play();
}

export function next(auto = false): void {
	if (!player.queue.length) return;
	if (auto && player.repeat === 'one') {
		seek(0);
		play();
		return;
	}
	// Radio: top up the queue before it drains.
	if (player.radio && player.index >= player.queue.length - 5) void extendRadio();
	let i = player.index + 1;
	if (i >= player.queue.length) {
		if (player.repeat === 'all') i = 0;
		else {
			// End of queue: keep the music going with similar tracks (autoplay), else stop.
			if ((autoplay.on || feed) && !player.radio) {
				void autoExtend().then((added) => {
					if (added && player.index + 1 < player.queue.length) goTo(player.index + 1);
					else if (auto) endOfQueue();
				});
				return;
			}
			if (!auto) return; // Next on the last track: nothing to skip to, keep playing
			endOfQueue();
			return;
		}
	}
	goTo(i);
}

function endOfQueue() {
	logEvent(`end of queue${vis()}`);
	halt();
	persist();
}

// --- autoplay ---
let autoExtending: Promise<boolean> | null = null;

/** An endless station's source: returns more tracks of the same kind (a decade, …). */
export type Feed = () => Promise<Metadata[]>;
let feed: Feed | null = null;

/** Top up the queue in the background when it is about to run out, so the next track is ready. */
function maybeAutoExtend() {
	if ((!autoplay.on && !feed) || player.radio || !player.queue.length) return;
	if (player.index >= player.queue.length - (feed ? 5 : 2)) void autoExtend();
}

/** Where a batch of "more like this" came from (shown when song radio starts). */
export type MoreSource = 'sonic' | 'artist' | 'genre' | 'random';

/** Tracks that go well after `seed`, best source first: Plex sonic analysis, then the artist's
 *  radio, then the album's (first) genre, then anything from the library. */
async function findMore(
	seed: Metadata,
	have: Set<string | undefined>,
	n = 15
): Promise<{ items: Metadata[]; source: MoreSource; label?: string } | null> {
	const similar = await getSonicallySimilar(seed.ratingKey, { limit: 40 }).catch(() => []);
	const fresh = withoutMixes(similar).filter(
		(t) => t.type === 'track' && !have.has(t.ratingKey) && !!t.Media?.[0]?.Part?.[0]?.key
	);
	// The closest matches first, lightly shuffled so the same seed doesn't give the same run.
	const pick = flowPick(seed, shuffled(fresh.slice(0, 25)), n);
	if (pick.length) return { items: pick, source: 'sonic' };
	const artistKey = seed.grandparentRatingKey;
	if (artistKey) try {
		const stationKey = await getArtistStationKey(artistKey);
		if (stationKey) {
			const q = await createPlayQueue(stationUri(stationKey), { continuous: true });
			const items = flowPick(seed, withoutMixes(q.items).filter((t) => !have.has(t.ratingKey)), n);
			if (items.length) return { items, source: 'artist', label: seed.grandparentTitle };
		}
	} catch {
		/* artist radio unavailable — try the genre next */
	}
	// No sonic data (analysis not run / not usable on this server): stay in the same genre. The
	// FIRST genre of the album counts — files often carry several, and the first is the real one.
	const [full, album] = await Promise.all([
		getMetadata(seed.ratingKey).catch(() => null),
		seed.parentRatingKey ? getMetadata(seed.parentRatingKey).catch(() => null) : null
	]);
	const sectionId = String(full?.librarySectionID ?? album?.librarySectionID ?? seed.librarySectionID ?? '');
	const genre = album?.Genre?.[0] ?? full?.Genre?.[0];
	if (sectionId && genre?.id != null) {
		// Use the cleaned-up group (all spellings of this genre) when it is known.
		const group = groupForTag(cachedTagGroups(sectionId, 'genre') ?? [], genre.tag);
		const ids = group ? group.ids.join(',') : String(genre.id);
		const tracks = await getGenreTracksShuffled(sectionId, ids, 60);
		const items = flowPick(seed, withoutMixes(tracks).filter((t) => !have.has(t.ratingKey)), n);
		if (items.length) return { items, source: 'genre', label: group?.name ?? genre.tag };
	}
	if (sectionId) {
		const res = await getAll(sectionId, { type: TYPE.track, sort: 'random', size: 40 });
		const items = flowPick(seed, withoutMixes(res.items).filter((t) => !have.has(t.ratingKey)), n);
		if (items.length) return { items, source: 'random' };
	}
	return null;
}

/** Append tracks that go well after the end of the queue (see findMore). A station (feed) keeps to
 *  its own source instead. Resolves true when something was added. */
function autoExtend(): Promise<boolean> {
	if (autoExtending) return autoExtending;
	autoExtending = (async () => {
		const seed = player.queue[player.queue.length - 1];
		if (!seed?.ratingKey) return false;
		const have = new Set(player.queue.map((t) => t.ratingKey));
		try {
			// A station keeps to its own source (no drifting off to similar-sounding music).
			if (feed) {
				const items = (await feed()).filter((t) => !have.has(t.ratingKey));
				if (items.length) {
					logEvent(`station: +${items.length}`);
					appendToQueue(items);
					return true;
				}
				return false;
			}
			const more = await findMore(seed, have);
			if (more) {
				logEvent(`autoplay: +${more.items.length} (${more.source}${more.label ? ` "${more.label}"` : ''}) after "${seed.title}"`);
				appendToQueue(more.items);
				return true;
			}
			logEvent(`autoplay: nothing found after "${seed.title}"`);
			return false;
		} catch (e) {
			logEvent(`autoplay failed: ${(e as Error)?.message ?? e}`);
			return false;
		}
	})().finally(() => {
		autoExtending = null;
	});
	return autoExtending;
}

export function prev(): void {
	if (!player.queue.length) return;
	if (player.currentTime > 3) {
		seek(0);
		return;
	}
	let i = player.index - 1;
	if (i < 0) i = player.repeat === 'all' ? player.queue.length - 1 : 0;
	goTo(i);
}

export function seek(t: number): void {
	const a = el();
	if (a && stream) {
		const cur = currentTrack();
		const seg = cur && stream.segments.find((s) => s.track.ratingKey === cur.ratingKey);
		if (seg && stream.buffered(seg.start + t)) {
			a.currentTime = seg.start + t;
			player.currentTime = t;
		} else if (cur) {
			load(cur, player.playing, t); // not buffered (evicted or far ahead): restart the stream there
		}
		reportNow(player.playing ? 'playing' : 'paused');
		syncMediaPosition();
		return;
	}
	if (a) {
		a.currentTime = t;
		player.currentTime = t;
		reportNow(player.playing ? 'playing' : 'paused');
		syncMediaPosition();
	}
}

export function cycleRepeat(): void {
	player.repeat = player.repeat === 'off' ? 'all' : player.repeat === 'all' ? 'one' : 'off';
	persist();
}

export function toggleShuffle(): void {
	const cur = currentTrack();
	player.shuffle = !player.shuffle;
	if (player.shuffle) {
		const rest = shuffled(base.filter((t) => t.ratingKey !== cur?.ratingKey));
		player.queue = cur ? [cur, ...rest] : rest;
		player.index = cur ? 0 : -1;
	} else {
		player.queue = base.slice();
		// By ratingKey: `cur` is a state proxy, `base` holds the raw objects, so indexOf misses.
		player.index = cur ? base.findIndex((t) => t.ratingKey === cur.ratingKey) : -1;
	}
	reprime();
	persist();
}

export function toggleExpanded(): void {
	player.expanded = !player.expanded;
}

/** Drop the preloaded next track (e.g. after a quality change) so it re-primes at the new setting. */
export function invalidatePrefetch(): void {
	reprime();
}

// --- queue management (view / reorder / play-next / remove) ---

/** Jump to a specific queue index and play it. */
export function jumpTo(i: number): void {
	if (i < 0 || i >= player.queue.length) return;
	goTo(i);
}

/** Insert a track to play right after the current one. */
export function enqueueNext(track: Metadata): void {
	if (player.index < 0 || !player.queue.length) {
		playList([track], 0);
		return;
	}
	const q = player.queue.slice();
	q.splice(player.index + 1, 0, track);
	player.queue = q;
	base = q.slice();
	reprime();
	persist();
}

/** Add a track to the end of the queue. */
export function enqueueLast(track: Metadata): void {
	if (player.index < 0 || !player.queue.length) {
		playList([track], 0);
		return;
	}
	player.queue = [...player.queue, track];
	base = player.queue.slice();
	reprime();
	persist();
}

/** Remove the queue item at i, adjusting the current index / playback as needed. */
export function removeAt(i: number): void {
	if (i < 0 || i >= player.queue.length) return;
	const wasPlaying = player.playing;
	const q = player.queue.slice();
	q.splice(i, 1);
	if (q.length === 0) {
		player.queue = [];
		base = [];
		player.index = -1;
		const a = active();
		stopStream();
		if (a) {
			a.pause();
			a.removeAttribute('src');
			a.load();
		}
		halt();
		player.currentTime = 0;
		player.duration = 0;
		persist();
		return;
	}
	player.queue = q;
	base = q.slice();
	if (i < player.index) {
		player.index -= 1;
		reprime();
	} else if (i === player.index) {
		// Removed the now-playing track → play whatever shifts into its slot.
		player.index = Math.min(player.index, q.length - 1);
		const t = currentTrack();
		if (t) load(t, wasPlaying);
	} else {
		reprime();
	}
	persist();
}

/** Reorder the queue (▲▼), keeping the currently-playing track selected. */
export function moveQueueItem(from: number, to: number): void {
	const n = player.queue.length;
	if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
	const q = player.queue.slice();
	const [item] = q.splice(from, 1);
	q.splice(to, 0, item);
	player.queue = q;
	base = q.slice();
	if (from === player.index) player.index = to;
	else if (from < player.index && to >= player.index) player.index -= 1;
	else if (from > player.index && to <= player.index) player.index += 1;
	reprime();
	persist();
}

// --- Media Session (best-effort) ---
// Drives the car's native now-playing widget (title/art) AND its transport buttons. Each handler is
// registered independently so one unsupported action can't drop the rest. Every action that arrives
// is logged: the diagnostics panel then shows what the car's buttons actually send, if anything.
function setupMediaSessionHandlers() {
	if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
	const ms = navigator.mediaSession;
	const set = (action: MediaSessionAction, handler: (d: MediaSessionActionDetails) => void) => {
		try {
			ms.setActionHandler(action, (d) => {
				lastActionAt = Date.now();
				logEvent(`media action: ${action}${vis()}`);
				handler(d);
			});
		} catch {
			/* this action is unsupported on this platform — skip just this one */
		}
	};
	// play/pause are explicit, never toggle(): a repeated or stale action must not flip the state.
	set('play', play);
	set('pause', pause);
	set('stop', pause); // the browser offers stop whether or not we handle it; treat it as pause
	set('previoustrack', prev);
	set('nexttrack', () => next());
	set('seekto', (d) => {
		if (typeof d.seekTime === 'number') seek(d.seekTime);
	});
}

// Hardware media keys, in case the car hands its steering-wheel / widget buttons to the page as key
// presses instead of media-session actions (a browser that handles them itself never sends these).
let lastActionAt = 0; // when the last media-session action arrived
const MEDIA_KEYS: Record<string, () => void> = {
	MediaTrackNext: () => next(),
	MediaTrackPrevious: prev,
	MediaPlayPause: toggle,
	MediaPlay: play,
	MediaPause: pause,
	MediaStop: pause
};

/** Publish play/pause state so the widget shows + enables the right controls. */
function syncMediaPlaybackState() {
	if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
	try {
		navigator.mediaSession.playbackState = player.playing ? 'playing' : 'paused';
	} catch {
		/* ignore */
	}
}

/** Publish duration + position so the widget shows a scrubber (and treats us as a rich session). */
function syncMediaPosition() {
	if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
	const ms = navigator.mediaSession;
	if (typeof ms.setPositionState !== 'function') return;
	try {
		const dur = player.duration;
		// Unknown duration → leave the last state in place. Never clear it (see load()).
		if (dur > 0 && Number.isFinite(dur)) {
			ms.setPositionState({ duration: dur, position: Math.min(player.currentTime, dur), playbackRate: 1 });
		}
	} catch {
		/* out-of-range/unsupported — ignore */
	}
}

function setNowPlayingMetadata(track: Metadata) {
	const artist = track.grandparentTitle ?? '';
	const album = track.parentTitle ?? '';
	// Some car browsers (incl. Tesla) surface document.title in the native now-playing widget,
	// falling back to the hostname when it's blank — so put the track + artist there too.
	if (typeof document !== 'undefined') {
		document.title = artist ? `${track.title} — ${artist}` : track.title || 'Cabin Music';
	}
	if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined')
		return;
	let art = artUrl(track.parentThumb ?? track.thumb ?? track.grandparentThumb, 300);
	// MediaSession needs an absolute URL; artUrl is a same-origin /img path in production.
	if (art && art.startsWith('/') && typeof location !== 'undefined') art = location.origin + art;
	navigator.mediaSession.metadata = new MediaMetadata({
		// The Tesla widget shows the source URL on line 2 (ignoring `artist`), so fold the artist into
		// the title to surface it. `artist`/`album` stay set for platforms that show them properly.
		title: artist ? `${track.title} · ${artist}` : track.title,
		artist,
		album,
		artwork: art ? [{ src: art, sizes: '300x300', type: 'image/jpeg' }] : []
	});
	syncMediaPlaybackState();
}

// --- timeline reporting (keeps Plex "recently played" + resume points / viewOffset current) ---
function reportNow(state: 'playing' | 'paused' | 'stopped') {
	const t = currentTrack();
	if (!t?.ratingKey) return;
	lastTimelineAt = Date.now();
	void reportTimeline(t.ratingKey, state, player.currentTime * 1000, (player.duration || 0) * 1000);
}
function maybeReportTimeline() {
	if (!player.playing) return;
	if (Date.now() - lastTimelineAt < 10000) return;
	reportNow('playing');
}

// Flush position + a final timeline report when the tab is hidden/closed, so reopening (here or in
// another Plex client) resumes where you left off.
let unloadBound = false;
function registerUnloadFlush() {
	if (unloadBound || typeof window === 'undefined') return;
	unloadBound = true;
	const flush = () => {
		persist();
		reportNow('paused');
	};
	window.addEventListener('pagehide', flush);
	document.addEventListener('visibilitychange', () => {
		logEvent(`page ${document.visibilityState}`);
		if (document.visibilityState === 'hidden') flush();
	});
	// If the car freezes the page while it is off screen, these two bracket the gap in the log.
	document.addEventListener('freeze', () => logEvent('page frozen'));
	document.addEventListener('resume', () => logEvent('page resumed'));
	window.addEventListener('keydown', (e) => {
		const act = MEDIA_KEYS[e.key];
		if (!act || e.repeat) return;
		// A browser that also turns the press into a media-session action must not act twice: wait a
		// beat, then skip the key if an action has just been handled.
		setTimeout(() => {
			const dup = Date.now() - lastActionAt < 400;
			logEvent(`media key: ${e.key}${dup ? ' (already handled)' : ''}${vis()}`);
			if (!dup) act();
		}, 60);
	});
}

// --- persistence ---
function persist() {
	writeJSON(KEY, {
		queue: player.queue,
		index: player.index,
		time: player.currentTime,
		repeat: player.repeat,
		shuffle: player.shuffle
	});
}
function persistSoon() {
	if (persistTimer) return;
	persistTimer = setTimeout(() => {
		persistTimer = null;
		persist();
	}, 4000);
}

/** Restore the last queue on boot — PAUSED (autoplay needs a gesture). Call once after connect. */
export function restore(): void {
	if (restored) return;
	restored = true;
	const saved = readJSON<{
		queue: Metadata[];
		index: number;
		time: number;
		repeat: Repeat;
		shuffle: boolean;
	} | null>(KEY, null);
	if (!saved || !Array.isArray(saved.queue) || saved.queue.length === 0) return;
	player.queue = saved.queue;
	base = saved.queue.slice();
	player.index = saved.index ?? 0;
	player.repeat = saved.repeat ?? 'off';
	player.shuffle = !!saved.shuffle;
	const t = currentTrack();
	// Resume where you left off — prefer the server-side viewOffset if it's further along.
	const resumeAt = Math.max(saved.time ?? 0, (t?.viewOffset ?? 0) / 1000);
	player.currentTime = resumeAt;
	player.duration = (t?.duration ?? 0) / 1000;
	const a = el();
	if (t && a) {
		stopStream();
		candidates = playbackCandidates(t);
		candidateIdx = 0;
		if (candidates.length) {
			a.src = candidates[0];
			const onMeta = () => {
				a.currentTime = resumeAt;
				a.removeEventListener('loadedmetadata', onMeta);
			};
			a.addEventListener('loadedmetadata', onMeta);
			setNowPlayingMetadata(t);
			syncMediaPosition();
		}
	}
}

// --- "Mixes for you" → endless artist radio (server-side continuous play queue) ---
let extending = false;

export async function playMixItem(item: Metadata): Promise<void> {
	try {
		logEvent(`mix tap: ${item.type} "${item.title}" key=${item.key ?? item.ratingKey ?? '?'}`);
		const stationKey = await resolveMixStationKey(item);
		if (!stationKey) {
			logEvent('mix: could not resolve a station key');
			return;
		}
		const q = await createPlayQueue(stationUri(stationKey), { continuous: true });
		if (!q.items.length) {
			logEvent('mix: empty radio queue');
			return;
		}
		playList(q.items, 0, {
			radio: { playQueueID: q.playQueueID, lastItemID: q.lastItemID, artistKey: '' }
		});
	} catch (e) {
		logEvent(`mix failed: ${(e as Error)?.message ?? e}`);
	}
}

async function extendRadio(): Promise<void> {
	const r = player.radio;
	if (!r || extending || r.lastItemID == null) return;
	extending = true;
	try {
		const q = await pagePlayQueue(r.playQueueID, r.lastItemID);
		const have = new Set(player.queue.map((t) => t.playQueueItemID));
		const fresh = q.items.filter((t) => t.playQueueItemID == null || !have.has(t.playQueueItemID));
		if (fresh.length) {
			appendToQueue(withoutMixes(fresh));
			const lastId = q.items[q.items.length - 1]?.playQueueItemID ?? r.lastItemID;
			player.radio = { ...r, lastItemID: lastId };
		}
	} catch (e) {
		logEvent(`radio paging failed: ${(e as Error)?.message ?? e}`);
	} finally {
		extending = false;
	}
}

/** "Artist Mix" — endless radio seeded from an artist's station. */
export async function playArtistRadio(artistKey: string): Promise<void> {
	try {
		const stationKey = await getArtistStationKey(artistKey);
		if (!stationKey) {
			logEvent(`no radio station for artist ${artistKey} → shuffling the artist instead`);
			await shuffleArtist(artistKey);
			return;
		}
		const q = await createPlayQueue(stationUri(stationKey), { continuous: true });
		if (!q.items.length) {
			// Radio needs Plex sonic analysis; without it the station is empty. Shuffle the artist's
			// catalogue instead (autoplay carries on after it), so a tap always plays something.
			logEvent('artist radio: empty queue → shuffling the artist instead');
			await shuffleArtist(artistKey);
			return;
		}
		const items = withoutMixes(q.items);
		playList(items.length ? items : q.items, 0, {
			radio: { playQueueID: q.playQueueID, lastItemID: q.lastItemID, artistKey }
		});
	} catch (e) {
		logEvent(`artist radio failed: ${(e as Error)?.message ?? e}`);
	}
}

/** "Song radio" — endless radio from a song. The song keeps playing (when it is the current one);
 *  what comes after is replaced with music like it: sonically similar when Plex has sonic analysis,
 *  else the artist's radio, the album's genre, or the library (see findMore). Every top-up seeds from
 *  the last track, so the station keeps going. Resolves with where the music came from, or null. */
export async function playTrackRadio(
	seed: Metadata | null | undefined
): Promise<{ source: MoreSource; label?: string } | null> {
	if (!seed?.ratingKey) return null;
	try {
		const more = await findMore(seed, new Set([seed.ratingKey]), 25);
		logEvent(`song radio: ${more ? `${more.items.length} (${more.source})` : 'nothing'} for "${seed.title}"`);
		if (!more) return null;
		const stationFeed: Feed = async () => {
			const last = player.queue[player.queue.length - 1] ?? seed;
			const r = await findMore(last, new Set(player.queue.map((t) => t.ratingKey)));
			return r?.items ?? [];
		};
		const cur = currentTrack();
		if (cur?.ratingKey === seed.ratingKey) {
			// Keep the song going; drop what was queued after it.
			feed = stationFeed;
			player.radio = null;
			player.shuffle = false;
			player.queue = [cur, ...more.items];
			player.index = 0;
			base = player.queue.slice();
			reprime();
			persist();
		} else {
			playList([seed, ...more.items], 0, { shuffle: false, feed: stationFeed });
		}
		return { source: more.source, label: more.label };
	} catch (e) {
		logEvent(`song radio failed: ${(e as Error)?.message ?? e}`);
		return null;
	}
}

/** Shuffle an artist's whole catalog (server-built shuffled play queue). */
export async function shuffleArtist(artistKey: string): Promise<void> {
	try {
		const q = await createPlayQueue(stationUri(`/library/metadata/${artistKey}`), { shuffle: true });
		if (!q.items.length) {
			logEvent('artist shuffle: empty queue');
			return;
		}
		const items = withoutMixes(q.items);
		playList(items.length ? items : q.items, 0, { shuffle: true });
	} catch (e) {
		logEvent(`artist shuffle failed: ${(e as Error)?.message ?? e}`);
	}
}
