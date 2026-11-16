<script lang="ts">
	// A decade: a sample of what its radio plays. Play starts the endless station with this sample.
	import { page } from '$app/state';
	import { playList } from '$lib/stores/player.svelte';
	import TrackListPage from '$lib/components/TrackListPage.svelte';
	import Collage from '$lib/components/Collage.svelte';
	import { cachedDecades, decadeTracks } from '$lib/plex/decades.svelte';
	import type { Metadata } from '$lib/plex/types';

	const id = $derived(page.url.searchParams.get('id') ?? '');
	const decade = $derived(cachedDecades(id.split(':')[0])?.find((d) => d.id === id) ?? null);
	let tracks = $state<Metadata[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	$effect(() => {
		const d = decade;
		if (!d) return;
		let gone = false;
		loading = true;
		decadeTracks(d, 30)
			.then((t) => {
				if (!gone) tracks = t;
			})
			.catch((e) => {
				if (!gone) error = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				if (!gone) loading = false;
			});
		return () => (gone = true);
	});
</script>

{#if decade}
	<TrackListPage
		kind="Decade radio"
		title={decade.label}
		subtitle="Keeps going with more from the {decade.label}"
		{tracks}
		{loading}
		{error}
		onPlay={() => playList(tracks, 0, { shuffle: false, feed: () => decadeTracks(decade, 30) })}
	>
		{#snippet art()}<Collage thumbs={decade.thumbs} hue={decade.hue} />{/snippet}
	</TrackListPage>
{:else}
	<section class="page"><p class="dim">This decade isn't in the library.</p></section>
{/if}
