<script lang="ts">
	// Browse a library by its folders on disk (like Plexamp's folder view). A subfolder is opened via
	// ?k=<folder key>&n=<name>, so the browser/back button walks back up the tree. Tapping a track
	// plays the folder's tracks from there; Play/Shuffle play the whole folder.
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { activeSection } from '$lib/stores/library.svelte';
	import { getFolder, type FolderListing } from '$lib/plex/library';
	import { playList } from '$lib/stores/player.svelte';
	import LibraryChips from '$lib/components/LibraryChips.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import PinButton from '$lib/components/PinButton.svelte';
	import { pinId } from '$lib/stores/pins.svelte';

	const section = $derived(activeSection());
	const folderKey = $derived(page.url.searchParams.get('k') ?? undefined);
	const folderName = $derived(page.url.searchParams.get('n') ?? '');

	let listing = $state<FolderListing | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	$effect(() => {
		const s = section?.key;
		const k = folderKey;
		if (!s) return;
		const ctrl = new AbortController();
		void load(s, k, ctrl.signal);
		return () => ctrl.abort();
	});

	async function load(sectionId: string, k: string | undefined, signal: AbortSignal) {
		loading = true;
		error = null;
		listing = null;
		try {
			const res = await getFolder(sectionId, k, signal);
			if (!signal.aborted) listing = res;
		} catch (e) {
			if (!signal.aborted) error = e instanceof Error ? e.message : String(e);
		} finally {
			if (!signal.aborted) loading = false;
		}
	}

	function folderHref(key: string, name: string): string {
		const q = new URLSearchParams({ k: key, n: name });
		return `/folders?${q.toString()}`;
	}
</script>

<section class="page">
	{#if folderKey}
		<button class="back" onclick={() => history.back()}>← Back</button>
		<h1>{folderName || 'Folder'}</h1>
	{:else}
		<h1>Folders</h1>
		<LibraryChips onchange={() => goto('/folders')} />
	{/if}

	{#if loading}
		<div class="center"><div class="spinner" aria-hidden="true"></div></div>
	{:else if error}
		<p class="err">{error}</p>
	{:else if listing}
		{#if listing.tracks.length || (folderKey && section)}
			<div class="actions">
				{#if listing.tracks.length}
				<button class="play-btn" onclick={() => playList(listing!.tracks, 0, { shuffle: false })}>
					<Icon name="play" size={20} /> Play
				</button>
				<button class="shuffle-btn" onclick={() => playList(listing!.tracks, 0, { shuffle: true })}>
					<Icon name="shuffle" size={18} /> Shuffle
				</button>
				{/if}
				{#if folderKey && section}
					{@const first = listing.tracks[0]}
					<PinButton
						pin={{
							id: pinId('folder', section.key, folderKey),
							kind: 'folder',
							key: folderKey,
							sectionId: section.key,
							title: folderName || 'Folder',
							subtitle: `Folder · ${section.title}`,
							thumb: first ? (first.parentThumb ?? first.thumb ?? first.grandparentThumb) : undefined
						}}
					/>
				{/if}
				{#if listing.tracks.length}
					<span class="dim count">
						{listing.tracks.length} track{listing.tracks.length === 1 ? '' : 's'}
					</span>
				{/if}
			</div>
		{/if}

		{#if listing.folders.length}
			<ul class="folders">
				{#each listing.folders as f (f.key)}
					<li>
						<a class="folder" href={folderHref(f.key, f.title)}>
							<Icon name="folder" size={24} />
							<span class="name">{f.title}</span>
							<Icon name="chevron-right" size={20} />
						</a>
					</li>
				{/each}
			</ul>
		{/if}

		{#if listing.tracks.length}
			<TrackList tracks={listing.tracks} showArtist={true} />
		{/if}

		{#if !listing.folders.length && !listing.tracks.length}
			<p class="dim">This folder is empty.</p>
		{/if}
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
	h1 {
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 1.5rem;
	}
	.play-btn,
	.shuffle-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 3.25rem;
		padding: 0 1.5rem;
		border-radius: 999px;
		font-size: 1rem;
		font-weight: 600;
	}
	.play-btn {
		background: var(--accent);
		color: #fff;
	}
	.shuffle-btn {
		background: var(--surface);
		color: var(--text);
	}
	.count {
		margin-left: 0.25rem;
	}
	.folders {
		list-style: none;
		margin: 0 0 1.5rem;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.folders li {
		/* Large libraries list 1000+ folders: skip rendering rows that are off screen. */
		content-visibility: auto;
		contain-intrinsic-size: auto 3.5rem;
	}
	.folder {
		display: flex;
		align-items: center;
		gap: 0.9rem;
		min-height: 3.5rem;
		padding: 0.5rem 1rem;
		border-radius: 0.75rem;
		background: var(--surface);
		color: var(--text);
		text-decoration: none;
	}
	.folder :global(svg:first-child) {
		color: var(--accent);
		flex: 0 0 auto;
	}
	.folder :global(svg:last-child) {
		color: var(--text-dim);
		flex: 0 0 auto;
	}
	.name {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 1.05rem;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
