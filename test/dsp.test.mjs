import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeLoudness, checkDuration, maxFullProcessSeconds } from "../src/dsp.js";

const SR = 48000;

function readWav16Mono(path) {
  const b = readFileSync(path);
  assert.equal(b.toString("ascii", 0, 4), "RIFF");
  let off = 12;
  while (off < b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "data") {
      const n = size / 2;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
const peak = (a) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

test("normalizeLoudness reaches target RMS without exceeding the peak ceiling", () => {
  const x = new Float32Array(SR * 2);
  for (let i = 0; i < x.length; i++) x[i] = 0.02 * Math.sin((2 * Math.PI * 440 * i) / SR);
  const info = normalizeLoudness(x, SR, { targetRmsDb: -20, peakCeilingDb: -1 });
  assert.ok(info.applied);
  assert.ok(Math.abs(20 * Math.log10(rms(x)) + 20) < 0.5);
  assert.ok(peak(x) <= Math.pow(10, -1 / 20) + 1e-6);
});

test("normalizeLoudness respects the peak ceiling on peaky material", () => {
  const x = new Float32Array(SR);
  for (let i = 0; i < x.length; i++) x[i] = 0.05 * Math.sin((2 * Math.PI * 300 * i) / SR);
  x[1000] = 0.5; // a spike
  normalizeLoudness(x, SR);
  assert.ok(peak(x) <= Math.pow(10, -1 / 20) + 1e-6);
});

test("normalizeLoudness leaves digital silence untouched", () => {
  const x = new Float32Array(SR);
  const info = normalizeLoudness(x, SR);
  assert.equal(info.applied, false);
  assert.equal(peak(x), 0);
});

test("normalizeLoudness on the bundled demo.wav stays finite and under the ceiling", () => {
  const x = readWav16Mono(new URL("../public/demo.wav", import.meta.url).pathname);
  assert.ok(x.length > SR * 5);
  const before = Float32Array.from(x);
  normalizeLoudness(x, SR);
  assert.ok(x.every(Number.isFinite));
  assert.ok(peak(x) <= Math.pow(10, -1 / 20) + 1e-6);
  assert.notDeepEqual(Array.from(x.slice(0, 1000)), Array.from(before.slice(0, 1000)));
});

test("duration limits scale with device memory and block overlong files", () => {
  const low = maxFullProcessSeconds({ deviceMemoryGB: 2, isMobile: true });
  const high = maxFullProcessSeconds({ deviceMemoryGB: 8, isMobile: false });
  assert.ok(low < high);
  assert.equal(checkDuration(30, { deviceMemoryGB: 4 }).level, "ok");
  assert.equal(checkDuration(60 * 60 * 3, { deviceMemoryGB: 4 }).level, "block");
  assert.ok(checkDuration(60 * 60 * 3, { deviceMemoryGB: 4 }).message.length > 0);
});
