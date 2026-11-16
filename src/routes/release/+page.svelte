<script lang="ts">
	// One CD (a folder, discs merged): a mix / live album, or a compilation from Recently added. Its
	// tracks in order and Play; for a mix also "Not a mix", to correct a wrong guess.
	import { page } from '$app/state';
	import { activeSection } from '$lib/stores/library.svelte';
	import { playList } from '$lib/stores/player.svelte';
	import TrackListPage from '$lib/components/TrackListPage.svelte';
	import Art from '$lib/components/Art.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import {
		isNotMix,
		loadMixReleases,
		mixReleaseById,
		releaseTracks,
		setNotMix
	} from '$lib/plex/mixes.svelte';
	import { recentById } from '$lib/plex/recent';
	import type { Metadata } from '$lib/plex/types';

	const id = $derived(page.url.searchParams.get('id') ?? '');
	let ready = $state(0); // bumps when the releases have loaded (byDir isn't reactive)
	const isMix = $derived(ready >= 0 && !!mixReleaseById(id));
	const r = $derived(ready >= 0 ? (mixReleaseById(id) ?? recentById(id)) : null);
	let tracks = $state<Metadata[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	$effect(() => {
		const sec = activeSection();
		if (sec && !mixReleaseById(id) && !recentById(id)) void loadMixReleases(sec.key).then(() => ready++);
	});
	$effect(() => {
		const rel = r;
		if (!rel) return;
		let gone = false;
		loading = true;
		error = null;
		releaseTracks(rel)
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

{#if r}
	<TrackListPage
		kind={isMix && !isNotMix(r.id) ? 'Mix / live' : 'Album'}
		title={r.title}
		subtitle={r.artist ?? 'Various artists'}
		{tracks}
		{loading}
		{error}
		onPlay={() => playList(tracks, 0, { shuffle: false })}
	>
		{#snippet art()}<Art thumb={r.thumb} w={560} />{/snippet}
		{#snippet extra()}
			{#if isMix}
			<button
				class="shuffle-btn"
				onclick={() => setNotMix(r.id, !isNotMix(r.id))}
				title="Not a mix: it can play in radio and Daily Mixes again and no longer shows under Mixes & live"
			>
				<Icon name={isNotMix(r.id) ? 'check' : 'x'} size={18} />
				{isNotMix(r.id) ? 'Marked: not a mix' : 'Not a mix'}
			</button>
			{/if}
		{/snippet}
	</TrackListPage>
{:else}
	<section class="page"><p class="dim">Loading…</p></section>
{/if}
