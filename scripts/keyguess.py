#!/usr/bin/env python3
"""Estimate BPM and key (Camelot) of audio files with Essentia — for tracks Mixed In Key hasn't done.

    keyguess.py FILE...            → one JSON line per file: {"file", "bpm", "key"} (or "error")
    keyguess.py --compare N        → analyse N random files that DO have Mixed In Key tags and report
                                     how often Essentia agrees (needs the keyindex state file)

Only reads the audio; never writes to the files.
"""
import json
import os
import random
import sys

import essentia
import essentia.standard as es

essentia.log.warningActive = False
essentia.log.infoActive = False

MINOR = {'G#': 1, 'Ab': 1, 'D#': 2, 'Eb': 2, 'A#': 3, 'Bb': 3, 'F': 4, 'C': 5, 'G': 6, 'D': 7, 'A': 8,
         'E': 9, 'B': 10, 'F#': 11, 'Gb': 11, 'C#': 12, 'Db': 12}
MAJOR = {'B': 1, 'F#': 2, 'Gb': 2, 'C#': 3, 'Db': 3, 'G#': 4, 'Ab': 4, 'D#': 5, 'Eb': 5, 'A#': 6, 'Bb': 6,
         'F': 7, 'C': 8, 'G': 9, 'D': 10, 'A': 11, 'E': 12}


def camelot(key, scale):
    n = (MINOR if scale == 'minor' else MAJOR).get(key)
    return f"{n}{'A' if scale == 'minor' else 'B'}" if n else None


def analyse(path):
    # Mono 44.1 kHz; the middle of the track says most about key and tempo (intros/outros mislead).
    audio = es.MonoLoader(filename=path, sampleRate=44100)()
    n = len(audio)
    if n > 44100 * 150:
        mid = n // 2
        audio = audio[mid - 44100 * 75: mid + 44100 * 75]
    key, scale, strength = es.KeyExtractor(profileType='edma')(audio)
    bpm = es.RhythmExtractor2013(method='multifeature')(audio)[0]
    return {'bpm': round(float(bpm)), 'key': camelot(key, scale), 'strength': round(float(strength), 2)}


def dist(a, b):
    """0 same key, 1 neighbour / relative, 2+ further."""
    if not a or not b:
        return 9
    na, ma = int(a[:-1]), a[-1]
    nb, mb = int(b[:-1]), b[-1]
    step = min((na - nb) % 12, (nb - na) % 12)
    return step if ma == mb else step + 1


def compare(count):
    state = os.path.expanduser('~/Library/Application Support/cabin-music/keyindex-state.json')
    files = json.load(open(state))['files']
    tagged = [(f, v['v']) for f, v in files.items()
              if '/Music Library/' in f and v.get('v') and v['v'].count('|') >= 1 and v['v'].split('|')[1]]
    random.seed(7)
    sample = random.sample(tagged, count)
    same = near = bpm_ok = n = 0
    for f, v in sample:
        mik_bpm, mik_key = v.split('|')[0], v.split('|')[1]
        try:
            g = analyse(f)
        except Exception as e:  # unreadable file: skip
            print(json.dumps({'file': f, 'error': str(e)}), flush=True)
            continue
        n += 1
        d = dist(g['key'], mik_key)
        same += d == 0
        near += d <= 1
        if mik_bpm:
            m = int(mik_bpm)
            bpm_ok += min(abs(g['bpm'] - m), abs(g['bpm'] - 2 * m), abs(2 * g['bpm'] - m)) <= 2
        print(json.dumps({'file': f[-60:], 'mik': [mik_bpm, mik_key], 'essentia': [g['bpm'], g['key']]}), flush=True)
    print(json.dumps({'tracks': n, 'key_same': same, 'key_same_or_neighbour': near, 'bpm_within_2': bpm_ok}))


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--compare':
        compare(int(sys.argv[2]))
    else:
        for p in sys.argv[1:]:
            try:
                print(json.dumps({'file': p, **analyse(p)}), flush=True)
            except Exception as e:
                print(json.dumps({'file': p, 'error': str(e)}), flush=True)
