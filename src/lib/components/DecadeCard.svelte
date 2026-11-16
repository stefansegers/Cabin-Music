<script lang="ts">
	// A decade radio tile: a 2×2 collage of albums from that decade under a big "80s". One tap
	// starts an endless station of tracks from that decade.
	import Art from './Art.svelte';
	import Icon from './Icon.svelte';
	import type { Decade } from '$lib/plex/decades.svelte';

	let { decade, size = 168, onPlay }: { decade: Decade; size?: number; onPlay: () => Promise<void> | void } =
		$props();

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

	const cells = $derived(
		decade.thumbs.length ? Array.from({ length: 4 }, (_, i) => decade.thumbs[i % decade.thumbs.length]) : []
	);
</script>

<button class="card" onclick={play} disabled={busy} style="--h: {decade.hue}" title="{decade.label} radio">
	<div class="cover">
		{#if cells.length}
			<div class="grid">
				{#each cells as t, i (i)}
					<div class="cell"><Art thumb={t} w={size} /></div>
				{/each}
			</div>
		{/if}
		<div class="shade"></div>
		<span class="label">{decade.label}</span>
		<span class="play" aria-hidden="true"><Icon name={busy ? 'radio' : 'play'} size={20} /></span>
	</div>
	<span class="sub">{decade.label} radio</span>
</button>

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
	.shade {
		position: absolute;
		inset: 0;
		background: linear-gradient(160deg, hsl(var(--h) 70% 28% / 0.92), hsl(var(--h) 70% 22% / 0.55));
	}
	.label {
		position: absolute;
		left: 0.8rem;
		top: 0.55rem;
		color: #fff;
		font-size: 2.4rem;
		font-weight: 800;
		letter-spacing: -0.03em;
		text-shadow: 0 0.1rem 0.6rem rgba(0, 0, 0, 0.35);
	}
	.play {
		position: absolute;
		right: 0.6rem;
		bottom: 0.6rem;
		width: 3rem;
		height: 3rem;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--accent);
		color: #fff;
		box-shadow: 0 0.25rem 0.75rem rgba(0, 0, 0, 0.35);
	}
	.card:disabled .play {
		opacity: 0.75;
	}
	.sub {
		font-size: 0.85rem;
		color: var(--text-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
