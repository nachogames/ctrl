import { DICTATION_SAMPLE_RATE } from "@t3tools/contracts";

/**
 * Smart Turn's input: Whisper's log-mel features for the last 8 s of a turn,
 * computed exactly as Hugging Face's `WhisperFeatureExtractor(chunk_length=8)`
 * with `do_normalize=True` does, which is what the model was trained on.
 */
const SMART_TURN_SECONDS = 8;
const SMART_TURN_SAMPLES = SMART_TURN_SECONDS * DICTATION_SAMPLE_RATE;
export const MEL_BINS = 80;
export const MEL_FRAMES = SMART_TURN_SAMPLES / 160;

const N_FFT = 400;
const HOP = 160;
const BINS = N_FFT / 2 + 1;

/** Slaney mel scale, as librosa and Hugging Face define it. */
const MIN_LOG_HERTZ = 1000;
const MIN_LOG_MEL = 15;
const LOG_STEP = 27 / Math.log(6.4);
const hertzToMel = (hertz: number) =>
  hertz >= MIN_LOG_HERTZ
    ? MIN_LOG_MEL + Math.log(hertz / MIN_LOG_HERTZ) * LOG_STEP
    : (3 * hertz) / 200;
const melToHertz = (mel: number) =>
  mel >= MIN_LOG_MEL ? MIN_LOG_HERTZ * Math.exp((mel - MIN_LOG_MEL) / LOG_STEP) : (200 * mel) / 3;

/** Slaney-normalized triangular filters, `[mel][bin]` flattened. */
function melFilters(): Float32Array {
  const maxMel = hertzToMel(DICTATION_SAMPLE_RATE / 2);
  const edges = Array.from({ length: MEL_BINS + 2 }, (_, index) =>
    melToHertz((maxMel * index) / (MEL_BINS + 1)),
  );
  const filters = new Float32Array(MEL_BINS * BINS);
  for (let mel = 0; mel < MEL_BINS; mel++) {
    const [low, center, high] = [edges[mel]!, edges[mel + 1]!, edges[mel + 2]!];
    const norm = 2 / (high - low);
    for (let bin = 0; bin < BINS; bin++) {
      const hertz = (bin * DICTATION_SAMPLE_RATE) / 2 / (BINS - 1);
      const weight = Math.max(
        0,
        Math.min((hertz - low) / (center - low), (high - hertz) / (high - center)),
      );
      filters[mel * BINS + bin] = weight * norm;
    }
  }
  return filters;
}

/** Periodic Hann window, `np.hanning(401)[:-1]`. */
function hannWindow(): Float64Array {
  return Float64Array.from(
    { length: N_FFT },
    (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT),
  );
}

/**
 * Mixed-radix FFT for 400 = 2^4 * 5^2 points. Writes the spectrum of
 * `input[offset + k * stride]` for k < n into `re`/`im` at `out`.
 */
function fft(
  input: Float64Array,
  offset: number,
  stride: number,
  n: number,
  re: Float64Array,
  im: Float64Array,
  out: number,
): void {
  if (n === 1) {
    re[out] = input[offset]!;
    im[out] = 0;
    return;
  }
  const radix = n % 2 === 0 ? 2 : 5;
  const m = n / radix;
  const roots = rootsOf(n);
  for (let r = 0; r < radix; r++)
    fft(input, offset + r * stride, stride * radix, m, re, im, out + r * m);
  // Combine `radix` interleaved sub-spectra of length m into one of length n.
  for (let k = 0; k < m; k++) {
    for (let r = 0; r < radix; r++) {
      // Twiddle the r-th sub-spectrum by e^(-2πi r k / n).
      const cos = roots.cos[(r * k) % n]!;
      const sin = roots.sin[(r * k) % n]!;
      const a = re[out + r * m + k]!;
      const b = im[out + r * m + k]!;
      sumRe[r] = a * cos - b * sin;
      sumIm[r] = a * sin + b * cos;
    }
    for (let q = 0; q < radix; q++) {
      let accRe = 0;
      let accIm = 0;
      for (let r = 0; r < radix; r++) {
        // e^(-2πi r q / radix), the same root of unity as index r q m of n.
        const cos = roots.cos[(r * q * m) % n]!;
        const sin = roots.sin[(r * q * m) % n]!;
        accRe += sumRe[r]! * cos - sumIm[r]! * sin;
        accIm += sumRe[r]! * sin + sumIm[r]! * cos;
      }
      scratchRe[q * m + k] = accRe;
      scratchIm[q * m + k] = accIm;
    }
  }
  re.set(scratchRe.subarray(0, n), out);
  im.set(scratchIm.subarray(0, n), out);
}
const rootTables = new Map<number, { cos: Float64Array; sin: Float64Array }>();
/** The n-th roots of unity e^(-2πi j / n), computed once per size. */
function rootsOf(n: number) {
  let table = rootTables.get(n);
  if (!table) {
    table = {
      cos: Float64Array.from({ length: n }, (_, j) => Math.cos((-2 * Math.PI * j) / n)),
      sin: Float64Array.from({ length: n }, (_, j) => Math.sin((-2 * Math.PI * j) / n)),
    };
    rootTables.set(n, table);
  }
  return table;
}
const sumRe = new Float64Array(5);
const sumIm = new Float64Array(5);
const scratchRe = new Float64Array(N_FFT);
const scratchIm = new Float64Array(N_FFT);

/** Power spectrum of one 400-sample frame, exported to test against a plain DFT. */
export function powerSpectrum(frame: Float64Array): Float64Array {
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  fft(frame, 0, 1, N_FFT, re, im, 0);
  const power = new Float64Array(BINS);
  for (let bin = 0; bin < BINS; bin++) power[bin] = re[bin]! ** 2 + im[bin]! ** 2;
  return power;
}

let cached: {
  readonly filters: Float32Array;
  /** Per mel filter, the [first, end) bins where it is non-zero. */
  readonly spans: Uint16Array;
  readonly window: Float64Array;
} | null = null;

function nonZeroSpans(filters: Float32Array): Uint16Array {
  const spans = new Uint16Array(MEL_BINS * 2);
  for (let mel = 0; mel < MEL_BINS; mel++) {
    let first = BINS;
    let end = 0;
    for (let bin = 0; bin < BINS; bin++)
      if (filters[mel * BINS + bin]! !== 0) {
        first = Math.min(first, bin);
        end = bin + 1;
      }
    spans[2 * mel] = Math.min(first, end);
    spans[2 * mel + 1] = end;
  }
  return spans;
}

/**
 * The last 8 s of `audio` (16 kHz mono), zero-padded at the start when
 * shorter, as `[80 mel][800 frames]` row-major features for Smart Turn.
 */
export function smartTurnFeatures(audio: Float32Array) {
  if (!cached) {
    const filters = melFilters();
    cached = { filters, spans: nonZeroSpans(filters), window: hannWindow() };
  }
  const { filters, spans, window } = cached;
  // Keep the end; pad at the beginning so speech sits at the end of the input.
  const samples = new Float64Array(SMART_TURN_SAMPLES);
  const tail = audio.subarray(Math.max(0, audio.length - SMART_TURN_SAMPLES));
  samples.set(tail, SMART_TURN_SAMPLES - tail.length);
  // Zero mean, unit variance over the whole padded input.
  let mean = 0;
  for (const sample of samples) mean += sample;
  mean /= samples.length;
  let variance = 0;
  for (const sample of samples) variance += (sample - mean) ** 2;
  variance /= samples.length;
  const scale = 1 / Math.sqrt(variance + 1e-7);
  for (let index = 0; index < samples.length; index++)
    samples[index] = (samples[index]! - mean) * scale;
  // Centered frames with reflect padding; Whisper drops the last frame.
  const half = N_FFT / 2;
  const at = (index: number) => {
    const reflected =
      index < 0 ? -index : index >= samples.length ? 2 * (samples.length - 1) - index : index;
    return samples[reflected]!;
  };
  const features = new Float32Array(MEL_BINS * MEL_FRAMES);
  const frame = new Float64Array(N_FFT);
  let max = -Infinity;
  for (let t = 0; t < MEL_FRAMES; t++) {
    const start = t * HOP - half;
    for (let n = 0; n < N_FFT; n++) frame[n] = at(start + n) * window[n]!;
    const power = powerSpectrum(frame);
    for (let mel = 0; mel < MEL_BINS; mel++) {
      let energy = 0;
      const row = mel * BINS;
      for (let bin = spans[2 * mel]!; bin < spans[2 * mel + 1]!; bin++)
        energy += filters[row + bin]! * power[bin]!;
      const log = Math.log10(Math.max(energy, 1e-10));
      features[mel * MEL_FRAMES + t] = log;
      if (log > max) max = log;
    }
  }
  for (let index = 0; index < features.length; index++)
    features[index] = (Math.max(features[index]!, max - 8) + 4) / 4;
  return features;
}

/** The last `SMART_TURN_SAMPLES` of a recording, kept in a fixed ring so long turns cost nothing extra. */
export function createRecentAudio(capacity = SMART_TURN_SAMPLES) {
  const ring = new Float32Array(capacity);
  let written = 0;
  return {
    push(chunk: Float32Array) {
      const tail = chunk.subarray(Math.max(0, chunk.length - capacity));
      for (let index = 0; index < tail.length; index++)
        ring[(written + index) % capacity] = tail[index]!;
      written += tail.length;
    },
    /** A copy of what was heard, oldest first; shorter than `capacity` early in a recording. */
    snapshot(): Float32Array {
      const length = Math.min(written, capacity);
      const out = new Float32Array(length);
      const start = written - length;
      for (let index = 0; index < length; index++) out[index] = ring[(start + index) % capacity]!;
      return out;
    },
  };
}

export type RecentAudio = ReturnType<typeof createRecentAudio>;
