<script lang="ts">
	import {
		player,
		currentTrack,
		toggle,
		next,
		prev,
		seek,
		skipBy,
		cycleRepeat,
		toggleShuffle,
		toggleExpanded,
		jumpTo,
		removeAt,
		moveQueueItem,
		playTrackRadio
	} from '$lib/stores/player.svelte';
	import Art from './Art.svelte';
	import Icon from './Icon.svelte';
	import Seekbar from './Seekbar.svelte';
	import { artUrl } from '$lib/plex/media';
	import { isLoved, toggleLove } from '$lib/stores/ratings.svelte';
	import { scale } from '$lib/stores/scale.svelte';

	let showQueue = $state(false);

	// Wide, landscape screens (the car): the queue sits beside the current song instead of replacing
	// it. Pixels, not rem: the display-size setting scales rem, and the screen itself doesn't change.
	const WIDE_QUERY = '(min-width: 900px) and (min-aspect-ratio: 6/5)';
	let wide = $state(typeof matchMedia !== 'undefined' && matchMedia(WIDE_QUERY).matches);
	$effect(() => {
		const mq = matchMedia(WIDE_QUERY);
		const on = () => (wide = mq.matches);
		mq.addEventListener('change', on);
		return () => mq.removeEventListener('change', on);
	});

	// Keep the playing song near the top of the queue list as the queue moves on.
	let queueEl = $state<HTMLElement | null>(null);
	$effect(() => {
		void player.index;
		const el = queueEl;
		if (!el) return;
		requestAnimationFrame(() => {
			const active = el.querySelector<HTMLElement>('li.active');
			if (active) el.scrollTo({ top: Math.max(0, active.offsetTop - el.offsetTop - 8), behavior: 'smooth' });
		});
	});

	// Song radio: a tap replaces what's next with music like this song. A short note says where the
	// music comes from, so it's clear the tap did something (the song itself keeps playing).
	let radioBusy = $state(false);
	let radioNote = $state<string | null>(null);
	let noteTimer: ReturnType<typeof setTimeout> | undefined;
	async function startRadio() {
		if (radioBusy || !track) return;
		radioBusy = true;
		const r = await playTrackRadio(track);
		radioBusy = false;
		radioNote = !r
			? 'No radio found for this song'
			: r.source === 'sonic'
				? 'Radio on · songs that sound like this'
				: r.source === 'artist'
					? `Radio on · ${r.label ?? 'artist'} radio`
					: r.source === 'genre'
						? `Radio on · more ${r.label ?? 'of this genre'}`
						: 'Radio on · from your library';
		clearTimeout(noteTimer);
		noteTimer = setTimeout(() => (radioNote = null), 3500);
	}

	const track = $derived(currentTrack());
	const artThumb = $derived(track?.parentThumb ?? track?.thumb ?? null);
	const bgArt = $derived(artThumb ? artUrl(artThumb, 480) : null); // blurred UltraBlur backdrop
	const artistHref = $derived(
		track?.grandparentRatingKey ? `/artist/${track.grandparentRatingKey}` : null
	);
	const albumHref = $derived(track?.parentRatingKey ? `/album/${track.parentRatingKey}` : null);
	const loved = $derived(isLoved(track));

	function collapse() {
		player.expanded = false;
	}

	// --- swipe-down to dismiss ---
	const DISMISS_PX = 110;
	let dragY = $state(0);
	let dragging = $state(false);
	let axisLocked = false;
	let startX = 0;
	let startY = 0;

	function onDown(e: PointerEvent) {
		if (showQueue) return; // queue view scrolls vertically — don't hijack it
		// Ignore drags that begin on an interactive control (buttons, seekbar, links).
		if ((e.target as Element).closest('button, a, input, [role="slider"], .queue')) return;
		startX = e.clientX;
		startY = e.clientY;
		dragging = true;
		axisLocked = false;
	}
	function onMove(e: PointerEvent) {
		if (!dragging) return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;
		if (!axisLocked) {
			if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
			axisLocked = true;
			if (Math.abs(dx) > Math.abs(dy)) {
				dragging = false; // horizontal intent → not a dismiss
				return;
			}
		}
		dragY = Math.max(0, dy); // follow the finger downward only
	}
	function onUp() {
		if (!dragging) return;
		dragging = false;
		const dismiss = dragY > DISMISS_PX * scale.value; // threshold tracks the UI scale
		dragY = 0;
		if (dismiss) toggleExpanded();
	}
</script>

<div
	class="np"
	class:queueview={showQueue && !wide}
	class:wide
	role="dialog"
	aria-label="Now playing"
	tabindex="-1"
	style="transform: translateY({dragY}px); transition: transform {dragging ? '0s' : '0.28s ease'}; touch-action: {showQueue && !wide
		? 'auto'
		: 'none'};"
	onpointerdown={onDown}
	onpointermove={onMove}
	onpointerup={onUp}
	onpointercancel={onUp}
>
	{#if bgArt}
		<div class="np-bg" style="background-image: url('{bgArt}')"></div>
		<div class="np-scrim"></div>
	{/if}
	<button class="close" onclick={toggleExpanded} aria-label="Close"><Icon name="chevron-down" size={32} /></button>

	{#snippet radioButton(extra: string)}
		<button
			class="radiobtn pill {extra}"
			class:busy={radioBusy}
			onclick={startRadio}
			disabled={radioBusy}
			aria-label="Start radio from this song"
		>
			<Icon name="radio" size={30} /><span>{radioBusy ? 'Finding…' : 'Song radio'}</span>
		</button>
	{/snippet}

	{#snippet queuePanel()}
		<div class="qhead">
			<h2>Up Next</h2>
			{#if wide}{@render radioButton('inline')}{/if}
		</div>
		{#if wide && radioNote}<div class="radionote inline" role="status">{radioNote}</div>{/if}
		<div class="queue" bind:this={queueEl}>
			<ol>
				{#each player.queue as t, i (t.playQueueItemID ?? `${t.ratingKey}:${i}`)}
					<li class:active={i === player.index}>
						<button class="qmain" onclick={() => jumpTo(i)}>
							<span class="qidx">
								{#if i === player.index}<Icon name={player.playing ? 'pause' : 'play'} size={14} />{:else}{i + 1}{/if}
							</span>
							<span class="qtext">
								<span class="qtitle">{t.title}</span>
								{#if t.grandparentTitle}<span class="qartist">{t.grandparentTitle}</span>{/if}
							</span>
						</button>
						<div class="qactions">
							<button onclick={() => moveQueueItem(i, i - 1)} disabled={i === 0} aria-label="Move up">
								<Icon name="arrow-up" size={20} />
							</button>
							<button onclick={() => moveQueueItem(i, i + 1)} disabled={i === player.queue.length - 1} aria-label="Move down">
								<Icon name="arrow-down" size={20} />
							</button>
							<button onclick={() => removeAt(i)} aria-label="Remove from queue">
								<Icon name="x" size={20} />
							</button>
						</div>
					</li>
				{/each}
			</ol>
		</div>
	{/snippet}

	{#snippet nowInfo()}
		<div class="art"><Art thumb={artThumb} w={1000} /></div>

		<div class="info">
			<h1>{track?.title}</h1>
			<p>{#if artistHref}<a class="artist" href={artistHref} onclick={collapse}>{track?.grandparentTitle}</a>{:else}<span class="artist">{track?.grandparentTitle ?? ''}</span>{/if}{#if track?.parentTitle}<span class="sep">·</span>{#if albumHref}<a class="album" href={albumHref} onclick={collapse}>{track.parentTitle}</a>{:else}<span class="album">{track.parentTitle}</span>{/if}{/if}</p>
		</div>

		<div class="seek"><Seekbar current={player.currentTime} duration={player.duration} onseek={seek} /></div>
		<div class="skips">
			<button class="skip" onclick={() => skipBy(-30)} aria-label="Back 30 seconds"><Icon name="back30" size={40} /></button>
			<button class="skip" onclick={() => skipBy(30)} aria-label="Forward 30 seconds"><Icon name="fwd30" size={40} /></button>
		</div>
	{/snippet}

	{#snippet controls()}
		<div class="controls">
			<button class="sec" class:on={loved} onclick={() => toggleLove(track)} aria-label={loved ? 'Unlove' : 'Love'}>
				<Icon name={loved ? 'heart-filled' : 'heart'} size={26} />
			</button>
			<button class="sec" class:on={player.shuffle} onclick={toggleShuffle} aria-label="Shuffle">
				<Icon name="shuffle" size={26} />
			</button>
			<button class="ctl" onclick={prev} aria-label="Previous"><Icon name="prev" size={34} /></button>
			<button class="play" onclick={toggle} aria-label={player.playing ? 'Pause' : 'Play'}>
				<Icon name={player.playing ? 'pause' : 'play'} size={42} />
			</button>
			<button class="ctl" onclick={() => next()} aria-label="Next"><Icon name="next" size={34} /></button>
			<button class="sec" class:on={player.repeat !== 'off'} onclick={cycleRepeat} aria-label="Repeat">
				<Icon name="repeat" size={26} />
				{#if player.repeat === 'one'}<span class="one">1</span>{/if}
			</button>
		</div>
	{/snippet}

	{#if wide}
		<div class="main">
			{@render nowInfo()}
			{@render controls()}
		</div>
		<aside class="side" aria-label="Up next">
			{@render queuePanel()}
		</aside>
	{:else}
		<button class="queuebtn pill" class:on={showQueue} onclick={() => (showQueue = !showQueue)} aria-label="Queue">
			<Icon name="queue" size={30} /><span>Up next</span>
		</button>
		{@render radioButton('corner')}
		{#if radioNote}<div class="radionote" role="status">{radioNote}</div>{/if}

		{#if showQueue}
			{@render queuePanel()}
		{:else}
			{@render nowInfo()}
		{/if}
		{@render controls()}
	{/if}
</div>

<style>
	.np {
		position: fixed;
		inset: 0;
		z-index: 200;
		background: var(--bg);
		overflow: hidden;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: clamp(1rem, 2.5vh, 2rem);
		padding: 5.5rem clamp(1.5rem, 4vw, 3rem) clamp(1.5rem, 4vw, 3rem);
	}
	/* UltraBlur: the album art, scaled up + heavily blurred, with a theme-aware scrim for legibility. */
	.np-bg {
		position: absolute;
		inset: 0;
		z-index: -1;
		background-size: cover;
		background-position: center;
		filter: blur(4rem) saturate(1.5);
		transform: scale(1.3);
		opacity: 0.7;
	}
	.np-scrim {
		position: absolute;
		inset: 0;
		z-index: -1;
		background: var(--np-scrim);
	}
	/* When the queue is open, content flows from the top and the list scrolls. */
	.np.queueview {
		justify-content: flex-start;
		gap: 1rem;
	}
	.close,
	.queuebtn,
	.radiobtn.corner {
		position: absolute;
		width: 4rem;
		height: 4rem;
		border-radius: 50%;
		display: grid;
		place-items: center;
		color: var(--text);
		background: var(--surface);
		z-index: 1;
	}
	.close {
		top: 1.25rem;
		left: 1.25rem;
	}
	/* Corner buttons with a label, so it's obvious what they do (an icon alone was easy to miss). */
	.np .pill {
		width: auto;
		height: 4.5rem;
		padding: 0 1.5rem 0 1.25rem;
		border-radius: 2.25rem;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-size: 1.15rem;
		font-weight: 600;
		white-space: nowrap;
	}
	/* Narrow screens: keep the controls clear of the corner buttons. */
	.np:not(.wide) {
		padding-bottom: 7rem;
	}
	.pill.busy {
		opacity: 0.6;
	}
	.radionote {
		position: absolute;
		bottom: 6.75rem;
		right: 1.25rem;
		z-index: 1;
		padding: 0.75rem 1.1rem;
		border-radius: 0.9rem;
		background: var(--surface);
		color: var(--text);
		font-size: 1.05rem;
		font-weight: 600;
		box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 0.3);
	}
	:global([data-drive='rhd']) .radionote {
		right: auto;
		left: 1.25rem;
	}
	.queuebtn {
		bottom: 1.25rem;
		left: 1.25rem;
		color: var(--text-dim);
	}
	.queuebtn.on {
		color: var(--accent);
	}
	.radiobtn {
		color: var(--text);
		background: var(--surface);
	}
	.radiobtn.corner {
		bottom: 1.25rem;
		right: 1.25rem;
	}
	/* Right-hand drive: mirror the corner controls to the side nearest the driver (the right). */
	:global([data-drive='rhd']) .close,
	:global([data-drive='rhd']) .queuebtn {
		left: auto;
		right: 1.25rem;
	}
	:global([data-drive='rhd']) .radiobtn.corner {
		right: auto;
		left: 1.25rem;
	}
	/* As big as the screen allows (up to ~560 px, whatever the display size): the screen height minus
	   what sits above and below it (title, seekbar, controls, padding). */
	.art {
		width: max(10rem, min(100%, calc(100vh - 30rem), 560px));
		flex: 0 0 auto;
		aspect-ratio: 1;
		border-radius: 1.125rem;
		overflow: hidden;
		background: var(--surface);
	}
	.info {
		text-align: center;
		max-width: 90vw;
	}
	.info h1 {
		margin: 0;
		font-size: clamp(1.5rem, 3.5vw, 2.4rem);
		font-weight: 700;
		letter-spacing: -0.02em;
	}
	.info p {
		margin: 0.4rem 0 0;
		color: var(--text-dim);
		font-size: clamp(1rem, 2vw, 1.3rem);
	}
	.info a {
		text-decoration: none;
	}
	.info .artist {
		color: var(--text);
	}
	.info .album {
		color: var(--text-dim);
	}
	.info .sep {
		margin: 0 0.55rem;
		color: var(--text-dim);
	}
	.seek {
		width: min(40rem, 92vw);
	}

	/* Wide screens: the song on the driver's side, the queue beside it. */
	.np.wide {
		flex-direction: row;
		align-items: stretch;
		gap: clamp(2rem, 4vw, 4rem);
		padding: 5.5rem clamp(2rem, 4vw, 3.5rem) clamp(1.5rem, 3vw, 2.5rem);
	}
	:global([data-drive='rhd']) .np.wide {
		flex-direction: row-reverse;
	}
	.main {
		flex: 1 1 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: clamp(1rem, 2.5vh, 2rem);
	}
	.np.wide .info {
		max-width: 100%;
	}
	.np.wide .seek,
	.np.wide .skips {
		width: min(40rem, 100%);
	}
	/* ±30s sit under the ends of the seekbar, pulled up into the gap so they read as part of it. */
	.skips {
		width: min(40rem, 92vw);
		display: flex;
		justify-content: space-between;
		margin-top: calc(-1 * clamp(0.5rem, 1.5vh, 1.25rem));
	}
	.skip {
		display: grid;
		place-items: center;
		width: 4.5rem;
		height: 4.5rem;
		border-radius: 50%;
		color: var(--text-dim);
	}
	.skip:active {
		color: var(--text);
		background: var(--surface);
	}
	.side {
		flex: 0 1 34rem;
		min-width: 22rem;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1.25rem;
		border-radius: 1.25rem;
		background: color-mix(in srgb, var(--surface) 55%, transparent);
	}
	.qhead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.qhead {
		width: 100%;
	}
	.qhead h2 {
		margin: 0;
		font-size: 1.1rem;
		color: var(--text-dim);
	}
	.side .qhead h2 {
		font-size: 1.35rem;
		color: var(--text);
	}
	.radionote.inline {
		position: static;
		box-shadow: none;
	}

	/* Queue panel */
	.queue {
		touch-action: pan-y;
		width: 100%;
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}
	.queue ol {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.queue li {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		border-radius: 0.625rem;
	}
	.queue li:nth-child(odd) {
		background: var(--stripe);
	}
	.qmain {
		flex: 1 1 auto;
		min-width: 0;
		display: grid;
		grid-template-columns: 2rem 1fr;
		align-items: center;
		gap: 0.85rem;
		min-height: 4.25rem;
		padding: 0.65rem 0.75rem;
		color: var(--text);
		text-align: left;
		font-size: 1.05rem;
	}
	.queue li.active .qmain,
	.queue li.active .qartist {
		color: var(--accent);
	}
	.qidx {
		color: var(--text-dim);
		display: grid;
		place-items: center;
		font-variant-numeric: tabular-nums;
	}
	.queue li.active .qidx {
		color: var(--accent);
	}
	.qtext {
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.qtitle,
	.qartist {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.qtitle {
		font-size: 1.1rem;
	}
	.qartist {
		font-size: 0.92rem;
		color: var(--text-dim);
	}
	.qactions {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
	}
	.qactions button {
		width: 3.25rem;
		height: 3.25rem;
		display: grid;
		place-items: center;
		color: var(--text-dim);
		border-radius: 0.5rem;
	}
	.qactions button:disabled {
		opacity: 0.3;
	}

	.controls {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: clamp(1rem, 3vw, 2rem);
	}
	.ctl {
		display: grid;
		place-items: center;
		width: 5rem;
		height: 5rem;
		border-radius: 50%;
		color: var(--text);
	}
	.play {
		display: grid;
		place-items: center;
		width: 7rem;
		height: 7rem;
		border-radius: 50%;
		background: var(--accent);
		color: #fff;
	}
	.sec {
		position: relative;
		display: grid;
		place-items: center;
		width: 4rem;
		height: 4rem;
		border-radius: 50%;
		color: var(--text-dim);
	}
	.sec.on {
		color: var(--accent);
	}
	.one {
		position: absolute;
		right: 0.75rem;
		bottom: 0.625rem;
		font-size: 0.7rem;
		font-weight: 700;
	}
</style>
