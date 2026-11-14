<script lang="ts">
	// Genres & Moods of the active library, cleaned up (see tags.ts): variants merged, first value of
	// combined tags only, tiny one-off tags behind "Show all". Genres: biggest first as a top row, then
	// A–Z. Moods: the most-used ones; the long tail behind "Show all".
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { activeSection } from '$lib/stores/library.svelte';
	import { cachedTagGroups, loadTagGroups, SMALL_GROUP, type TagGroup, type TagKind } from '$lib/plex/tags';
	import LibraryChips from '$lib/components/LibraryChips.svelte';

	const TOP_GENRES = 12;
	const TOP_MOODS = 25;

	const section = $derived(activeSection());
	const kind = $derived<TagKind>(page.url.searchParams.get('tab') === 'moods' ? 'mood' : 'genre');

	let groups = $state<TagGroup[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let showAll = $state(false);

	$effect(() => {
		const s = section?.key;
		const k = kind;
		if (!s) return;
		showAll = false;
		const ctrl = new AbortController();
		void load(s, k, ctrl.signal);
		return () => ctrl.abort();
	});

	async function load(sectionId: string, k: TagKind, signal: AbortSignal) {
		error = null;
		const cached = cachedTagGroups(sectionId, k);
		groups = cached ?? [];
		loading = !cached; // cached → render instantly, refresh quietly
		try {
			const res = await loadTagGroups(sectionId, k, { signal });
			if (!signal.aborted) groups = res;
		} catch (e) {
			if (!signal.aborted && !cached) error = e instanceof Error ? e.message : String(e);
		} finally {
			if (!signal.aborted) loading = false;
		}
	}

	const byCount = $derived([...groups].sort((a, b) => b.count - a.count));
	const top = $derived(byCount.slice(0, kind === 'mood' ? TOP_MOODS : TOP_GENRES));
	const hiddenCount = $derived(
		kind === 'mood'
			? Math.max(0, groups.length - TOP_MOODS)
			: groups.filter((g) => g.count < SMALL_GROUP).length
	);
	// The A–Z list: genres big enough to matter (or everything with "Show all"); moods only on "Show all".
	const listed = $derived(
		kind === 'mood' ? (showAll ? groups : []) : showAll ? groups : groups.filter((g) => g.count >= SMALL_GROUP)
	);

	function letterOf(title: string): string {
		const c = title.trim().charAt(0).toUpperCase();
		return /[A-Z]/.test(c) ? c : '#';
	}
	const letters = $derived.by(() => {
		const map = new Map<string, TagGroup[]>();
		for (const g of listed) {
			const l = letterOf(g.name);
			if (!map.has(l)) map.set(l, []);
			map.get(l)!.push(g);
		}
		return [...map.entries()].sort(([a], [b]) => (a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b)));
	});

	function href(g: TagGroup): string {
		const q = new URLSearchParams({ n: g.name });
		if (kind === 'mood') q.set('kind', 'mood');
		return `/genres/${encodeURIComponent(g.ids.join(','))}?${q}`;
	}

	function jump(letter: string) {
		document.getElementById(`tag-${letter}`)?.scrollIntoView({ block: 'start' });
	}

	function setTab(t: 'genres' | 'moods') {
		void goto(t === 'moods' ? '/genres?tab=moods' : '/genres', { replaceState: true });
	}
</script>

<section class="page">
	<h1>{kind === 'mood' ? 'Moods' : 'Genres'}</h1>
	<div class="tabs" role="tablist">
		<button role="tab" class:sel={kind === 'genre'} aria-selected={kind === 'genre'} onclick={() => setTab('genres')}>
			Genres
		</button>
		<button role="tab" class:sel={kind === 'mood'} aria-selected={kind === 'mood'} onclick={() => setTab('moods')}>
			Moods
		</button>
	</div>
	<LibraryChips />

	{#if loading}
		<div class="center">
			<div class="spinner" aria-hidden="true"></div>
			<p class="dim">Sorting out your {kind === 'mood' ? 'moods' : 'genres'}…</p>
		</div>
	{:else if error}
		<p class="err">{error}</p>
	{:else if !groups.length}
		<p class="dim">No {kind === 'mood' ? 'moods' : 'genres'} in this library.</p>
	{:else}
		<h2 class="section-title">{kind === 'mood' ? 'Most used' : 'Your biggest genres'}</h2>
		<div class="pills big">
			{#each top as g (g.id)}
				<a class="pill" href={href(g)}>{g.name}<span class="n">{g.count}</span></a>
			{/each}
		</div>

		{#if kind === 'genre'}
			{#if letters.length > 6}
				<nav class="letters" aria-label="Jump to letter">
					{#each letters as [letter] (letter)}
						<button onclick={() => jump(letter)}>{letter}</button>
					{/each}
				</nav>
			{/if}
		{/if}

		{#each letters as [letter, list] (letter)}
			<h2 id="tag-{letter}">{letter}</h2>
			<div class="pills">
				{#each list as g (g.id)}
					<a class="pill" href={href(g)}>{g.name}<span class="n">{g.count}</span></a>
				{/each}
			</div>
		{/each}

		{#if hiddenCount > 0}
			<button class="more" onclick={() => (showAll = !showAll)}>
				{showAll ? 'Show fewer' : `Show all (${hiddenCount} more)`}
			</button>
		{/if}
	{/if}
</section>

<style>
	.tabs {
		display: inline-flex;
		gap: 0.25rem;
		padding: 0.25rem;
		margin-bottom: 1rem;
		border-radius: 999px;
		background: var(--surface);
	}
	.tabs button {
		min-height: 2.75rem;
		padding: 0 1.4rem;
		border-radius: 999px;
		color: var(--text-dim);
		font-weight: 700;
	}
	.tabs button.sel {
		background: var(--accent);
		color: #fff;
	}
	.section-title {
		margin: 0.5rem 0 0.75rem;
		font-size: 1.1rem;
		color: var(--text);
	}
	.letters {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin: 1.5rem 0 0.5rem;
	}
	.letters button {
		min-width: 2.75rem;
		min-height: 2.75rem;
		border-radius: 0.6rem;
		background: var(--surface);
		color: var(--text);
		font-weight: 700;
	}
	h2 {
		margin: 1.5rem 0 0.75rem;
		font-size: 1.1rem;
		color: var(--text-dim);
		scroll-margin-top: 1rem;
	}
	.pills {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 3.25rem;
		padding: 0 1.3rem;
		border-radius: 999px;
		background: var(--surface);
		color: var(--text);
		font-size: 1.05rem;
		font-weight: 600;
		text-decoration: none;
	}
	.pills.big .pill {
		min-height: 3.75rem;
		font-size: 1.15rem;
		background: var(--bg-elevated);
		border: 1px solid var(--surface);
	}
	.n {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-dim);
	}
	.more {
		margin-top: 1.5rem;
		min-height: 3rem;
		padding: 0 1.4rem;
		border-radius: 999px;
		background: var(--surface);
		color: var(--text);
		font-weight: 600;
	}
	.center {
		display: grid;
		place-items: center;
		gap: 0.75rem;
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
