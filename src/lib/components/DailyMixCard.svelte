<script lang="ts">
	// A Daily Mix cover, made from the user's own album art: a 2×2 collage of the albums the mix
	// leans on, with a colour band carrying "Daily Mix N" and the genre. One tap plays the mix.
	import Art from './Art.svelte';
	import Icon from './Icon.svelte';
	import type { DailyMix } from '$lib/plex/dailyMixes';

	let {
		mix,
		size = 200,
		onPlay,
		onOpen
	}: { mix: DailyMix; size?: number; onPlay: () => Promise<void> | void; onOpen?: () => void } = $props();

	let busy = $state(false);
	async function play() {
		if (busy) return;
		busy = true;
		try {
			await onPlay();
		} finally {
			busy = false;
		}
	}

	// Always four cells: repeat covers when there are fewer than four.
	const cells = $derived(
		mix.thumbs.length ? Array.from({ length: 4 }, (_, i) => mix.thumbs[i % mix.thumbs.length]) : []
	);
</script>

<div class="card" style="--h: {mix.hue}" title="Daily Mix {mix.n} · {mix.genre}">
	<button class="cover" onclick={play} disabled={busy}>
		{#if cells.length}
			<div class="grid">
				{#each cells as t, i (i)}
					<div class="cell"><Art thumb={t} w={size} /></div>
				{/each}
			</div>
		{/if}
		<div class="band">
			<span class="label">Daily Mix {mix.n}</span>
			<span class="genre">{mix.genre}</span>
		</div>
		<span class="play" aria-hidden="true"><Icon name={busy ? 'radio' : 'play'} size={22} /></span>
	</button>
	{#if onOpen}
		<button class="sub link" onclick={onOpen}>
			<span class="t">{mix.artists.join(', ') || mix.genre}</span>
			<span class="chev" aria-hidden="true"><Icon name="chevron-right" size={16} /></span>
		</button>
	{:else}
		<span class="sub">{mix.artists.join(', ') || mix.genre}</span>
	{/if}
</div>

<style>
	.card {
		width: 100%;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		color: var(--text);
		text-align: left;
	}
	.cover {
		display: block;
		padding: 0;
		position: relative;
		width: 100%;
		aspect-ratio: 1 / 1;
		border-radius: 0.75rem;
		overflow: hidden;
		background: hsl(var(--h) 55% 35%);
	}
	.grid {
		position: absolute;
		inset: 0;
		display: grid;
		grid-template-columns: 1fr 1fr;
		grid-template-rows: 1fr 1fr;
	}
	.cell {
		overflow: hidden;
	}
	.band {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		flex-direction: column;
		padding: 0.7rem 0.85rem 0.8rem;
		background: linear-gradient(to top, hsl(var(--h) 70% 30% / 0.97), hsl(var(--h) 70% 30% / 0.85));
		color: #fff;
	}
	.label {
		font-size: 1.15rem;
		font-weight: 800;
		letter-spacing: -0.01em;
	}
	.genre {
		font-size: 0.85rem;
		font-weight: 600;
		opacity: 0.9;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		padding-right: 3.5rem;
	}
	.play {
		position: absolute;
		right: 0.6rem;
		bottom: 0.7rem;
		width: 3.25rem;
		height: 3.25rem;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--accent);
		color: #fff;
		box-shadow: 0 0.25rem 0.75rem rgba(0, 0, 0, 0.35);
	}
	.cover:disabled .play {
		opacity: 0.75;
	}
	.sub.link {
		display: flex;
		align-items: center;
		gap: 0.15rem;
		margin: -0.3rem -0.4rem;
		padding: 0.3rem 0.4rem;
		border-radius: 0.5rem;
		color: var(--text);
		font-weight: 600;
		text-align: left;
	}
	.sub.link:active {
		background: var(--surface);
	}
	.t {
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.chev {
		flex: 0 0 auto;
		display: grid;
		color: var(--accent);
	}
	.sub {
		font-size: 0.85rem;
		color: var(--text-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
