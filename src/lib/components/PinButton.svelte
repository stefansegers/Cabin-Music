<script lang="ts">
	// "Pin to Home" toggle for folders, genres, playlists and albums.
	import { isPinned, togglePin, type Pin } from '$lib/stores/pins.svelte';
	import Icon from './Icon.svelte';

	let { pin }: { pin: Omit<Pin, 'pinnedAt'> } = $props();

	const pinned = $derived(isPinned(pin.id));
</script>

<button
	class="pin-btn"
	class:pinned
	onclick={() => togglePin(pin)}
	aria-pressed={pinned}
	title={pinned ? 'Unpin from Home' : 'Pin to Home'}
>
	<Icon name={pinned ? 'pin-filled' : 'pin'} size={18} />
	{pinned ? 'Pinned' : 'Pin'}
</button>

<style>
	.pin-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 3.25rem;
		padding: 0 1.4rem;
		border-radius: 999px;
		background: var(--surface);
		color: var(--text);
		font-size: 1rem;
		font-weight: 600;
	}
	.pin-btn.pinned {
		color: var(--accent);
	}
</style>
