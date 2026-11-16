<script lang="ts">
	// Top of Home: "Pinned" (one-tap folders/genres/playlists/albums) and "Continue listening"
	// (long tracks stopped part-way, across ALL music libraries — mixes usually live in their own).
	import { goto } from '$app/navigation';
	import { pins, type Pin } from '$lib/stores/pins.svelte';
	import { library, setActive } from '$lib/stores/library.svelte';
	import { playList } from '$lib/stores/player.svelte';
	import {
		getFolder,
		getGenreTracksShuffled,
		getPlaylistItems,
		getChildren,
		getInProgress
	} from '$lib/plex/library';
	import { logEvent } from '$lib/stores/debug.svelte';
	import ShelfTile from './ShelfTile.svelte';
	import DailyMixCard from './DailyMixCard.svelte';
	import DecadeCard from './DecadeCard.svelte';
	import {
		buildDecades,
		cachedDecades,
		decadeTracks,
		decadeOpts,
		type Decade
	} from '$lib/plex/decades.svelte';
	import { activeSection } from '$lib/stores/library.svelte';
	import { session } from '$lib/stores/session.svelte';
	import { buildDailyMixes, cachedDailyMixes, dailyMixTracks, type DailyMix } from '$lib/plex/dailyMixes';
	import type { Metadata } from '$lib/plex/types';
	import {
		loadMixReleases,
		mixReleases,
		mixReleaseTracks,
		withoutMixes,
		type MixRelease
	} from '$lib/plex/mixes.svelte';

	const TILE = 168;

	// --- Pinned ---
	function hrefOf(p: Pin): string {
		switch (p.kind) {
			case 'folder':
				return `/folders?${new URLSearchParams({ k: p.key, n: p.title })}`;
			case 'genre':
				return `/genres/${encodeURIComponent(p.key)}?n=${encodeURIComponent(p.title)}`;
			case 'mood':
				return `/genres/${encodeURIComponent(p.key)}?n=${encodeURIComponent(p.title)}&kind=mood`;
			case 'playlist':
				return `/playlist/${p.key}`;
			case 'album':
				return `/album/${p.key}`;
		}
	}

	const ICON: Record<Pin['kind'], string> = {
		folder: 'folder',
		genre: 'genre',
		mood: 'genre',
		playlist: 'playlist',
		album: 'album'
	};

	function openPin(p: Pin) {
		// Folder and genre pages browse the active library — switch to the pin's library first.
		if (p.sectionId && p.sectionId !== library.activeId && library.sections.some((s) => s.key === p.sectionId)) {
			setActive(p.sectionId);
		}
		void goto(hrefOf(p));
	}

	async function playPin(p: Pin) {
		try {
			switch (p.kind) {
				case 'folder': {
					const f = await getFolder(p.sectionId, p.key);
					playList(f.tracks, 0, { shuffle: false });
					if (!f.tracks.length) openPin(p); // only subfolders: show them instead
					break;
				}
				case 'genre':
				case 'mood':
					playList(
						withoutMixes(await getGenreTracksShuffled(p.sectionId, p.key, 200, undefined, { kind: p.kind })),
						0,
						{ shuffle: false }
					);
					break;
				case 'playlist':
					playList((await getPlaylistItems(p.key, { size: 500 })).items, 0);
					break;
				case 'album':
					playList((await getChildren(p.key, { size: 300 })).items, 0);
					break;
			}
		} catch (e) {
			logEvent(`pin play failed: ${(e as Error)?.message ?? e}`);
		}
	}

	// --- Made for <name>: Daily Mixes for the active library ---
	const firstName = $derived(
		(session.account?.title ?? session.account?.username ?? '').trim().split(/\s+/)[0] || 'you'
	);
	let dailyMixes = $state<DailyMix[]>([]);

	$effect(() => {
		const sec = activeSection();
		if (!sec) return;
		dailyMixes = cachedDailyMixes(sec.key) ?? [];
		const ctrl = new AbortController();
		buildDailyMixes(sec.key, ctrl.signal)
			.then((m) => {
				if (!ctrl.signal.aborted) dailyMixes = m;
			})
			.catch((e) => logEvent(`daily mixes failed: ${(e as Error)?.message ?? e}`));
		return () => ctrl.abort();
	});

	async function playDailyMix(m: DailyMix) {
		try {
			const tracks = await dailyMixTracks(m);
			if (tracks.length) playList(tracks, 0, { shuffle: false });
		} catch (e) {
			logEvent(`daily mix play failed: ${(e as Error)?.message ?? e}`);
		}
	}

	// --- Decades: endless radio per decade ---
	let decades = $state<Decade[]>([]);
	const shownDecades = $derived(decades.filter((d) => !decadeOpts.hidden.includes(d.start)));

	$effect(() => {
		const sec = activeSection();
		if (!sec) return;
		decades = cachedDecades(sec.key) ?? [];
		const ctrl = new AbortController();
		buildDecades(sec.key, ctrl.signal)
			.then((d) => {
				if (!ctrl.signal.aborted) decades = d;
			})
			.catch((e) => logEvent(`decades failed: ${(e as Error)?.message ?? e}`));
		return () => ctrl.abort();
	});

	async function playDecade(d: Decade) {
		try {
			const tracks = await decadeTracks(d, 30);
			if (tracks.length) playList(tracks, 0, { shuffle: false, feed: () => decadeTracks(d, 30) });
		} catch (e) {
			logEvent(`decade radio failed: ${(e as Error)?.message ?? e}`);
		}
	}

	// --- Mixes & live: whole CDs that play as one piece (kept out of radio, see mixes.svelte.ts) ---
	const mixes = $derived(activeSection() ? mixReleases(activeSection()!.key) : []);
	$effect(() => {
		const sec = activeSection();
		if (!sec) return;
		const ctrl = new AbortController();
		loadMixReleases(sec.key, ctrl.signal).catch((e) => {
			if (!ctrl.signal.aborted) logEvent(`mix scan failed: ${(e as Error)?.message ?? e}`);
		});
		return () => ctrl.abort();
	});
	function mixSubtitle(r: MixRelease): string {
		const min = Math.round(r.durationMs / 60000);
		const len = min >= 60 ? `${Math.floor(min / 60)} hr ${min % 60} min` : `${min} min`;
		return r.artist ? `${r.artist} · ${len}` : len;
	}
	async function playMix(r: MixRelease) {
		try {
			const tracks = await mixReleaseTracks(r);
			logEvent(`mix release "${r.title}": ${tracks.length} tracks`);
			if (tracks.length) playList(tracks, 0, { shuffle: false });
		} catch (e) {
			logEvent(`mix release play failed: ${(e as Error)?.message ?? e}`);
		}
	}

	// --- Continue listening ---
	let continuing = $state<Metadata[]>([]);

	$effect(() => {
		const ids = library.sections.map((s) => s.key);
		if (!ids.length) return;
		const ctrl = new AbortController();
		void loadContinue(ids, ctrl.signal);
		return () => ctrl.abort();
	});

	async function loadContinue(sectionIds: string[], signal: AbortSignal) {
		const lists = await Promise.all(
			sectionIds.map((id) => getInProgress(id, { size: 20 }, signal).catch(() => [] as Metadata[]))
		);
		if (signal.aborted) return;
		continuing = lists
			.flat()
			.sort((a, b) => (b.lastViewedAt ?? 0) - (a.lastViewedAt ?? 0))
			.slice(0, 16);
	}

	function remaining(t: Metadata): string {
		const left = Math.max(0, (t.duration ?? 0) - (t.viewOffset ?? 0));
		const min = Math.round(left / 60000);
		return min >= 60 ? `${Math.floor(min / 60)} hr ${min % 60} min left` : `${min} min left`;
	}

	function progressOf(t: Metadata): number {
		return t.duration ? Math.min(1, (t.viewOffset ?? 0) / t.duration) : 0;
	}

	function playContinue(t: Metadata) {
		playList([t], 0); // resumes at the Plex resume point; autoplay carries on afterwards
	}
</script>

{#if pins.items.length}
	<section class="shelf">
		<h2>Pinned</h2>
		<div class="row">
			{#each pins.items as p (p.id)}
				<div class="slot" style="width: {TILE / 16}rem">
					<ShelfTile
						title={p.title}
						subtitle={p.subtitle}
						thumb={p.thumb}
						icon={ICON[p.kind]}
						size={TILE}
						onOpen={() => openPin(p)}
						onPlay={() => playPin(p)}
					/>
				</div>
			{/each}
		</div>
	</section>
{/if}

{#if dailyMixes.length}
	<section class="shelf">
		<h2>Made for {firstName}</h2>
		<div class="row">
			{#each dailyMixes as m (m.id)}
				<div class="slot" style="width: {200 / 16}rem">
					<DailyMixCard mix={m} size={200} onPlay={() => playDailyMix(m)} />
				</div>
			{/each}
		</div>
	</section>
{/if}

{#if shownDecades.length}
	<section class="shelf">
		<h2>Decades</h2>
		<div class="row">
			{#each shownDecades as d (d.id)}
				<div class="slot" style="width: {TILE / 16}rem">
					<DecadeCard decade={d} size={TILE} onPlay={() => playDecade(d)} />
				</div>
			{/each}
		</div>
	</section>
{/if}

{#if mixes.length}
	<section class="shelf">
		<h2>Mixes & live</h2>
		<div class="row">
			{#each mixes as r (r.id)}
				<div class="slot" style="width: {TILE / 16}rem">
					<ShelfTile
						title={r.title}
						subtitle={mixSubtitle(r)}
						thumb={r.thumb}
						icon="album"
						size={TILE}
						onOpen={() => playMix(r)}
						onPlay={() => playMix(r)}
					/>
				</div>
			{/each}
		</div>
	</section>
{/if}

{#if continuing.length}
	<section class="shelf">
		<h2>Continue listening</h2>
		<div class="row">
			{#each continuing as t (t.ratingKey)}
				<div class="slot" style="width: {TILE / 16}rem">
					<ShelfTile
						title={t.title}
						subtitle={remaining(t)}
						thumb={t.parentThumb ?? t.thumb ?? t.grandparentThumb}
						icon="album"
						size={TILE}
						progress={progressOf(t)}
						onOpen={() => playContinue(t)}
						onPlay={() => playContinue(t)}
					/>
				</div>
			{/each}
		</div>
	</section>
{/if}

<style>
	.shelf {
		margin-bottom: 2rem;
	}
	h2 {
		margin: 0 0 0.85rem;
		font-size: clamp(1.05rem, 1.8vw, 1.3rem);
		font-weight: 600;
	}
	.row {
		display: flex;
		gap: 1rem;
		overflow-x: auto;
		padding-bottom: 0.25rem;
		scrollbar-width: none;
	}
	.slot {
		flex: 0 0 auto;
	}
</style>
