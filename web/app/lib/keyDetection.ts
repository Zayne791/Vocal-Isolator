// Client-side musical key detection: chroma (pitch-class energy) extraction
// via FFT, then correlated against the Krumhansl-Schmucker key profiles.
// Pure math on raw samples - no AudioContext/AudioBuffer dependency, so it
// runs the same in the browser or a plain test script.

export const PITCH_CLASS_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

export type Mode = "major" | "minor";

export type DetectedKey = {
  tonic: number; // 0=C .. 11=B
  mode: Mode;
  name: string; // e.g. "A minor"
  confidence: number; // top correlation score, roughly 0..1
};

// Krumhansl-Kessler key profiles - relative perceived "fit" of each pitch
// class within a major/minor key, tonic-relative (index 0 = the tonic).
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const FFT_SIZE = 4096;
// Musically meaningful range - low enough to catch bass-register tonic
// notes, high enough to skip most non-harmonic hiss/noise energy.
const MIN_FREQ_HZ = 65;
const MAX_FREQ_HZ = 2100;
// Analyzing every frame of a multi-minute song is wasted work for this -
// a few hundred windows spread across the track already gives a stable
// chroma estimate.
const MAX_FRAMES = 300;

// In-place iterative radix-2 Cooley-Tukey FFT. `re`/`im` length must be a
// power of two.
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curWr = 1;
      let curWi = 0;
      const half = len / 2;
      for (let j = 0; j < half; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + half] * curWr - im[i + j + half] * curWi;
        const vi = re[i + j + half] * curWi + im[i + j + half] * curWr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + half] = ur - vr;
        im[i + j + half] = ui - vi;
        const nextWr = curWr * wr - curWi * wi;
        const nextWi = curWr * wi + curWi * wr;
        curWr = nextWr;
        curWi = nextWi;
      }
    }
  }
}

function pitchClassForFrequency(freqHz: number): number {
  const midi = 69 + 12 * Math.log2(freqHz / 440);
  return ((Math.round(midi) % 12) + 12) % 12;
}

// Sums FFT-bin magnitude into its nearest pitch class across evenly-spaced
// windows of the signal, producing a 12-bin "how much of each note is
// present" fingerprint of the audio.
export function computeChromaVector(samples: Float32Array, sampleRate: number): number[] {
  const chroma = new Array(12).fill(0);
  if (samples.length < FFT_SIZE) return chroma;

  const totalFrames = Math.floor(samples.length / FFT_SIZE);
  const frameCount = Math.min(totalFrames, MAX_FRAMES);
  const frameStride = Math.max(1, Math.floor(totalFrames / frameCount));

  // Precompute a Hann window and bin->pitch-class map once.
  const window = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }
  const minBin = Math.max(1, Math.ceil((MIN_FREQ_HZ * FFT_SIZE) / sampleRate));
  const maxBin = Math.min(FFT_SIZE / 2 - 1, Math.floor((MAX_FREQ_HZ * FFT_SIZE) / sampleRate));
  const binPitchClass = new Int8Array(maxBin + 1);
  for (let bin = minBin; bin <= maxBin; bin++) {
    binPitchClass[bin] = pitchClassForFrequency((bin * sampleRate) / FFT_SIZE);
  }

  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * frameStride * FFT_SIZE;
    if (start + FFT_SIZE > samples.length) break;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let bin = minBin; bin <= maxBin; bin++) {
      const magnitude = Math.hypot(re[bin], im[bin]);
      chroma[binPitchClass[bin]] += magnitude;
    }
  }

  return chroma;
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denom = Math.sqrt(varA * varB);
  return denom === 0 ? 0 : cov / denom;
}

// Correlates a chroma vector against every major/minor key profile
// (Krumhansl-Schmucker key-finding algorithm) and returns the best match.
export function detectKeyFromChroma(chroma: number[]): DetectedKey {
  let best: DetectedKey = { tonic: 0, mode: "major", name: "C major", confidence: -Infinity };

  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, profile] of [["major", MAJOR_PROFILE], ["minor", MINOR_PROFILE]] as const) {
      // Rotate the tonic-relative profile so index `tonic` holds its root.
      const rotated = new Array(12);
      for (let i = 0; i < 12; i++) rotated[(tonic + i) % 12] = profile[i];
      const score = pearsonCorrelation(chroma, rotated);
      if (score > best.confidence) {
        best = {
          tonic,
          mode,
          name: `${PITCH_CLASS_NAMES[tonic]} ${mode}`,
          confidence: score,
        };
      }
    }
  }

  return best;
}

export function detectKey(samples: Float32Array, sampleRate: number): DetectedKey {
  return detectKeyFromChroma(computeChromaVector(samples, sampleRate));
}

// Shortest signed semitone distance from one pitch class to another,
// e.g. useful for turning "dial points at F#" into "+3 semitones from A".
export function shortestSemitoneDistance(fromPitchClass: number, toPitchClass: number): number {
  let diff = ((toPitchClass - fromPitchClass) % 12 + 12) % 12;
  if (diff > 6) diff -= 12;
  return diff;
}
