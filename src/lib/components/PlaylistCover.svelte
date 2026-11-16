<script lang="ts">
	// A playlist cover in the style of the Daily Mixes: Plex's own 2×2 collage of the playlist's
	// albums, under a colour band with the name. "Best of 2024" gets the year big, each year its own
	// colour, so the yearly lists are told apart at a glance. Fills its (square) container.
	import Art from './Art.svelte';
	import Icon from './Icon.svelte';

	let {
		title,
		thumb,
		size = 168,
		clear = true
	}: {
		title: string;
		thumb?: string | null;
		size?: number;
		/** Keep the name clear of a round play button in the corner. */
		clear?: boolean;
	} = $props();

	const year = $derived(title.match(/\b(?:best\s*of|top)\D{0,3}((?:19|20)\d{2})\b/i)?.[1] ?? null);
	const name = $derived(title.replace(/^[_\s]+/, '').trim());

	function hueOf(s: string): number {
		let h = 0;
		for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
		return h % 360;
	}
	// Years walk round the colour wheel in big steps, so neighbouring years differ clearly.
	const hue = $derived(year ? (Number(year) * 47) % 360 : hueOf(name.toLowerCase()));
</script>

<div class="pc" style="--h: {hue}">
	{#if thumb}
		<div class="img"><Art {thumb} w={size * 2} /></div>
	{:else}
		<div class="empty"><Icon name="playlist" size={44} /></div>
	{/if}
	{#if year}
		<div class="shade"></div>
		<span class="kicker">Best of</span>
		<span class="year">{year}</span>
	{:else}
		<div class="band"><span class="name" class:clear>{name}</span></div>
	{/if}
</div>

<style>
	.pc {
		position: absolute;
		inset: 0;
		background: hsl(var(--h) 55% 32%);
		overflow: hidden;
	}
	.img {
		position: absolute;
		inset: 0;
	}
	.empty {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: hsl(var(--h) 70% 80%);
		background: linear-gradient(135deg, hsl(var(--h) 55% 38%), hsl(var(--h) 60% 22%));
	}
	.shade {
		position: absolute;
		inset: 0;
		background: linear-gradient(160deg, hsl(var(--h) 75% 30% / 0.9) 15%, hsl(var(--h) 75% 22% / 0.3) 75%);
	}
	.kicker {
		position: absolute;
		left: 0.8rem;
		top: 0.6rem;
		color: #fff;
		font-size: 0.8rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		opacity: 0.9;
	}
	.year {
		position: absolute;
		left: 0.7rem;
		top: 1.4rem;
		color: #fff;
		font-size: 2.6rem;
		font-weight: 800;
		letter-spacing: -0.03em;
		text-shadow: 0 0.1rem 0.6rem rgba(0, 0, 0, 0.35);
	}
	.band {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		padding: 0.6rem 0.8rem 0.7rem;
		background: linear-gradient(to top, hsl(var(--h) 70% 28% / 0.97), hsl(var(--h) 70% 28% / 0.82));
	}
	.name {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		color: #fff;
		font-size: 1.05rem;
		font-weight: 800;
		line-height: 1.15;
	}
	.name.clear {
		padding-right: 3.6rem; /* clear of the round play button */
	}
</style>
