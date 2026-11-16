<script lang="ts">
	import type { Metadata } from '$lib/plex/types';
	import { player, currentTrack, playList, enqueueLast } from '$lib/stores/player.svelte';
	import { isLoved, toggleLove } from '$lib/stores/ratings.svelte';
	import Icon from './Icon.svelte';
	import { keyTags, hasKeyTags, camelotColor, camelotOrder } from '$lib/plex/keytags.svelte';

	type SortBy = 'order' | 'title' | 'artist' | 'bpm' | 'key';

	let {
		tracks,
		showArtist = false,
		discs = false,
		ordinal = false,
		sortable = false,
		view = $bindable()
	}: {
		tracks: Metadata[];
		showArtist?: boolean;
		discs?: boolean;
		/** Number rows 1, 2, 3… by position (lists that aren't one album: Plex's track numbers mislead). */
		ordinal?: boolean;
		/** Show the sort bar (order / title / artist / BPM / key). */
		sortable?: boolean;
		/** Out: the list as shown (sorted), so a Play button above can play it in that order. */
		view?: Metadata[];
	} = $props();

	let sortBy = $state<SortBy>('order');
	const SORTS: { id: SortBy; label: string; needsTags?: boolean }[] = [
		{ id: 'order', label: 'Order' },
		{ id: 'title', label: 'Title' },
		{ id: 'artist', label: 'Artist' },
		{ id: 'bpm', label: 'BPM', needsTags: true },
		{ id: 'key', label: 'Key', needsTags: true }
	];
	const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
	const shown = $derived.by(() => {
		if (sortBy === 'order') return tracks;
		const list = tracks.slice();
		const artist = (t: Metadata) => t.originalTitle ?? t.grandparentTitle ?? '';
		const bpm = (t: Metadata) => keyTags(t)?.bpm ?? 9999;
		const key = (t: Metadata) => camelotOrder(keyTags(t)?.key);
		if (sortBy === 'title') list.sort((a, b) => byText(a.title, b.title));
		else if (sortBy === 'artist') list.sort((a, b) => byText(artist(a), artist(b)) || byText(a.title, b.title));
		else if (sortBy === 'bpm') list.sort((a, b) => bpm(a) - bpm(b) || key(a) - key(b));
		else list.sort((a, b) => key(a) - key(b) || bpm(a) - bpm(b));
		return list;
	});
	$effect(() => {
		view = shown;
	});

	// Disc headings only when the list really spans more than one disc (and is in album order).
	const multiDisc = $derived(
		sortBy === 'order' && discs && new Set(tracks.map((t) => t.parentIndex ?? 1)).size > 1
	);

	const currentKey = $derived(currentTrack()?.ratingKey);

	// Brief "added to queue" confirmation per row (plus → check, then back).
	let added = $state<Record<string, boolean>>({});
	function addToQueue(t: Metadata) {
		enqueueLast(t);
		const rk = t.ratingKey;
		added[rk] = true;
		setTimeout(() => (added[rk] = false), 1300);
	}

	function fmt(ms?: number): string {
		if (!ms) return '';
		const s = Math.round(ms / 1000);
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}
</script>

{#if sortable && tracks.length > 1}
	<div class="sortbar" role="group" aria-label="Sort">
		<span class="sortlabel">Sort</span>
		{#each SORTS.filter((x) => !x.needsTags || hasKeyTags()) as o (o.id)}
			<button class="sortbtn" class:sel={sortBy === o.id} onclick={() => (sortBy = o.id)}>{o.label}</button>
		{/each}
	</div>
{/if}

<ol class="tracks">
	{#each shown as t, i (t.ratingKey)}
		{@const active = t.ratingKey === currentKey}
		{@const kt = keyTags(t)}
		{#if multiDisc && (t.parentIndex ?? 1) !== (shown[i - 1]?.parentIndex ?? (i ? 1 : 0))}
			<li class="disc">Disc {t.parentIndex ?? 1}</li>
		{/if}
		<li class:active>
			<button class="track" class:active onclick={() => playList(shown, i)}>
				<span class="idx">
					{#if active}
						<Icon name={player.playing ? 'pause' : 'play'} size={14} />
					{:else}
						{ordinal || sortBy !== 'order' ? i + 1 : (t.index ?? i + 1)}
					{/if}
				</span>
				<span class="main">
					<span class="title">{t.title}</span>
					{#if showArtist && (t.originalTitle ?? t.grandparentTitle)}<span class="artist"
							>{t.originalTitle ?? t.grandparentTitle}</span
						>{/if}
				</span>
				<span class="tail">
					{#if kt?.bpm}<span class="bpm">{kt.bpm}</span>{/if}
					{#if kt?.key}
						<span class="key" class:major={kt.key.endsWith('B')} style="--kc: {camelotColor(kt.key)}"
							>{kt.key}</span
						>
					{/if}
					<span class="dur">{fmt(t.duration)}</span>
				</span>
			</button>
			<button
				class="love"
				class:on={isLoved(t)}
				onclick={() => toggleLove(t)}
				aria-label={isLoved(t) ? 'Unlove' : 'Love'}
			>
				<Icon name={isLoved(t) ? 'heart-filled' : 'heart'} size={20} />
			</button>
			<button
				class="add"
				class:added={added[t.ratingKey]}
				onclick={() => addToQueue(t)}
				aria-label="Add to queue"
			>
				<Icon name={added[t.ratingKey] ? 'check' : 'plus'} size={20} />
			</button>
		</li>
	{/each}
</ol>

<style>
	.tracks {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li {
		display: flex;
		align-items: stretch;
		gap: 0.25rem;
		border-radius: 0.625rem;
	}
	li:nth-child(odd) {
		background: var(--stripe);
	}
	li.disc {
		background: none;
		padding: 1.1rem 0.9rem 0.5rem;
		color: var(--text-dim);
		font-size: 0.92rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.track {
		flex: 1 1 auto;
		min-width: 0;
		display: grid;
		grid-template-columns: 2.5rem 1fr auto;
		align-items: center;
		gap: 1rem;
		min-height: 4.25rem;
		padding: 0.7rem 0.9rem;
		border-radius: 0.625rem;
		color: var(--text);
		text-align: left;
		font-size: 1.05rem;
	}
	.track.active,
	.track.active .idx,
	.track.active .artist {
		color: var(--accent);
	}
	.idx {
		color: var(--text-dim);
		display: grid;
		place-items: center;
		font-variant-numeric: tabular-nums;
	}
	.main {
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.title {
		font-size: 1.1rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.artist {
		font-size: 0.92rem;
		color: var(--text-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.dur {
		color: var(--text-dim);
		font-variant-numeric: tabular-nums;
		min-width: 2.6rem;
		text-align: right;
	}
	.tail {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.bpm {
		color: var(--text-dim);
		font-size: 0.92rem;
		font-variant-numeric: tabular-nums;
	}
	/* Camelot key in the wheel's colour: keys that mix well look alike. */
	.key {
		min-width: 2.6rem;
		padding: 0.15rem 0.45rem;
		border-radius: 0.4rem;
		background: var(--kc);
		color: #fff;
		font-size: 0.9rem;
		font-weight: 700;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}
	.key.major {
		color: #10141a;
	}
	.sortbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 1rem;
	}
	.sortlabel {
		color: var(--text-dim);
		font-size: 0.9rem;
		margin-right: 0.25rem;
	}
	.sortbtn {
		min-height: 2.75rem;
		padding: 0 1.1rem;
		border-radius: 999px;
		background: var(--surface);
		color: var(--text);
		font-weight: 600;
	}
	.sortbtn.sel {
		background: var(--text);
		color: var(--bg);
	}
	@media (max-width: 600px) {
		.bpm {
			display: none;
		}
	}
	.love {
		flex: 0 0 auto;
		width: 3rem;
		display: grid;
		place-items: center;
		color: var(--text-dim);
		border-radius: 0.625rem;
	}
	.love.on {
		color: var(--accent);
	}
	/* Add-to-queue: a circular tap target, set well apart from the heart so it's hard to mis-tap. */
	.add {
		flex: 0 0 auto;
		align-self: center;
		width: 3.25rem;
		height: 3.25rem;
		margin-left: 1rem;
		display: grid;
		place-items: center;
		border-radius: 50%;
		background: var(--surface);
		color: var(--text);
		transition:
			background 0.15s ease,
			color 0.15s ease,
			transform 0.15s ease;
	}
	/* Brief confirmation flash when a track is added to the queue. */
	.add.added {
		background: var(--accent);
		color: #fff;
		transform: scale(1.08);
	}
</style>
