// Library browsing API (sections, hubs, artists/albums/tracks, playlists, search). All via serverFetch.

import { serverFetch } from './media';
import type { Hub, Metadata, PageResult, Section } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Plex `type` codes for the /all endpoint. */
export const TYPE = { artist: 8, album: 9, track: 10 } as const;

function container(data: any): any {
	return data?.MediaContainer ?? {};
}
function metas(c: any): Metadata[] {
	return Array.isArray(c.Metadata) ? c.Metadata : [];
}
function page(c: any, start: number): PageResult {
	return { items: metas(c), totalSize: c.totalSize ?? c.size ?? 0, offset: c.offset ?? start };
}
function mapHubs(c: any): Hub[] {
	const hubs: any[] = Array.isArray(c.Hub) ? c.Hub : [];
	return hubs
		.map((h) => ({
			hubIdentifier: h.hubIdentifier ?? '',
			title: h.title ?? '',
			type: h.type ?? '',
			size: h.size,
			more: h.more,
			// Items may arrive under Metadata[] OR Directory[] (mixes/stations use Directory) — check both.
			items: (Array.isArray(h.Metadata)
				? h.Metadata
				: Array.isArray(h.Directory)
					? h.Directory
					: []) as Metadata[]
		}))
		.filter((h) => h.items.length > 0);
}

/** Music library sections only (`type === 'artist'`). */
export async function getSections(signal?: AbortSignal): Promise<Section[]> {
	const data = await serverFetch<any>('/library/sections', { signal });
	const dirs: any[] = container(data).Directory ?? [];
	return dirs
		.filter((d) => d.type === 'artist')
		.map((d) => ({ key: String(d.key), type: d.type, title: d.title, uuid: d.uuid, thumb: d.thumb }));
}

/** Home hub rows for a section (Recently Added, Recently Played, Mixes, On This Day, …).
 *  `includeMyMixes` / `includeAnniversaryReleases` are OPT-IN — without them the server omits the
 *  "Mixes for You" and "On This Day" hubs entirely. includeStations/ExternalMedia=0 trims noise. */
export async function getHubs(sectionId: string, count = 12, signal?: AbortSignal): Promise<Hub[]> {
	const data = await serverFetch<any>(`/hubs/sections/${sectionId}`, {
		query: {
			count,
			includeStations: 0,
			includeExternalMedia: 0,
			includeMyMixes: 1,
			includeAnniversaryReleases: 1
		},
		signal
	});
	return mapHubs(container(data));
}

/** Paginated list of a section's artists(8)/albums(9)/tracks(10). */
export async function getAll(
	sectionId: string,
	opts: { type: number; start?: number; size?: number; sort?: string },
	signal?: AbortSignal
): Promise<PageResult> {
	const { type, start = 0, size = 60, sort = 'titleSort:asc' } = opts;
	const data = await serverFetch<any>(`/library/sections/${sectionId}/all`, {
		query: { type, sort, 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size },
		signal
	});
	return page(container(data), start);
}

/** Loved tracks (userRating = 10 / 5 stars) in a section — for the Home "Loved" row. */
export async function getLovedTracks(
	sectionId: string,
	opts: { size?: number } = {},
	signal?: AbortSignal
): Promise<PageResult> {
	const { size = 24 } = opts;
	const data = await serverFetch<any>(`/library/sections/${sectionId}/all`, {
		query: {
			type: TYPE.track,
			userRating: 10, // loved = 5 stars
			sort: 'lastViewedAt:desc',
			'X-Plex-Container-Start': 0,
			'X-Plex-Container-Size': size
		},
		signal
	});
	const res = page(container(data), 0);
	// Safety net in case a server ignores the filter — only show genuinely-loved tracks.
	res.items = res.items.filter((t) => (t.userRating ?? 0) >= 9.5);
	return res;
}

/** All of an artist's releases — albums, EPs, singles, live, compilations. A section search filtered
 *  by artist.id (what Plex/Plexamp use); unlike /metadata/{id}/children it returns every release type. */
export async function getArtistAlbums(
	sectionId: string,
	artistKey: string,
	opts: { size?: number; sort?: string } = {},
	signal?: AbortSignal
): Promise<PageResult> {
	const { size = 200, sort = 'year:desc' } = opts;
	const data = await serverFetch<any>(`/library/sections/${sectionId}/all`, {
		query: {
			type: TYPE.album,
			'artist.id': artistKey,
			sort,
			'X-Plex-Container-Start': 0,
			'X-Plex-Container-Size': size
		},
		signal
	});
	return page(container(data), 0);
}

/** Children of an item: artist → albums, album → tracks. */
export async function getChildren(
	ratingKey: string,
	opts: { start?: number; size?: number; sort?: string } = {},
	signal?: AbortSignal
): Promise<PageResult> {
	const { start = 0, size = 200, sort } = opts;
	const query: Record<string, string | number> = {
		'X-Plex-Container-Start': start,
		'X-Plex-Container-Size': size
	};
	if (sort) query.sort = sort;
	const data = await serverFetch<any>(`/library/metadata/${ratingKey}/children`, { query, signal });
	return page(container(data), start);
}

/** Sonically-similar items for a ratingKey (artist → similar artists, track → similar tracks).
 *  Requires Plex Pass + sonic analysis. `/library/metadata/{ratingKey}/nearest`. */
export async function getSonicallySimilar(
	ratingKey: string,
	opts: { limit?: number; maxDistance?: number } = {},
	signal?: AbortSignal
): Promise<Metadata[]> {
	const { limit = 12, maxDistance } = opts;
	const query: Record<string, number> = { limit };
	if (maxDistance != null) query.maxDistance = maxDistance;
	const data = await serverFetch<any>(`/library/metadata/${ratingKey}/nearest`, { query, signal });
	return metas(container(data));
}

/** A single item's metadata (for detail headers). */
export async function getMetadata(ratingKey: string, signal?: AbortSignal): Promise<Metadata | null> {
	const data = await serverFetch<any>(`/library/metadata/${ratingKey}`, { signal });
	return metas(container(data))[0] ?? null;
}

/** Audio playlists, most-recently-updated first. */
export async function getPlaylists(
	opts: { start?: number; size?: number } = {},
	signal?: AbortSignal
): Promise<PageResult> {
	const { start = 0, size = 60 } = opts;
	const data = await serverFetch<any>('/playlists', {
		query: {
			playlistType: 'audio',
			sort: 'updatedAt:desc',
			'X-Plex-Container-Start': start,
			'X-Plex-Container-Size': size
		},
		signal
	});
	return page(container(data), start);
}

export async function getPlaylistItems(
	id: string,
	opts: { start?: number; size?: number } = {},
	signal?: AbortSignal
): Promise<PageResult> {
	const { start = 0, size = 200 } = opts;
	const data = await serverFetch<any>(`/playlists/${id}/items`, {
		query: { 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size },
		signal
	});
	return page(container(data), start);
}

/** A single playlist's metadata (for the detail header). */
export async function getPlaylist(id: string, signal?: AbortSignal): Promise<Metadata | null> {
	const data = await serverFetch<any>(`/playlists/${id}`, { signal });
	return metas(container(data))[0] ?? null;
}

/** Fetch the tracks behind an item's own `key` (e.g. a mix/station/playlist content endpoint).
 *  Used to enrich "Mixes for you" tiles (artist image + included artists) and to play them. */
export async function getItemsByKey(
	key: string,
	opts: { size?: number } = {},
	signal?: AbortSignal
): Promise<Metadata[]> {
	const data = await serverFetch<any>(key, {
		query: { 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': opts.size ?? 60 },
		signal
	});
	return metas(container(data));
}

/** Find an artist by (approximate) name within a section — used to resolve a "{Artist} Mix" to its
 *  seed artist for correct art + artist-radio playback. Prefers an exact case-insensitive match. */
export async function findArtist(
	name: string,
	sectionId: string,
	signal?: AbortSignal
): Promise<Metadata | null> {
	const hubs = await search(name, sectionId, 8, signal);
	const artists = hubs.flatMap((h) => h.items).filter((i) => i.type === 'artist');
	const lower = name.toLowerCase();
	return artists.find((a) => a.title.toLowerCase() === lower) ?? artists[0] ?? null;
}

/** Grouped search (artists/albums/tracks/playlists), scoped to a section. */
export async function search(
	query: string,
	sectionId: string,
	limit = 12,
	signal?: AbortSignal
): Promise<Hub[]> {
	const data = await serverFetch<any>('/hubs/search', {
		query: { query, limit, sectionId },
		signal
	});
	return mapHubs(container(data));
}

/** A folder listing entry: a subfolder (only `key` + `title`) or a playable track. */
export interface FolderEntry {
	key: string;
	title: string;
}
export interface FolderListing {
	title: string;
	folders: FolderEntry[];
	tracks: Metadata[];
}

/** Browse a music section by its on-disk folders (Plex "By Folder"). Pass a subfolder's `key`
 *  (e.g. `/library/sections/20/folder?parent=123`) to descend; omit it for the section root. */
export async function getFolder(
	sectionId: string,
	folderKey?: string,
	signal?: AbortSignal
): Promise<FolderListing> {
	const path = folderKey ?? `/library/sections/${sectionId}/folder`;
	// Only allow folder keys of this section — the key comes from the URL.
	if (!path.startsWith(`/library/sections/${sectionId}/folder`)) {
		throw new Error('Invalid folder');
	}
	const data = await serverFetch<any>(path, { signal });
	const c = container(data);
	// Plex returns subfolders and tracks mixed in Metadata[] (subfolders have no `type`); older
	// servers may put folders under Directory[] — accept both.
	const raw: any[] = [
		...(Array.isArray(c.Directory) ? c.Directory : []),
		...(Array.isArray(c.Metadata) ? c.Metadata : [])
	];
	const folders: FolderEntry[] = [];
	const tracks: Metadata[] = [];
	for (const m of raw) {
		if (m.type === 'track') tracks.push(m as Metadata);
		else if (!m.type && typeof m.key === 'string') folders.push({ key: m.key, title: m.title ?? '' });
	}
	return { title: c.title2 ?? '', folders, tracks };
}

/** A genre tag in a section. `key` is the tag id used for filtering. */
export interface Genre {
	key: string;
	title: string;
}

/** All album genres in a section, alphabetical. */
export async function getGenres(sectionId: string, signal?: AbortSignal): Promise<Genre[]> {
	const data = await serverFetch<any>(`/library/sections/${sectionId}/genre`, {
		query: { type: TYPE.album },
		signal
	});
	const dirs: any[] = container(data).Directory ?? [];
	return dirs
		.map((d) => ({ key: String(d.key), title: String(d.title ?? '') }))
		.filter((g) => g.title)
		.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

/** Paginated albums tagged with a genre. */
export async function getGenreAlbums(
	sectionId: string,
	genreId: string,
	opts: { start?: number; size?: number; sort?: string; kind?: 'genre' | 'mood' } = {},
	signal?: AbortSignal
): Promise<PageResult> {
	const { start = 0, size = 60, sort = 'titleSort:asc', kind = 'genre' } = opts;
	const data = await serverFetch<any>(`/library/sections/${sectionId}/all`, {
		query: {
			type: TYPE.album,
			[kind]: genreId, // one id or several comma-separated (Plex ORs them)
			sort,
			'X-Plex-Container-Start': start,
			'X-Plex-Container-Size': size
		},
		signal
	});
	return page(container(data), start);
}

/** A random selection of tracks from albums in a genre — for "Shuffle genre". */
export async function getGenreTracksShuffled(
	sectionId: string,
	genreId: string,
	size = 200,
	signal?: AbortSignal,
	opts: { kind?: 'genre' | 'mood'; sort?: string } = {}
): Promise<Metadata[]> {
	const { kind = 'genre', sort = 'random' } = opts;
	const data = await serverFetch<any>(`/library/sections/${sectionId}/all`, {
		query: {
			type: TYPE.track,
			[`album.${kind}`]: genreId,
			sort,
			'X-Plex-Container-Start': 0,
			'X-Plex-Container-Size': size
		},
		signal
	});
	return metas(container(data));
}

/** Long tracks (mixes, live sets) the user stopped part-way through, most recent first — the
 *  "Continue listening" row. Plex keeps the resume point (viewOffset) server-side, so this is the
 *  same on every device. */
export async function getInProgress(
	sectionId: string,
	opts: { size?: number; minDurationMs?: number } = {},
	signal?: AbortSignal
): Promise<Metadata[]> {
	const { size = 30, minDurationMs = 10 * 60 * 1000 } = opts;
	const data = await serverFetch<any>(`/library/sections/${sectionId}/all`, {
		query: {
			type: TYPE.track,
			inProgress: 1,
			sort: 'lastViewedAt:desc',
			'X-Plex-Container-Start': 0,
			'X-Plex-Container-Size': size
		},
		signal
	});
	// Keep only real "part-way" listens: long enough, started, and not (nearly) finished.
	return metas(container(data)).filter((t) => {
		const d = t.duration ?? 0;
		const o = t.viewOffset ?? 0;
		return d >= minDurationMs && o >= 30_000 && o <= d - 120_000;
	});
}

/** Recently played albums (with their genre tags) — the listening history Daily Mixes are built on. */
export async function getRecentAlbums(sectionId: string, size = 200, signal?: AbortSignal): Promise<Metadata[]> {
	const data = await serverFetch<any>(`/library/sections/${sectionId}/all`, {
		query: {
			type: TYPE.album,
			sort: 'lastViewedAt:desc',
			'X-Plex-Container-Start': 0,
			'X-Plex-Container-Size': size
		},
		signal
	});
	return metas(container(data)).filter((a) => a.lastViewedAt);
}
