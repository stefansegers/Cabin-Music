// The start of an original MP3 file, for the gapless stream: where the audio frames begin (after the
// ID3v2 tag and the Xing/Info frame, which are not audio), and from the LAME tag the encoder delay
// and padding — what a gapless player must cut so consecutive tracks join on the exact sample.

export interface Mp3Head {
	audioStart: number; // byte offset of the first audio frame
	sampleRate: number;
	delay: number; // samples to drop at the start (encoder delay + the decoder's 529)
	samples: number | null; // exact playing time in samples (null: no Xing/LAME info)
}

const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const DECODER_DELAY = 529;

function frameAt(b: Uint8Array, i: number) {
	if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
	const ver = (b[i + 1] >> 3) & 3; // 3 MPEG1, 2 MPEG2, 0 MPEG2.5
	const layer = (b[i + 1] >> 1) & 3; // 1 = Layer III
	const brIdx = b[i + 2] >> 4;
	const srIdx = (b[i + 2] >> 2) & 3;
	const pad = (b[i + 2] >> 1) & 1;
	const chan = (b[i + 3] >> 6) & 3;
	if (ver === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
	const sr = [44100, 48000, 32000][srIdx] / (ver === 3 ? 1 : ver === 2 ? 2 : 4);
	const br = (ver === 3 ? BR1 : BR2)[brIdx] * 1000;
	const len = Math.floor(((ver === 3 ? 144 : 72) * br) / sr) + pad;
	const side = ver === 3 ? (chan === 3 ? 17 : 32) : chan === 3 ? 9 : 17;
	return { sr, len, spf: ver === 3 ? 1152 : 576, side };
}

/** Parse the head of an MP3. `{ need }` = give me at least this many bytes; null = not an MP3. */
export function parseMp3Head(b: Uint8Array): Mp3Head | { need: number } | null {
	if (b.length < 10) return { need: 10 };
	let pos = 0;
	if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
		const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
		pos = 10 + size + (b[5] & 0x10 ? 10 : 0);
	}
	if (b.length < pos + 4096) return { need: pos + 4096 };
	// First frame sync, confirmed by a second frame right after it.
	let i = pos;
	let f = null;
	for (; i < b.length - 4; i++) {
		f = frameAt(b, i);
		if (f && (i + f.len + 4 > b.length || frameAt(b, i + f.len))) break;
		f = null;
	}
	if (!f) return i - pos > 64 * 1024 ? null : { need: b.length + 16 * 1024 };
	const x = i + 4 + f.side;
	const tag = String.fromCharCode(b[x], b[x + 1], b[x + 2], b[x + 3]);
	if (tag !== 'Xing' && tag !== 'Info') {
		// No info frame: the audio starts here; only the decoder's delay is known.
		return { audioStart: i, sampleRate: f.sr, delay: DECODER_DELAY, samples: null };
	}
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const flags = dv.getUint32(x + 4);
	const frames = flags & 1 ? dv.getUint32(x + 8) : 0;
	const o = x + 8 + (flags & 1 ? 4 : 0) + (flags & 2 ? 4 : 0) + (flags & 4 ? 100 : 0) + (flags & 8 ? 4 : 0);
	let encDelay = 0;
	let encPad = 0;
	const lame = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
	if (lame === 'LAME' || lame === 'Lavc' || lame === 'Lavf') {
		const d = o + 21;
		encDelay = (b[d] << 4) | (b[d + 1] >> 4);
		encPad = ((b[d + 1] & 0x0f) << 8) | b[d + 2];
	}
	return {
		audioStart: i + f.len, // skip the info frame: it holds no audio
		sampleRate: f.sr,
		delay: encDelay + DECODER_DELAY,
		samples: frames ? frames * f.spf - encDelay - encPad : null
	};
}

/** Length of a trailing ID3v1 tag ("TAG", 128 bytes) at the end of `b`, else 0. */
export function id3v1Tail(b: Uint8Array): number {
	const n = b.length;
	return n >= 128 && b[n - 128] === 0x54 && b[n - 127] === 0x41 && b[n - 126] === 0x47 ? 128 : 0;
}
