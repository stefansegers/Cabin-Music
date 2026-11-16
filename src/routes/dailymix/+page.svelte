<script lang="ts">
	// One Daily Mix: today's pick of tracks, shown before playing. Play plays exactly this list.
	import { page } from '$app/state';
	import TrackListPage from '$lib/components/TrackListPage.svelte';
	import Collage from '$lib/components/Collage.svelte';
	import { cachedDailyMixes, dailyMixTracks } from '$lib/plex/dailyMixes';
	import type { Metadata } from '$lib/plex/types';

	const id = $derived(page.url.searchParams.get('id') ?? '');
	const mix = $derived(cachedDailyMixes(id.split(':')[0])?.find((m) => m.id === id) ?? null);
	let tracks = $state<Metadata[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	$effect(() => {
		const m = mix;
		if (!m) return;
		let gone = false;
		loading = true;
		dailyMixTracks(m)
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

{#if mix}
	<TrackListPage
		kind="Daily Mix"
		title="Daily Mix {mix.n}"
		subtitle={mix.genre}
		{tracks}
		{loading}
		{error}
	>
		{#snippet art()}<Collage thumbs={mix.thumbs} hue={mix.hue} />{/snippet}
	</TrackListPage>
{:else}
	<section class="page"><p class="dim">This Daily Mix is gone — today's mixes are on Home.</p></section>
{/if}
