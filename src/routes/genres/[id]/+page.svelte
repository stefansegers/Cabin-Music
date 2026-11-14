<script lang="ts">
	// One genre: "Shuffle genre" (random tracks from its albums) plus a grid of its albums.
	import { page } from '$app/state';
	import { activeSection } from '$lib/stores/library.svelte';
	import { getGenreAlbums, getGenreTracksShuffled } from '$lib/plex/library';
	import { playList } from '$lib/stores/player.svelte';
	import VirtualGrid from '$lib/components/VirtualGrid.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import PinButton from '$lib/components/PinButton.svelte';
	import { pinId } from '$lib/stores/pins.svelte';
	import type { PageResult } from '$lib/plex/types';

	const section = $derived(activeSection());
	const genreId = $derived(page.params.id ?? '');
	const name = $derived(page.url.searchParams.get('n') ?? 'Genre');
	// Genre or mood; the id may be several raw tag ids joined by commas (a merged group).
	const kind = $derived<'genre' | 'mood'>(page.url.searchParams.get('kind') === 'mood' ? 'mood' : 'genre');

	let shuffling = $state(false);
	let shuffleError = $state<string | null>(null);

	function makeLoad(sectionId: string, id: string, k: 'genre' | 'mood') {
		return (start: number, size: number): Promise<PageResult> =>
			getGenreAlbums(sectionId, id, { start, size, kind: k });
	}

	async function shuffleGenre() {
		if (!section || shuffling) return;
		shuffling = true;
		shuffleError = null;
		try {
			const tracks = await getGenreTracksShuffled(section.key, genreId, 200, undefined, { kind });
			if (tracks.length) playList(tracks, 0, { shuffle: false });
			else shuffleError = `No tracks found in this ${kind}.`;
		} catch (e) {
			shuffleError = e instanceof Error ? e.message : String(e);
		} finally {
			shuffling = false;
		}
	}
</script>

<section class="page">
	<button class="back" onclick={() => history.back()}>← Back</button>
	<p class="kind">{kind === 'mood' ? 'Mood' : 'Genre'}</p>
	<h1>{name}</h1>

	<div class="actions">
		<button class="play-btn" onclick={shuffleGenre} disabled={shuffling || !section}>
			<Icon name="shuffle" size={18} />
			{shuffling ? 'Loading…' : kind === 'mood' ? 'Shuffle mood' : 'Shuffle genre'}
		</button>
		{#if section}
			<PinButton
				pin={{
					id: pinId(kind, section.key, genreId),
					kind,
					key: genreId,
					sectionId: section.key,
					title: name,
					subtitle: `${kind === 'mood' ? 'Mood' : 'Genre'} · ${section.title}`
				}}
			/>
		{/if}
	</div>
	{#if shuffleError}<p class="err">{shuffleError}</p>{/if}

	{#if section && genreId}
		{#key `${section.key}:${kind}:${genreId}`}
			<VirtualGrid load={makeLoad(section.key, genreId, kind)} />
		{/key}
	{/if}
</section>

<style>
	.back {
		margin-bottom: 1rem;
		min-height: 2.75rem;
		padding: 0 1rem;
		border-radius: 999px;
		background: var(--surface);
		color: var(--text);
		font-weight: 600;
	}
	.kind {
		margin: 0;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-size: 0.8rem;
		color: var(--text-dim);
	}
	h1 {
		margin: 0.25rem 0 0;
		font-size: clamp(1.8rem, 4vw, 3rem);
		font-weight: 700;
		letter-spacing: -0.02em;
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin: 1.25rem 0 1.75rem;
	}
	.play-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 3.25rem;
		padding: 0 1.5rem;
		border-radius: 999px;
		font-size: 1rem;
		font-weight: 600;
		background: var(--accent);
		color: #fff;
	}
	.play-btn:disabled {
		opacity: 0.6;
	}
	.err {
		color: var(--accent);
	}
</style>
