// FLAC → fragmented MP4, in the browser, losslessly.
//
// MediaSource (needed for gapless playback on one <audio> element) does not take raw .flac, but it
// does take FLAC inside fragmented MP4 ('audio/mp4; codecs="flac"'). This repackages the original
// file: the FLAC frames themselves are copied byte for byte — no decoding, no quality loss — and
// each frame becomes one MP4 sample. FLAC has no encoder delay or padding, and STREAMINFO gives the
// exact sample count, so tracks butt together sample-accurately.
//
// It works incrementally (push bytes as they download) and can start mid-file (after an HTTP Range
// seek) by re-syncing on a frame header whose CRC-8 checks out and whose successor follows on.

export interface StreamInfo {
	minBlock: number;
	maxBlock: number;
	minFrame: number;
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
	totalSamples: number; // 0 = unknown
	raw: Uint8Array; // the 34-byte STREAMINFO block body (goes into the dfLa box)
}

interface FrameHeader {
	variable: boolean;
	number: number; // frame number (fixed blocksize) or first sample number (variable)
	blockSize: number;
}

// --- CRC-8 (poly 0x07), as used by FLAC frame headers ---
const CRC8 = (() => {
	const t = new Uint8Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let j = 0; j < 8; j++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
		t[i] = c;
	}
	return t;
})();
function crc8(b: Uint8Array, from: number, to: number): number {
	let c = 0;
	for (let i = from; i < to; i++) c = CRC8[c ^ b[i]];
	return c;
}

/** Parse a frame header at b[i]. null = not a header; undefined = need more bytes to tell. */
function parseHeader(b: Uint8Array, i: number): FrameHeader | null | undefined {
	if (i + 4 > b.length) return undefined;
	if (b[i] !== 0xff || (b[i + 1] & 0xfe) !== 0xf8) return null;
	const variable = (b[i + 1] & 1) === 1;
	const bsCode = b[i + 2] >> 4;
	const srCode = b[i + 2] & 0x0f;
	const ch = b[i + 3] >> 4;
	if (bsCode === 0 || srCode === 15 || ch > 10 || (b[i + 3] & 1) !== 0) return null;
	// UTF-8-style coded frame/sample number
	let p = i + 4;
	if (p >= b.length) return undefined;
	const x = b[p];
	let n: number;
	let v: number;
	if (x < 0x80) [n, v] = [0, x];
	else if ((x & 0xe0) === 0xc0) [n, v] = [1, x & 0x1f];
	else if ((x & 0xf0) === 0xe0) [n, v] = [2, x & 0x0f];
	else if ((x & 0xf8) === 0xf0) [n, v] = [3, x & 0x07];
	else if ((x & 0xfc) === 0xf8) [n, v] = [4, x & 0x03];
	else if ((x & 0xfe) === 0xfc) [n, v] = [5, x & 0x01];
	else if (x === 0xfe) [n, v] = [6, 0];
	else return null;
	p++;
	if (p + n > b.length) return undefined;
	for (let k = 0; k < n; k++, p++) {
		if ((b[p] & 0xc0) !== 0x80) return null;
		v = v * 64 + (b[p] & 0x3f);
	}
	let blockSize: number;
	if (bsCode === 1) blockSize = 192;
	else if (bsCode <= 5) blockSize = 576 << (bsCode - 2);
	else if (bsCode === 6) {
		if (p + 1 > b.length) return undefined;
		blockSize = b[p] + 1;
		p += 1;
	} else if (bsCode === 7) {
		if (p + 2 > b.length) return undefined;
		blockSize = ((b[p] << 8) | b[p + 1]) + 1;
		p += 2;
	} else blockSize = 256 << (bsCode - 8);
	if (srCode === 12) p += 1;
	else if (srCode === 13 || srCode === 14) p += 2;
	if (p >= b.length) return undefined;
	if (crc8(b, i, p) !== b[p]) return null;
	return { variable, number: v, blockSize };
}

/** Parse the 34-byte STREAMINFO body. */
export function parseStreamInfo(raw: Uint8Array): StreamInfo {
	const r = raw;
	const sampleRate = (r[10] << 12) | (r[11] << 4) | (r[12] >> 4);
	const channels = ((r[12] >> 1) & 0x07) + 1;
	const bitsPerSample = (((r[12] & 1) << 4) | (r[13] >> 4)) + 1;
	const totalSamples = (r[13] & 0x0f) * 2 ** 32 + ((r[14] << 24) >>> 0) + (r[15] << 16) + (r[16] << 8) + r[17];
	return {
		minBlock: (r[0] << 8) | r[1],
		maxBlock: (r[2] << 8) | r[3],
		minFrame: (r[4] << 16) | (r[5] << 8) | r[6],
		sampleRate,
		channels,
		bitsPerSample,
		totalSamples,
		raw: r.slice(0, 34)
	};
}

/** Where the audio frames start and the STREAMINFO, given the first bytes of a .flac file.
 *  Returns undefined when more bytes are needed (`need` = how many in total). */
export function parseFlacHeader(
	b: Uint8Array
): { info: StreamInfo; audioStart: number } | { need: number } | null {
	let i = 0;
	// Skip a leading ID3v2 tag, if any.
	if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
		i = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
	}
	if (b.length < i + 4) return { need: i + 4 };
	if (b[i] !== 0x66 || b[i + 1] !== 0x4c || b[i + 2] !== 0x61 || b[i + 3] !== 0x43) return null; // "fLaC"
	i += 4;
	let info: StreamInfo | null = null;
	for (;;) {
		if (b.length < i + 4) return { need: i + 4 };
		const last = (b[i] & 0x80) !== 0;
		const type = b[i] & 0x7f;
		const len = (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
		if (type === 0) {
			if (b.length < i + 4 + 34) return { need: i + 4 + 34 };
			info = parseStreamInfo(b.subarray(i + 4, i + 4 + 34));
		}
		i += 4 + len;
		if (last) break;
	}
	return info ? { info, audioStart: i } : null;
}

// --- MP4 box writing ---
function u32(n: number): number[] {
	return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function u16(n: number): number[] {
	return [(n >>> 8) & 0xff, n & 0xff];
}
function str(s: string): number[] {
	return [...s].map((c) => c.charCodeAt(0));
}
function box(type: string, ...payload: (number[] | Uint8Array)[]): Uint8Array {
	const size = 8 + payload.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(size);
	out.set([...u32(size), ...str(type)]);
	let at = 8;
	for (const p of payload) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}
const MATRIX = [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

/** ftyp + moov describing one FLAC audio track (timescale = sample rate). */
export function initSegment(info: StreamInfo): Uint8Array {
	const sr = info.sampleRate;
	const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso6'), str('mp41'));
	const mvhd = box('mvhd', u32(0), u32(0), u32(0), u32(sr), u32(0), u32(0x10000), u16(0x100), u16(0), u32(0), u32(0), MATRIX, new Array(24).fill(0), u32(2));
	const tkhd = box('tkhd', u32(3), u32(0), u32(0), u32(1), u32(0), u32(0), u32(0), u32(0), u16(0), u16(0), u16(0x100), u16(0), MATRIX, u32(0), u32(0));
	const mdhd = box('mdhd', u32(0), u32(0), u32(0), u32(sr), u32(0), u16(0x55c4), u16(0));
	const hdlr = box('hdlr', u32(0), u32(0), str('soun'), u32(0), u32(0), u32(0), [...str('SoundHandler'), 0]);
	const dfLa = box('dfLa', u32(0), [0x80, 0, 0, 34], info.raw); // STREAMINFO, marked as last block
	const fLaC = box(
		'fLaC',
		[0, 0, 0, 0, 0, 0],
		u16(1),
		u32(0),
		u32(0),
		u16(info.channels),
		u16(info.bitsPerSample),
		u16(0),
		u16(0),
		u32(sr <= 0xffff ? (sr << 16) >>> 0 : 0),
		dfLa
	);
	const stbl = box(
		'stbl',
		box('stsd', u32(0), u32(1), fLaC),
		box('stts', u32(0), u32(0)),
		box('stsc', u32(0), u32(0)),
		box('stsz', u32(0), u32(0), u32(0)),
		box('stco', u32(0), u32(0))
	);
	const minf = box('minf', box('smhd', u32(0), u16(0), u16(0)), box('dinf', box('dref', u32(0), u32(1), box('url ', u32(1)))), stbl);
	const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
	const mvex = box('mvex', box('trex', u32(0), u32(1), u32(1), u32(0), u32(0), u32(0)));
	const moov = box('moov', mvhd, trak, mvex);
	const out = new Uint8Array(ftyp.length + moov.length);
	out.set(ftyp);
	out.set(moov, ftyp.length);
	return out;
}

/** moof + mdat for a run of frames. `firstSample` = decode time of the first frame (in samples). */
function mediaSegment(frames: Uint8Array[], durations: number[], firstSample: number, seq: number): Uint8Array {
	const n = frames.length;
	const trunSize = 8 + 4 + 4 + 4 + n * 8;
	const tfhdSize = 8 + 8;
	const tfdtSize = 8 + 4 + 8;
	const trafSize = 8 + tfhdSize + tfdtSize + trunSize;
	const moofSize = 8 + (8 + 8) + trafSize;
	const entries: number[] = [];
	for (let k = 0; k < n; k++) entries.push(...u32(durations[k]), ...u32(frames[k].length));
	const hi = Math.floor(firstSample / 2 ** 32);
	const lo = firstSample >>> 0;
	const moof = box(
		'moof',
		box('mfhd', u32(0), u32(seq)),
		box(
			'traf',
			box('tfhd', u32(0x020000), u32(1)), // default-base-is-moof
			box('tfdt', u32(0x01000000), u32(hi), u32(lo)),
			box('trun', u32(0x000301), u32(n), u32(moofSize + 8), entries) // data-offset, duration, size
		)
	);
	const dataLen = frames.reduce((s, f) => s + f.length, 0);
	const out = new Uint8Array(moof.length + 8 + dataLen);
	out.set(moof);
	out.set([...u32(8 + dataLen), ...str('mdat')], moof.length);
	let at = moof.length + 8;
	for (const f of frames) {
		out.set(f, at);
		at += f.length;
	}
	return out;
}

/** Incremental FLAC frame splitter + fMP4 packer for one track. */
export class FlacToMp4 {
	private buf = new Uint8Array(0);
	private cur: { at: number; h: FrameHeader } | null = null; // current (validated) frame start
	private scanFrom = 0;
	private seq = 1;

	/** @param info STREAMINFO of the file. @param midStream true when bytes start at an arbitrary
	 *  offset (Range seek): the first frame is found by re-syncing. */
	constructor(
		readonly info: StreamInfo,
		private midStream = false
	) {}

	/** First sample (track timeline) of the data emitted so far — known after the first frame. */
	firstSample: number | null = null;

	private sampleOf(h: FrameHeader): number {
		return h.variable ? h.number : h.number * this.info.minBlock;
	}

	private follows(a: FrameHeader, b: FrameHeader): boolean {
		return a.variable ? b.number === a.number + a.blockSize : b.number === a.number + 1;
	}

	/** Feed bytes; returns an fMP4 media segment for every complete frame found (or null). */
	push(chunk: Uint8Array, final = false): Uint8Array | null {
		if (chunk.length) {
			const m = new Uint8Array(this.buf.length + chunk.length);
			m.set(this.buf);
			m.set(chunk, this.buf.length);
			this.buf = m;
		}
		const b = this.buf;
		const frames: Uint8Array[] = [];
		const durations: number[] = [];
		let first = -1;

		// Find the first frame: right at the start of the audio, or by re-syncing mid-file.
		while (!this.cur) {
			let found = false;
			for (let i = this.scanFrom; i < b.length - 1; i++) {
				if (b[i] !== 0xff || (b[i + 1] & 0xfe) !== 0xf8) continue;
				const h = parseHeader(b, i);
				if (h === undefined) return this.flushEmpty(i);
				if (!h) continue;
				if (!this.midStream) {
					this.cur = { at: i, h };
					found = true;
					break;
				}
				// Mid-stream: accept only if the next valid header continues the sequence.
				const minNext = i + Math.max(this.info.minFrame || 0, 16);
				let ok: boolean | undefined = false;
				for (let j = minNext; j < b.length - 1; j++) {
					if (b[j] !== 0xff || (b[j + 1] & 0xfe) !== 0xf8) continue;
					const h2 = parseHeader(b, j);
					if (h2 === undefined) {
						ok = undefined;
						break;
					}
					if (h2 && this.follows(h, h2)) {
						ok = true;
						break;
					}
					if (j - i > 1 << 16) break; // frames are never this large
				}
				if (ok === undefined) return this.flushEmpty(i);
				if (ok) {
					this.cur = { at: i, h };
					found = true;
					break;
				}
			}
			if (!found) {
				this.scanFrom = Math.max(0, b.length - 32);
				return null;
			}
		}

		// Split complete frames: a frame ends where the next valid, consecutive header begins.
		let start = this.cur.at;
		let h = this.cur.h;
		let i = Math.max(this.scanFrom, start + Math.max(this.info.minFrame || 0, 16));
		for (; i < b.length - 1; i++) {
			if (b[i] !== 0xff || (b[i + 1] & 0xfe) !== 0xf8) continue;
			const h2 = parseHeader(b, i);
			if (h2 === undefined) break; // need more bytes to judge this candidate
			if (!h2 || !this.follows(h, h2)) continue;
			if (first < 0) first = this.sampleOf(h);
			frames.push(b.subarray(start, i));
			durations.push(h.blockSize);
			start = i;
			h = h2;
			i = start + Math.max(this.info.minFrame || 0, 16) - 1;
		}
		if (final && b.length > start) {
			// The last frame runs to the end of the file.
			if (first < 0) first = this.sampleOf(h);
			frames.push(b.subarray(start));
			durations.push(h.blockSize);
			start = b.length;
		}
		this.cur = { at: 0, h };
		this.buf = b.slice(start);
		this.scanFrom = Math.max(0, i - start);
		if (!frames.length) return null;
		if (this.firstSample === null) this.firstSample = first;
		// The last frame of a file may be shorter than its header-declared block size is not an
		// issue: the block size in the header IS that frame's sample count.
		return mediaSegment(frames, durations, first, this.seq++);
	}

	private flushEmpty(keepFrom: number): null {
		this.buf = this.buf.slice(keepFrom);
		this.scanFrom = 0;
		return null;
	}
}
