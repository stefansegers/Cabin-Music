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
	import type { Metadata } from '$lib/plex/types';

	const TILE = 168;

	// --- Pinned ---
	function hrefOf(p: Pin): string {
		switch (p.kind) {
			case 'folder':
				return `/folders?${new URLSearchParams({ k: p.key, n: p.title })}`;
			case 'genre':
				return `/genres/${encodeURIComponent(p.key)}?n=${encodeURIComponent(p.title)}`;
			case 'playlist':
				return `/playlist/${p.key}`;
			case 'album':
				return `/album/${p.key}`;
		}
	}

	const ICON: Record<Pin['kind'], string> = {
		folder: 'folder',
		genre: 'genre',
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
					playList(await getGenreTracksShuffled(p.sectionId, p.key), 0, { shuffle: false });
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
