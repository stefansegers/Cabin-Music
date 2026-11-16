<script lang="ts" module>
	export interface Tile {
		id: string;
		title: string;
		subtitle?: string;
		thumb?: string | null;
		icon?: string;
		/** Draw a playlist cover (name / year on a colour band) instead of plain art. */
		playlist?: boolean;
		onPlay: () => void | Promise<void>;
		onOpen: () => void;
	}
</script>

<script lang="ts">
	// A Home row of ShelfTiles (cover = play, text = open its page), with an optional "›" title that
	// opens the full list.
	import ShelfTile from './ShelfTile.svelte';
	import Icon from './Icon.svelte';
	import PlaylistCover from './PlaylistCover.svelte';

	let { title, href, tiles, size = 168 }: { title: string; href?: string; tiles: Tile[]; size?: number } =
		$props();
</script>

<section class="shelf">
	<h2>
		{#if href}
			<a class="more" {href}>{title} <Icon name="chevron-right" size={20} /></a>
		{:else}
			{title}
		{/if}
	</h2>
	<div class="row">
		{#each tiles as t (t.id)}
			<div class="slot" style="width: {size / 16}rem">
				<ShelfTile
					title={t.title}
					subtitle={t.subtitle}
					thumb={t.thumb}
					icon={t.icon ?? 'album'}
					{size}
					onPlay={t.onPlay}
					onOpen={t.onOpen}
					cover={t.playlist ? plCover : undefined}
				/>
				{#snippet plCover()}<PlaylistCover title={t.title} thumb={t.thumb} {size} />{/snippet}
			</div>
		{/each}
	</div>
</section>

<style>
	.shelf {
		margin-bottom: 2rem;
	}
	h2 {
		margin: 0 0 0.85rem;
		font-size: clamp(1.05rem, 1.8vw, 1.3rem);
		font-weight: 600;
	}
	.more {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		min-height: 2.75rem;
		margin: -0.5rem -0.6rem;
		padding: 0 0.6rem;
		border-radius: 0.5rem;
		color: var(--text);
		text-decoration: none;
	}
	.more :global(svg) {
		color: var(--accent);
	}
	.more:active {
		background: var(--surface);
	}
	.row {
		display: flex;
		gap: 1rem;
		overflow-x: auto;
		padding-bottom: 0.25rem;
		scrollbar-width: none;
	}
	.row::-webkit-scrollbar {
		display: none;
	}
	.slot {
		flex: 0 0 auto;
	}
</style>
