<script lang="ts">
	// All album genres of the active library as big tappable pills, grouped by first letter.
	import { activeSection } from '$lib/stores/library.svelte';
	import { getGenres, type Genre } from '$lib/plex/library';
	import LibraryChips from '$lib/components/LibraryChips.svelte';

	const section = $derived(activeSection());

	let genres = $state<Genre[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	$effect(() => {
		const s = section?.key;
		if (!s) return;
		const ctrl = new AbortController();
		void load(s, ctrl.signal);
		return () => ctrl.abort();
	});

	async function load(sectionId: string, signal: AbortSignal) {
		loading = true;
		error = null;
		genres = [];
		try {
			const res = await getGenres(sectionId, signal);
			if (!signal.aborted) genres = res;
		} catch (e) {
			if (!signal.aborted) error = e instanceof Error ? e.message : String(e);
		} finally {
			if (!signal.aborted) loading = false;
		}
	}

	function letterOf(title: string): string {
		const c = title.trim().charAt(0).toUpperCase();
		return /[A-Z]/.test(c) ? c : '#';
	}

	// [letter, genres][] in display order ('#' for digits/symbols first).
	const groups = $derived.by(() => {
		const map = new Map<string, Genre[]>();
		for (const g of genres) {
			const l = letterOf(g.title);
			if (!map.has(l)) map.set(l, []);
			map.get(l)!.push(g);
		}
		return [...map.entries()].sort(([a], [b]) => (a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b)));
	});

	function href(g: Genre): string {
		return `/genres/${encodeURIComponent(g.key)}?n=${encodeURIComponent(g.title)}`;
	}

	function jump(letter: string) {
		document.getElementById(`genre-${letter}`)?.scrollIntoView({ block: 'start' });
	}
</script>

<section class="page">
	<h1>Genres</h1>
	<LibraryChips />

	{#if loading}
		<div class="center"><div class="spinner" aria-hidden="true"></div></div>
	{:else if error}
		<p class="err">{error}</p>
	{:else if !genres.length}
		<p class="dim">No genres in this library.</p>
	{:else}
		{#if groups.length > 6}
			<nav class="letters" aria-label="Jump to letter">
				{#each groups as [letter] (letter)}
					<button onclick={() => jump(letter)}>{letter}</button>
				{/each}
			</nav>
		{/if}

		{#each groups as [letter, list] (letter)}
			<h2 id="genre-{letter}">{letter}</h2>
			<div class="pills">
				{#each list as g (g.key)}
					<a class="pill" href={href(g)}>{g.title}</a>
				{/each}
			</div>
		{/each}
	{/if}
</section>

<style>
	.letters {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-bottom: 1rem;
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
		min-height: 3.25rem;
		padding: 0 1.4rem;
		border-radius: 999px;
		background: var(--surface);
		color: var(--text);
		font-size: 1.05rem;
		font-weight: 600;
		text-decoration: none;
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
