<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { afterNavigate, beforeNavigate } from '$app/navigation';
	import NavRail from './NavRail.svelte';
	import NowPlayingBar from './NowPlayingBar.svelte';
	import { restore } from '$lib/stores/player.svelte';
	import { preloadKeyTags } from '$lib/plex/keytags.svelte';
	import { session } from '$lib/stores/session.svelte';

	let { children } = $props();

	// Restore the last queue (paused) once we're connected and the shell is mounted.
	onMount(() => restore());
	// BPM / key / exact MP3 lengths: fetch as soon as a server is connected (see keytags.svelte.ts).
	$effect(() => {
		if (session.active?.machineId) preloadKeyTags();
	});

	// The page scrolls inside <main>, not the window, so SvelteKit's own scroll handling never sees
	// it: a new page opens at the top, and Back returns to where you were (e.g. on Home's shelves).
	let main: HTMLElement | undefined = $state();
	const scrollAt = new Map<string, number>();
	beforeNavigate(({ from }) => {
		if (from && main) scrollAt.set(from.url.href, main.scrollTop);
	});
	afterNavigate(async ({ to, type }) => {
		if (!main || type === 'enter') return;
		const y = type === 'popstate' ? (scrollAt.get(to?.url.href ?? '') ?? 0) : 0;
		await tick();
		main.scrollTop = y;
	});
</script>

<div class="app">
	<div class="row">
		<NavRail />
		<main class="content" bind:this={main}>
			{@render children()}
		</main>
	</div>
	<NowPlayingBar />
</div>

<style>
	.app {
		display: flex;
		flex-direction: column;
		height: 100dvh;
	}
	.row {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
	}
	/* Right-hand drive: move the nav rail to the side nearest the driver (the right). */
	:global([data-drive='rhd']) .row {
		flex-direction: row-reverse;
	}
	.content {
		flex: 1 1 auto;
		min-width: 0;
		height: 100%;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
</style>
