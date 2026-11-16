<script lang="ts">
	// 2×2 cover collage (Daily Mixes, decades) on a tinted background; fills its container.
	import Art from './Art.svelte';

	let { thumbs, hue, size = 280 }: { thumbs: string[]; hue: number; size?: number } = $props();
	const cells = $derived(thumbs.length ? Array.from({ length: 4 }, (_, i) => thumbs[i % thumbs.length]) : []);
</script>

<div class="collage" style="--h: {hue}">
	{#each cells as t, i (i)}
		<div class="cell"><Art thumb={t} w={size} /></div>
	{/each}
</div>

<style>
	.collage {
		position: absolute;
		inset: 0;
		display: grid;
		grid-template-columns: 1fr 1fr;
		grid-template-rows: 1fr 1fr;
		background: hsl(var(--h) 55% 35%);
	}
	.cell {
		overflow: hidden;
	}
</style>
