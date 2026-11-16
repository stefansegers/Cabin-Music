<script lang="ts">
	import {
		decadeOpts,
		setSkipCompilations,
		toggleDecade,
		buildDecades,
		cachedDecades,
		type Decade
	} from '$lib/plex/decades.svelte';
	import { library, setActive, activeSection } from '$lib/stores/library.svelte';
	import { theme, setTheme, type ThemeChoice } from '$lib/stores/theme.svelte';
	import { drive, setDrive, type Drive } from '$lib/stores/drive.svelte';
	import { scale, setScale, SCALES } from '$lib/stores/scale.svelte';
	import {
		quality,
		setQuality,
		QUALITY_LABEL,
		QUALITY_KBPS,
		type Quality
	} from '$lib/stores/quality.svelte';
	import {
		invalidatePrefetch,
		keepAlive,
		setKeepAlive,
		autoplay,
		setAutoplay,
		gapless,
		setGapless,
		smooth,
		setSmooth,
		type KeepAlive
	} from '$lib/stores/player.svelte';
	import { session } from '$lib/stores/session.svelte';
	import { toggleDebug } from '$lib/stores/debug.svelte';
	import { flowOpts, setFlow } from '$lib/plex/keytags.svelte';
	import { mixOpts, setExcludeMixes, notMixIds, setNotMix, mixReleaseById } from '$lib/plex/mixes.svelte';
	import { signOut } from '$lib/plex/auth';

	const themes: ThemeChoice[] = ['auto', 'light', 'dark'];
	const drives: { id: Drive; label: string }[] = [
		{ id: 'lhd', label: 'Left' },
		{ id: 'rhd', label: 'Right' }
	];
	const qualities: Quality[] = ['original', 'high', 'medium', 'low'];
	const keepModes: { id: KeepAlive; label: string }[] = [
		{ id: 'tone', label: 'Inaudible tone' },
		{ id: 'silent', label: 'Silence' },
		{ id: 'off', label: 'Off' }
	];

	// The decades the active library has music for (same list Home shows).
	let decadeList = $state<Decade[]>([]);
	$effect(() => {
		const sec = activeSection();
		if (!sec) return;
		decadeList = cachedDecades(sec.key) ?? [];
		const ctrl = new AbortController();
		buildDecades(sec.key, ctrl.signal)
			.then((d) => {
				if (!ctrl.signal.aborted) decadeList = d;
			})
			.catch(() => {});
		return () => ctrl.abort();
	});

	function pickQuality(q: Quality) {
		setQuality(q);
		invalidatePrefetch(); // next track re-primes at the new quality
	}
</script>

<section class="page settings">
	<h1>Settings</h1>

	<div class="group">
		<h2>Library</h2>
		<p class="dim">Cabin shows one music library at a time.</p>
		<div class="chips">
			{#each library.sections as s (s.key)}
				<button class="chip" class:sel={s.key === library.activeId} onclick={() => setActive(s.key)}>
					{s.title}
				</button>
			{/each}
		</div>
	</div>

	<div class="group">
		<h2>Appearance</h2>
		<div class="seg">
			{#each themes as t (t)}
				<button class="seg-btn" class:sel={theme.choice === t} onclick={() => setTheme(t)}>{t}</button>
			{/each}
		</div>
	</div>

	<div class="group">
		<h2>Display size</h2>
		<p class="dim">Scales the whole interface. Turn it down if everything looks too big on your screen.</p>
		<div class="seg">
			{#each SCALES as s (s)}
				<button class="seg-btn" class:sel={scale.value === s} onclick={() => setScale(s)}>
					{Math.round(s * 100)}%
				</button>
			{/each}
		</div>
	</div>

	<div class="group">
		<h2>Driver side</h2>
		<p class="dim">
			Right-hand drive moves the menu and the on-screen controls to the side nearest you.
		</p>
		<div class="seg">
			{#each drives as d (d.id)}
				<button class="seg-btn" class:sel={drive.side === d.id} onclick={() => setDrive(d.id)}>
					{d.label}
				</button>
			{/each}
		</div>
	</div>

	<div class="group">
		<h2>Audio quality</h2>
		<p class="dim">
			Original streams your files untouched — lossless if your library is FLAC/ALAC. The lower
			settings transcode to MP3 to save data on cellular or relay connections.
		</p>
		<div class="seg">
			{#each qualities as q (q)}
				<button class="seg-btn" class:sel={quality.choice === q} onclick={() => pickQuality(q)}>
					{QUALITY_LABEL[q]}{#if q !== 'original'}&nbsp;· {QUALITY_KBPS[q]}k{/if}
				</button>
			{/each}
		</div>
	</div>

	<div class="group">
		<h2>Autoplay</h2>
		<p class="dim">
			When an album, folder or song ends, keep playing music that sounds like it (Plex sonic
			analysis), so there's never silence.
		</p>
		<div class="seg">
			<button class="seg-btn" class:sel={autoplay.on} onclick={() => setAutoplay(true)}>On</button>
			<button class="seg-btn" class:sel={!autoplay.on} onclick={() => setAutoplay(false)}>Off</button>
		</div>
	</div>

	{#if decadeList.length}
		<div class="group">
			<h2>Decades on Home</h2>
			<p class="dim">Which decade stations show on Home. Tap to turn one on or off.</p>
			<div class="seg">
				{#each decadeList as d (d.id)}
					<button
						class="chip"
						class:sel={!decadeOpts.hidden.includes(d.start)}
						aria-pressed={!decadeOpts.hidden.includes(d.start)}
						onclick={() => toggleDecade(d.start)}>{d.label}</button
					>
				{/each}
			</div>
		</div>
	{/if}

	<div class="group">
		<h2>Decade radio: skip compilations</h2>
		<p class="dim">
			Plex only knows the year of the album, so a 1985 hit on a 2003 compilation would count as the
			2000s. With this on, the Decades stations leave out albums that look back — best-ofs,
			"classics", "back to the 80s" — but keep compilations from the decade itself.
		</p>
		<div class="seg">
			<button class="seg-btn" class:sel={decadeOpts.skipCompilations} onclick={() => setSkipCompilations(true)}>On</button>
			<button class="seg-btn" class:sel={!decadeOpts.skipCompilations} onclick={() => setSkipCompilations(false)}>Off</button>
		</div>
	</div>

	<div class="group">
		<h2>Gapless albums</h2>
		<p class="dim">
			Tracks of the same album — DJ mixes split into tracks, live albums — flow into each other
			without a pause. FLAC albums play the original files, lossless; other formats stream as MP3.
			If the car's media controls misbehave, turn it off.
		</p>
		<div class="seg">
			<button class="seg-btn" class:sel={gapless.on} onclick={() => setGapless(true)}>On</button>
			<button class="seg-btn" class:sel={!gapless.on} onclick={() => setGapless(false)}>Off</button>
		</div>
	</div>

	<div class="group">
		<h2>Mixes & live albums</h2>
		<p class="dim">
			Tracks from DJ mixes, megamixes and live albums run into each other, so a single one on its own
			starts and stops mid-flow. Cabin recognises them by how their tracks end, keeps them out of
			radio, autoplay, Daily Mixes and decades, and lists them under "Mixes & live" on Home, where
			they play as a whole, gapless.
		</p>
		<div class="seg">
			<button class="seg-btn" class:sel={mixOpts.exclude} onclick={() => setExcludeMixes(true)}>Keep out of radio</button>
			<button class="seg-btn" class:sel={!mixOpts.exclude} onclick={() => setExcludeMixes(false)}>Mix in</button>
		</div>
		{#if notMixIds().length}
			<p class="dim">Marked "not a mix" (tap to undo):</p>
			<div class="seg">
				{#each notMixIds() as id (id)}
					<button class="seg-btn" onclick={() => setNotMix(id, false)}>
						{mixReleaseById(id)?.title ?? id.split('/').pop()} ✕
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<div class="group">
		<h2>Songs that mix well</h2>
		<p class="dim">
			When autoplay or Song radio picks what comes next, it prefers a song in the same or a
			neighbouring key on the Camelot wheel, at a similar tempo, so one song flows into the next.
			Uses the BPM and key from Mixed In Key; without those it picks as before.
		</p>
		<div class="seg">
			<button class="seg-btn" class:sel={flowOpts.on} onclick={() => setFlow(true)}>On</button>
			<button class="seg-btn" class:sel={!flowOpts.on} onclick={() => setFlow(false)}>Off</button>
		</div>
	</div>

	<div class="group">
		<h2>Smooth transitions</h2>
		<p class="dim">
			When a song fades out, the next one starts as soon as it has gone quiet, instead of after the
			fade or trailing silence, and silence at the start of a song is skipped. Uses Plex's loudness
			analysis. Songs of the same album are left to play as they were made.
		</p>
		<div class="seg">
			<button class="seg-btn" class:sel={smooth.on} onclick={() => setSmooth(true)}>On</button>
			<button class="seg-btn" class:sel={!smooth.on} onclick={() => setSmooth(false)}>Off</button>
		</div>
	</div>

	<div class="group">
		<h2>Between tracks</h2>
		<p class="dim">
			Cabin plays a signal you can't hear alongside the music, so the car doesn't switch back to its
			own media between songs or stop the queue when the browser is closed. If that misbehaves, try
			Silence, then Off.
		</p>
		<div class="seg">
			{#each keepModes as k (k.id)}
				<button class="seg-btn" class:sel={keepAlive.mode === k.id} onclick={() => setKeepAlive(k.id)}>
					{k.label}
				</button>
			{/each}
		</div>
	</div>

	<div class="group">
		<h2>Connection</h2>
		<dl class="info">
			<dt>Server</dt>
			<dd>{session.active?.serverName ?? '—'}</dd>
			<dt>Type</dt>
			<dd>{session.active?.connType ?? '—'}</dd>
			<dt>Account</dt>
			<dd>{session.account?.username ?? session.account?.title ?? '—'}</dd>
		</dl>
		<button class="danger" onclick={signOut}>Sign out</button>
	</div>

	<div class="group">
		<h2>Diagnostics</h2>
		<p class="dim">Connection status, recent network calls, and errors — handy if something will not load.</p>
		<button class="diag" onclick={toggleDebug}>Open diagnostics</button>
	</div>
</section>

<style>
	.settings {
		max-width: 47.5rem;
	}
	.group {
		margin-bottom: 2.5rem;
	}
	h2 {
		margin: 0 0 0.75rem;
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-dim);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.chips,
	.seg {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}
	.chip,
	.seg-btn {
		min-height: 3.5rem;
		padding: 0 1.25rem;
		border-radius: 999px;
		background: var(--surface);
		color: var(--text);
		font-size: 1rem;
		font-weight: 600;
	}
	.seg-btn {
		text-transform: capitalize;
	}
	.chip.sel,
	.seg-btn.sel {
		background: var(--accent);
		color: #fff;
	}
	.info {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.4rem 1.5rem;
		margin: 0 0 1.5rem;
	}
	.info dt {
		color: var(--text-dim);
	}
	.info dd {
		margin: 0;
		word-break: break-word;
	}
	.danger,
	.diag {
		min-height: var(--tap-min);
		padding: 0 2rem;
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--accent);
		font-size: 1.05rem;
		font-weight: 600;
	}
	.diag {
		color: var(--text);
	}
	.dim {
		margin: 0 0 0.75rem;
	}
</style>
