<script lang="ts">
	// Quick library switcher for browse pages (Folders, Genres): one tap to jump between music
	// libraries without going through Settings. Hidden when there is only one library.
	import { library, setActive } from '$lib/stores/library.svelte';

	let { onchange }: { onchange?: (id: string) => void } = $props();

	function pick(id: string) {
		if (id === library.activeId) return;
		setActive(id);
		onchange?.(id);
	}
</script>

{#if library.sections.length > 1}
	<div class="chips" role="tablist" aria-label="Library">
		{#each library.sections as s (s.key)}
			<button
				class="chip"
				class:active={s.key === library.activeId}
				role="tab"
				aria-selected={s.key === library.activeId}
				onclick={() => pick(s.key)}
			>
				{s.title}
			</button>
		{/each}
	</div>
{/if}

<style>
	.chips {
		display: flex;
		gap: 0.5rem;
		overflow-x: auto;
		padding-bottom: 0.25rem;
		margin-bottom: 1.25rem;
		scrollbar-width: none;
	}
	.chip {
		flex: 0 0 auto;
		min-height: 2.75rem;
		padding: 0 1.1rem;
		border-radius: 999px;
		background: var(--surface);
		color: var(--text);
		font-weight: 600;
		white-space: nowrap;
	}
	.chip.active {
		background: var(--accent);
		color: #fff;
	}
</style>
