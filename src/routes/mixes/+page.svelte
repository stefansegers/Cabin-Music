<script lang="ts">
	// All mix CDs and live albums of the active library. Cover = play the whole CD, text = its page.
	import { goto } from '$app/navigation';
	import { activeSection } from '$lib/stores/library.svelte';
	import { playList } from '$lib/stores/player.svelte';
	import { logEvent } from '$lib/stores/debug.svelte';
	import ShelfTile from '$lib/components/ShelfTile.svelte';
	import {
		loadMixReleases,
		mixReleases,
		mixReleaseTracks,
		mixSubtitle,
		mixHref,
		type MixRelease
	} from '$lib/plex/mixes.svelte';

	const section = $derived(activeSection());
	const list = $derived(section ? mixReleases(section.key) : []);
	let loading = $state(false);

	$effect(() => {
		const sec = activeSection();
		if (!sec) return;
		const ctrl = new AbortController();
		loading = !mixReleases(sec.key).length;
		loadMixReleases(sec.key, ctrl.signal)
			.catch((e) => logEvent(`mix scan failed: ${(e as Error)?.message ?? e}`))
			.finally(() => (loading = false));
		return () => ctrl.abort();
	});

	async function play(r: MixRelease) {
		const tracks = await mixReleaseTracks(r);
		if (tracks.length) playList(tracks, 0, { shuffle: false });
	}
</script>

<section class="page">
	<h1>Mixes & live</h1>
	{#if list.length}
		<p class="dim intro">{list.length} CDs that play as one piece — kept out of radio and Daily Mixes.</p>
		<div class="grid">
			{#each list as r (r.id)}
				<ShelfTile
					title={r.title}
					subtitle={mixSubtitle(r)}
					thumb={r.thumb}
					icon="album"
					onPlay={() => play(r)}
					onOpen={() => goto(mixHref(r))}
				/>
			{/each}
		</div>
	{:else if loading}
		<p class="dim">Looking through the library…</p>
	{:else}
		<p class="dim">No mixes or live albums found in this library.</p>
	{/if}
</section>

<style>
	.intro {
		margin: -0.5rem 0 1.5rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(10.5rem, 1fr));
		gap: 1.5rem 1rem;
	}
</style>
