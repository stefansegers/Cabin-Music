// Debug store — the only diagnostic channel in the car (no DevTools). A ring buffer of the
// last N network calls + a breadcrumb of events. Mutated by client.ts (logCall) from plain TS.
//
// The log is kept in localStorage too: the car can throw the page away while the browser is off
// screen (it comes back blank and reloads), and the log of what happened before that is the part
// that matters. Each page load adds a marker saying how it started (reload, discarded tab, …).

import { MAX_LOG, STORAGE_PREFIX } from '$lib/plex/config';

export interface NetLog {
	id: number;
	t: number;
	method: string;
	url: string; // token already masked by client.ts
	status: number | null;
	ms: number | null;
	ok: boolean;
	error?: string;
}

export interface DebugEvent {
	t: number;
	msg: string;
}

const LOG_KEY = STORAGE_PREFIX + 'diag';
const MAX_EVENTS = 600; // a drive's worth of track changes, across reloads
const SAVE_MS = 1500;

let seq = 0;

function loadSaved(): { calls: NetLog[]; events: DebugEvent[] } {
	try {
		const v = JSON.parse(localStorage.getItem(LOG_KEY) ?? 'null');
		if (v && Array.isArray(v.events) && Array.isArray(v.calls)) return v;
	} catch {
		/* no storage, or garbage: start empty */
	}
	return { calls: [], events: [] };
}

const saved = typeof localStorage !== 'undefined' ? loadSaved() : { calls: [], events: [] };
seq = saved.calls.reduce((m, c) => Math.max(m, c.id), 0);

// Module-level runes state: import `debug` anywhere and mutate its properties (never reassign).
export const debug = $state({
	visible: false,
	calls: saved.calls as NetLog[], // newest-first
	events: saved.events as DebugEvent[] // newest-first
});

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveNow(): void {
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = null;
	try {
		localStorage.setItem(LOG_KEY, JSON.stringify({ calls: debug.calls, events: debug.events }));
	} catch {
		/* quota / no storage: the in-memory log still works */
	}
}
function saveSoon(): void {
	if (!saveTimer) saveTimer = setTimeout(saveNow, SAVE_MS);
}

export function logCall(entry: Omit<NetLog, 'id'>): void {
	debug.calls.unshift({ id: ++seq, ...entry });
	if (debug.calls.length > MAX_LOG) debug.calls.length = MAX_LOG;
	saveSoon();
}

export function logEvent(msg: string): void {
	debug.events.unshift({ t: Date.now(), msg });
	if (debug.events.length > MAX_EVENTS) debug.events.length = MAX_EVENTS;
	saveSoon();
}

export function toggleDebug(): void {
	debug.visible = !debug.visible;
}

export function clearDebug(): void {
	debug.calls.length = 0;
	debug.events.length = 0;
	saveNow();
}

// Page-load marker + save before the page can go away.
if (typeof window !== 'undefined') {
	const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
	const discarded = (document as Document & { wasDiscarded?: boolean }).wasDiscarded;
	const last = debug.events[0]?.t;
	const gap = last ? ` · ${Math.round((Date.now() - last) / 1000)} s after the last event` : '';
	logEvent(`── page loaded (${nav?.type ?? '?'}${discarded ? ', tab was DISCARDED' : ''})${gap}`);
	window.addEventListener('pagehide', saveNow);
	document.addEventListener('visibilitychange', () => {
		// Other listeners log "page hidden" right after this one: save again once they have.
		if (document.visibilityState === 'hidden') saveNow(), setTimeout(saveNow, 50);
	});
	document.addEventListener('freeze', saveNow);
}
