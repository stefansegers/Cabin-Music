// Pins — folders, genres, playlists and albums pinned to Home for one-tap access in the car.
// Synced through the Worker (/state/pins, Cloudflare KV) so a pin made on the Mac shows up in the
// car. Browser storage is the instant cache (Home renders pins before the network answers) and the
// fallback when sync is unavailable (dev server, or the passphrase gate is off).

import { readJSON, writeJSON } from '$lib/plex/storage';
import { STORAGE_PREFIX } from '$lib/plex/config';
import { logEvent } from '$lib/stores/debug.svelte';

const KEY = STORAGE_PREFIX + 'pins';
const SYNC_URL = '/state/pins';
const MAX_PINS = 40;

export type PinKind = 'folder' | 'genre' | 'mood' | 'playlist' | 'album';

export interface Pin {
	id: string; // `${kind}:${sectionId}:${key}` — stable, so pinning twice is a no-op
	kind: PinKind;
	key: string; // folder key / genre id / playlist or album ratingKey
	sectionId: string;
	title: string;
	subtitle?: string;
	thumb?: string; // Plex image path for the tile
	pinnedAt: number;
}

export const pins = $state({
	items: readJSON<Pin[]>(KEY, []),
	synced: false
});

let syncAvailable = import.meta.env.PROD;

export function pinId(kind: PinKind, sectionId: string, key: string): string {
	return `${kind}:${sectionId}:${key}`;
}

export function isPinned(id: string): boolean {
	return pins.items.some((p) => p.id === id);
}

function valid(list: unknown): list is Pin[] {
	return Array.isArray(list) && list.every((p) => p && typeof p.id === 'string' && typeof p.kind === 'string');
}

/** Pull the synced pins (call once after connecting). Browser cache stays on screen meanwhile. */
export async function loadPins(): Promise<void> {
	if (!syncAvailable) return;
	try {
		const res = await fetch(SYNC_URL, { cache: 'no-store', credentials: 'same-origin' });
		if (res.status === 404) {
			syncAvailable = false; // no KV / gate off → browser-only pins
			return;
		}
		if (!res.ok) return;
		const remote = await res.json();
		if (remote === null) {
			// Nothing synced yet: seed the server with this browser's pins.
			if (pins.items.length) void push();
		} else if (valid(remote)) {
			pins.items = remote;
			writeJSON(KEY, remote);
		}
		pins.synced = true;
	} catch (e) {
		logEvent(`pins sync failed: ${(e as Error)?.message ?? e}`);
	}
}

async function push(): Promise<void> {
	if (!syncAvailable) return;
	try {
		await fetch(SYNC_URL, {
			method: 'PUT',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(pins.items)
		});
	} catch (e) {
		logEvent(`pins save failed: ${(e as Error)?.message ?? e}`);
	}
}

function save() {
	writeJSON(KEY, pins.items);
	void push();
}

export function togglePin(pin: Omit<Pin, 'pinnedAt'>): void {
	if (isPinned(pin.id)) {
		pins.items = pins.items.filter((p) => p.id !== pin.id);
	} else {
		pins.items = [{ ...pin, pinnedAt: Date.now() }, ...pins.items].slice(0, MAX_PINS);
	}
	save();
}

export function unpin(id: string): void {
	pins.items = pins.items.filter((p) => p.id !== id);
	save();
}
