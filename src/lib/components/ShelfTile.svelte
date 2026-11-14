<script lang="ts">
	// Home shelf tile for pins and "Continue listening": artwork (or an icon when there is none),
	// title/subtitle, an optional progress bar, and an optional round play button for one-tap play.
	import Art from './Art.svelte';
	import Icon from './Icon.svelte';

	let {
		title,
		subtitle = '',
		thumb,
		icon = 'folder',
		size = 168,
		progress,
		onOpen,
		onPlay
	}: {
		title: string;
		subtitle?: string;
		thumb?: string | null;
		icon?: string;
		size?: number;
		progress?: number; // 0..1
		onOpen: () => void;
		onPlay?: () => void;
	} = $props();

	let busy = $state(false);
	async function play(e: MouseEvent) {
		e.stopPropagation();
		if (!onPlay || busy) return;
		busy = true;
		try {
			await onPlay();
		} finally {
			busy = false;
		}
	}
</script>

<div class="tile">
	<div class="art">
		<button class="open-art" onclick={onOpen} title={title} tabindex="-1" aria-hidden="true">
			{#if thumb}
				<Art {thumb} w={size * 2} />
			{:else}
				<div class="ph"><Icon name={icon} size={44} /></div>
			{/if}
		</button>
		{#if progress !== undefined}
			<div class="bar"><div class="fill" style="width: {Math.round(progress * 100)}%"></div></div>
		{/if}
		{#if onPlay}
			<button class="play" onclick={play} aria-label="Play {title}" disabled={busy}>
				<Icon name="play" size={22} />
			</button>
		{/if}
	</div>
	<button class="open" onclick={onOpen}>
		<span class="title">{title}</span>
		{#if subtitle}<span class="sub">{subtitle}</span>{/if}
	</button>
</div>

<style>
	.tile {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.open-art {
		display: block;
		width: 100%;
		height: 100%;
		padding: 0;
	}
	.open {
		width: 100%;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
		color: var(--text);
		text-align: left;
	}
	.art {
		position: relative;
		width: 100%;
		aspect-ratio: 1 / 1;
		border-radius: 0.625rem;
		overflow: hidden;
		background: var(--surface);
	}
	.ph {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		color: var(--accent);
		background: linear-gradient(135deg, var(--surface), var(--bg-elevated));
	}
	.bar {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 0.35rem;
		background: rgba(0, 0, 0, 0.45);
	}
	.fill {
		height: 100%;
		background: var(--accent);
	}
	.title,
	.sub {
		max-width: 100%;
	}
	.title {
		font-size: 0.95rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sub {
		font-size: 0.85rem;
		color: var(--text-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.play {
		position: absolute;
		right: 0.5rem;
		bottom: 0.85rem; /* bottom-right of the artwork, above the progress bar */
		width: 3.25rem;
		height: 3.25rem;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--accent);
		color: #fff;
		box-shadow: 0 0.25rem 0.75rem rgba(0, 0, 0, 0.35);
	}
	.play:disabled {
		opacity: 0.7;
	}
</style>
