<script lang="ts">
	// A page that shows what's in something before you play it (a mix CD, a Daily Mix, a decade):
	// artwork, title, Play / Shuffle, and the tracks. Nothing plays until you press Play or a track.
	import type { Snippet } from 'svelte';
	import type { Metadata } from '$lib/plex/types';
	import { playList } from '$lib/stores/player.svelte';
	import TrackList from './TrackList.svelte';
	import Icon from './Icon.svelte';

	let {
		kind,
		title,
		subtitle = '',
		tracks,
		loading = false,
		error = null,
		art,
		onPlay,
		extra,
		showArtist = true
	}: {
		kind: string;
		title: string;
		subtitle?: string;
		tracks: Metadata[];
		loading?: boolean;
		error?: string | null;
		art: Snippet;
		/** Play from the top (default: the list in order). */
		onPlay?: () => void;
		/** More buttons after Play / Shuffle. */
		extra?: Snippet;
		showArtist?: boolean;
	} = $props();

	function fmtLength(ms: number): string {
		const min = Math.round(ms / 60000);
		return min >= 60 ? `${Math.floor(min / 60)} hr ${min % 60} min` : `${min} min`;
	}
	let view = $state<Metadata[]>([]);
	const meta = $derived.by(() => {
		if (!tracks.length) return '';
		const ms = tracks.reduce((a, t) => a + (t.duration ?? 0), 0);
		return `${tracks.length} track${tracks.length === 1 ? '' : 's'} · ${fmtLength(ms)}`;
	});
</script>

<section class="page detail">
	<button class="back" onclick={() => history.back()}>← Back</button>

	<header class="hero">
		<div class="art">{@render art()}</div>
		<div class="info">
			<p class="kind">{kind}</p>
			<h1>{title}</h1>
			{#if subtitle}<p class="subtitle">{subtitle}</p>{/if}
			{#if meta}<p class="meta dim">{meta}</p>{/if}
			<div class="actions">
				<button
					class="play-btn"
					onclick={() =>
						onPlay && view === tracks ? onPlay() : playList(view.length ? view : tracks, 0, { shuffle: false })}
					disabled={!tracks.length}
				>
					<Icon name="play" size={20} /> Play
				</button>
				<button
					class="shuffle-btn"
					onclick={() => playList(tracks, 0, { shuffle: true })}
					disabled={!tracks.length}
				>
					<Icon name="shuffle" size={18} /> Shuffle
				</button>
				{@render extra?.()}
			</div>
		</div>
	</header>

	{#if loading}
		<div class="center"><div class="spinner" aria-hidden="true"></div></div>
	{:else if error}
		<p class="err">{error}</p>
	{:else}
		<TrackList {tracks} {showArtist} ordinal sortable bind:view />
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
	.hero {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: clamp(1rem, 3vw, 2rem);
		margin-bottom: 2rem;
	}
	.art {
		flex: 0 0 auto;
		width: clamp(10rem, 24vw, 17.5rem);
		aspect-ratio: 1;
		border-radius: 0.75rem;
		overflow: hidden;
		background: var(--surface);
		position: relative;
	}
	.info {
		min-width: 0;
	}
	.kind {
		margin: 0;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-size: 0.8rem;
		color: var(--text-dim);
	}
	.info h1 {
		margin: 0.25rem 0;
		font-size: clamp(1.8rem, 4vw, 3rem);
		font-weight: 700;
		letter-spacing: -0.02em;
	}
	.subtitle {
		margin: 0.35rem 0 0;
		font-size: clamp(1.15rem, 2.2vw, 1.5rem);
	}
	.meta {
		margin: 0.35rem 0 0;
		font-size: 1.05rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-top: 1.75rem;
	}
	.actions :global(.play-btn),
	.actions :global(.shuffle-btn) {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 3.25rem;
		padding: 0 1.5rem;
		border-radius: 999px;
		font-size: 1rem;
		font-weight: 600;
	}
	.actions :global(.play-btn) {
		background: var(--accent);
		color: #fff;
	}
	.actions :global(.shuffle-btn) {
		background: var(--surface);
		color: var(--text);
	}
	.actions :global(button:disabled) {
		opacity: 0.5;
	}
	.center {
		display: grid;
		place-items: center;
		padding: 4rem 0;
	}
	.spinner {
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 50%;
		border: 0.25rem solid var(--surface);
		border-top-color: var(--accent);
		animation: spin 0.9s linear infinite;
	}
	.err {
		color: var(--accent);
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
