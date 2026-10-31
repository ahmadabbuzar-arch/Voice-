// Pure helpers with no browser dependencies, so they can be unit-tested with
// `node --test`. Nothing in here touches the DeepFilterNet3 engine.

/**
 * Simple loudness normalization (NOT ITU-R BS.1770 / LUFS: no K-weighting).
 * Measures RMS over 50 ms windows, ignoring windows below `gateDb` so silence
 * and room noise do not drag the measurement down, then applies one constant
 * gain so the speech RMS reaches `targetRmsDb`. The gain is limited so that
 * the peak never exceeds `peakCeilingDb`, and to at most `maxGainDb` of boost.
 *
 * Modifies `samples` in place (saves memory on long files) and returns info.
 */
export function normalizeLoudness(
  samples,
  sampleRate,
  { targetRmsDb = -20, peakCeilingDb = -1, gateDb = -50, maxGainDb = 24 } = {},
) {
  const win = Math.max(1, Math.floor(sampleRate * 0.05));
  const gate = Math.pow(10, gateDb / 20);
  let energy = 0;
  let counted = 0;
  let peak = 0;

  for (let start = 0; start < samples.length; start += win) {
    const end = Math.min(start + win, samples.length);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const s = samples[i];
      sum += s * s;
      const a = Math.abs(s);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / (end - start));
    if (rms >= gate) {
      energy += sum;
      counted += end - start;
    }
  }

  if (counted === 0 || peak === 0) return { gain: 1, applied: false };

  const speechRms = Math.sqrt(energy / counted);
  const targetGain = Math.pow(10, targetRmsDb / 20) / speechRms;
  const ceilingGain = Math.pow(10, peakCeilingDb / 20) / peak;
  const maxGain = Math.pow(10, maxGainDb / 20);
  const gain = Math.min(targetGain, ceilingGain, maxGain);

  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return { gain, applied: true };
}

// Rough memory model: the pipeline holds several mono Float32 copies of the
// audio at 48 kHz at once (decoded, offline-render input, render output,
// post-processing, encoded blob, preview copies). 48000 * 4 bytes = 192 kB/s
// per copy; we budget ~6 copies. This is a heuristic, not a measurement.
const BYTES_PER_AUDIO_SECOND = 48000 * 4 * 6;
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

/**
 * Decide how long a file this device should be asked to process in full.
 * `deviceMemoryGB` is navigator.deviceMemory (Chromium only, may be
 * undefined). Returns the maximum duration in seconds.
 */
export function maxFullProcessSeconds({ deviceMemoryGB, isMobile }) {
  let budgetBytes;
  if (typeof deviceMemoryGB === "number") {
    budgetBytes = deviceMemoryGB * 1024 ** 3 * 0.25;
  } else {
    budgetBytes = (isMobile ? 1 : 2) * 1024 ** 3 * 0.25 * 2; // 0.5 GB mobile / 1 GB desktop
  }
  const seconds = Math.floor(budgetBytes / BYTES_PER_AUDIO_SECOND);
  return Math.max(120, Math.min(seconds, 60 * 60));
}

/** Returns { level: "ok" | "warn" | "block", message }. */
export function checkDuration(durationSec, limits) {
  const max = maxFullProcessSeconds(limits);
  if (durationSec > max) {
    return {
      level: "block",
      message: `This file is ${fmt(durationSec)} long. To avoid running out of memory on this device, full processing is limited to about ${fmt(max)}. You can still preview the first 60 seconds, or split the file into shorter parts.`,
    };
  }
  if (durationSec > max * 0.6) {
    return {
      level: "warn",
      message: `This is a long file (${fmt(durationSec)}). If processing fails, close other tabs or try a shorter file.`,
    };
  }
  return { level: "ok", message: "" };
}

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
