// Pins — folders, genres, playlists and albums pinned to Home for one-tap access in the car.
// PER PLEX ACCOUNT: synced through the Worker (/state/pins, Cloudflare KV, keyed by the account
// behind the Plex token) so a pin made on the Mac shows up in the car — but only for the person who
// made it. Browser storage (also keyed by account) is the instant cache (Home renders pins before
// the network answers) and the fallback when sync is unavailable (dev server, or gate off).

import { readJSON, writeJSON, remove, AccountStore, ClientIdStore } from '$lib/plex/storage';
import { STORAGE_PREFIX } from '$lib/plex/config';
import { session } from '$lib/stores/session.svelte';
import { logEvent } from '$lib/stores/debug.svelte';

// Pre-per-account cache: shared by whoever used this browser, so it can't be trusted to be ours.
remove(STORAGE_PREFIX + 'pins');

function accountId(): string | null {
	const id = session.account?.id ?? AccountStore.get()?.id;
	return id == null ? null : String(id);
}

function cacheKey(): string | null {
	const id = accountId();
	return id ? `${STORAGE_PREFIX}pins.${id}` : null;
}

function readCache(): Pin[] {
	const key = cacheKey();
	return key ? readJSON<Pin[]>(key, []) : [];
}

function writeCache(list: Pin[]): void {
	const key = cacheKey();
	if (key) writeJSON(key, list);
}

function syncHeaders(): Record<string, string> {
	const h: Record<string, string> = {};
	if (session.token) h['X-Plex-Token'] = session.token;
	const cid = ClientIdStore.get();
	if (cid) h['X-Plex-Client-Identifier'] = cid;
	return h;
}
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
	items: readCache(),
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
	pins.items = readCache(); // the (possibly different) signed-in account's own cache
	pins.synced = false;
	if (!syncAvailable || !session.token) return;
	try {
		const res = await fetch(SYNC_URL, {
			cache: 'no-store',
			credentials: 'same-origin',
			headers: syncHeaders()
		});
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
			writeCache(remote);
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
			headers: { 'content-type': 'application/json', ...syncHeaders() },
			body: JSON.stringify(pins.items)
		});
	} catch (e) {
		logEvent(`pins save failed: ${(e as Error)?.message ?? e}`);
	}
}

function save() {
	writeCache(pins.items);
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
