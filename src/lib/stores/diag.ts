// "Send log": uploads the diagnostics log to the Worker (/diag), where it can be read back with
// `wrangler kv key get` — no photos of the car's screen needed. Only behind the passphrase gate,
// and tagged with the Plex account (the Worker checks the token with plex.tv).

import { debug } from './debug.svelte';
import { session } from './session.svelte';
import { quality } from './quality.svelte';
import { ClientIdStore } from '$lib/plex/storage';

export async function sendDiag(): Promise<string> {
	const h: Record<string, string> = { 'content-type': 'application/json' };
	if (session.token) h['X-Plex-Token'] = session.token;
	const cid = ClientIdStore.get();
	if (cid) h['X-Plex-Client-Identifier'] = cid;
	const body = JSON.stringify({
		sent: new Date().toISOString(),
		ua: navigator.userAgent,
		screen: `${innerWidth}x${innerHeight} dpr ${devicePixelRatio}`,
		connection: session.active ? `${session.active.connType} ${session.active.baseUri}` : null,
		streamBase: session.streamBase ?? null,
		quality: quality.choice,
		events: debug.events.map((e) => `${new Date(e.t).toISOString()} ${e.msg}`),
		calls: debug.calls
	});
	const res = await fetch('/diag', { method: 'POST', headers: h, body, credentials: 'same-origin' });
	if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.trim());
	return (await res.json() as { id: string }).id;
}
