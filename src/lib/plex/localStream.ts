// Local-network streaming. In production the JSON API goes through the Cloudflare Worker, which can
// only reach the server's public (remote) address. At home that public address is often unreachable
// from inside the LAN (no NAT loopback on the router), so audio would fail. This finds a LAN
// connection the *browser* can reach and uses it for audio only; the remote URI stays as fallback.
//
// The probe is a `no-cors` fetch: the response is opaque (no CORS needed), but it resolves when the
// server is reachable and rejects on a network error — exactly the signal we need. In the car the
// LAN addresses simply time out and audio keeps using the remote connection.
//
// Because the car can leave home Wi-Fi mid-session, the choice is re-checked on network changes and
// once a minute, and dropped immediately when audio from the LAN address fails (dropLocalStream).

import { fetchResources } from './discovery';
import { session } from '$lib/stores/session.svelte';
import { logEvent } from '$lib/stores/debug.svelte';

const LOCAL_PROBE_TIMEOUT_MS = 2500;
const RECHECK_MS = 60_000;

let localUris: string[] | null = null; // LAN https URIs of the active server (from /resources)
let running = false;
let watching = false;

async function reachable(uri: string): Promise<boolean> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), LOCAL_PROBE_TIMEOUT_MS);
	try {
		await fetch(`${uri}/identity`, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
		return true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

async function loadLocalUris(token: string): Promise<string[]> {
	if (localUris) return localUris;
	const active = session.active;
	if (!active) return [];
	const devices = await fetchResources(token);
	const device = devices.find((d) => d.clientIdentifier === active.machineId);
	localUris = (device?.connections ?? [])
		.filter((c) => c.local && !c.relay && c.uri.startsWith('https://'))
		.map((c) => c.uri);
	return localUris;
}

async function check(token: string): Promise<void> {
	const active = session.active;
	if (running || !active) return;
	if (active.connType === 'local') {
		session.streamBase = null; // the active connection already is local
		return;
	}
	running = true;
	try {
		const uris = await loadLocalUris(token);
		const current = session.streamBase;
		// Cheap path: keep the current LAN address while it still answers.
		if (current && (await reachable(current))) return;
		for (const uri of uris) {
			if (uri !== current && (await reachable(uri))) {
				session.streamBase = uri;
				logEvent(`local audio stream: ${uri}`);
				return;
			}
		}
		if (current) logEvent('local audio stream: LAN address gone, using remote');
		session.streamBase = null;
	} catch {
		session.streamBase = null;
	} finally {
		running = false;
	}
}

/** Find a LAN address for audio now, and keep re-checking it (network changes + every minute). */
export async function findLocalStream(token: string): Promise<void> {
	localUris = null; // (re)connected — the server's address list may have changed
	await check(token);
	if (watching || typeof window === 'undefined') return;
	watching = true;
	const recheck = () => {
		const t = session.token;
		if (t) void check(t);
	};
	setInterval(recheck, RECHECK_MS);
	window.addEventListener('online', recheck);
	(navigator as Navigator & { connection?: EventTarget }).connection?.addEventListener?.(
		'change',
		recheck
	);
}

/** Called by the player when audio from the LAN address fails — stop preferring it right away. */
export function dropLocalStream(failedUrl: string): void {
	const base = session.streamBase;
	if (base && failedUrl.startsWith(base)) {
		session.streamBase = null;
		logEvent('local audio stream failed, using remote');
	}
}
