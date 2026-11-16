<script lang="ts">
	// Everything added lately, newest first: look through it, then Play.
	import { activeSection } from '$lib/stores/library.svelte';
	import { getAll, TYPE } from '$lib/plex/library';
	import TrackListPage from '$lib/components/TrackListPage.svelte';
	import Collage from '$lib/components/Collage.svelte';
	import type { Metadata } from '$lib/plex/types';

	const section = $derived(activeSection());
	let tracks = $state<Metadata[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	const thumbs = $derived(
		[...new Set(tracks.map((t) => t.parentThumb ?? t.thumb).filter((x): x is string => !!x))].slice(0, 4)
	);

	$effect(() => {
		const sec = section;
		if (!sec) return;
		const ctrl = new AbortController();
		loading = true;
		error = null;
		getAll(sec.key, { type: TYPE.track, sort: 'addedAt:desc', size: 200 }, ctrl.signal)
			.then((r) => (tracks = r.items))
			.catch((e) => {
				if (!ctrl.signal.aborted) error = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				if (!ctrl.signal.aborted) loading = false;
			});
		return () => ctrl.abort();
	});
</script>

<TrackListPage kind="Recently added" title="New in {section?.title ?? 'your library'}" {tracks} {loading} {error}>
	{#snippet art()}<Collage {thumbs} hue={210} />{/snippet}
</TrackListPage>
