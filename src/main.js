import { DeepFilterNet3Core } from "deepfilternet3-noise-filter";
import lamejs from "@breezystack/lamejs";
import * as Mp4Muxer from "mp4-muxer";
import * as WebmMuxer from "webm-muxer";
import { normalizeLoudness, checkDuration, MAX_FILE_BYTES } from "./dsp.js";

// The service worker only caches the model assets. Never block processing on it:
// if registration fails or takes too long we carry on without the cache.
const swReady =
  "serviceWorker" in navigator
    ? Promise.race([
        navigator.serviceWorker
          .register("./sw.js")
          .then(() => navigator.serviceWorker.ready),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]).catch(() => {})
    : Promise.resolve();

const SAMPLE_RATE = 48000;
const PREVIEW_SECONDS = 60;
const MODEL_URL = new URL("./model", window.location.href).toString();
const HAS_AUDIO_ENCODER = typeof AudioEncoder !== "undefined";
const SUPPORTED_OUTPUTS = ["wav", "mp3"];
if (HAS_AUDIO_ENCODER) SUPPORTED_OUTPUTS.push("m4a", "ogg");

const $ = (id) => document.getElementById(id);

const dropZone = $("dropZone");
const fileInput = $("fileInput");
const levelSlider = $("levelSlider");
const levelValue = $("levelValue");
const previewBtn = $("previewBtn");
const processBtn = $("processBtn");
const progressSection = $("progressSection");
const statusLabel = $("statusLabel");
const statusDetail = $("statusDetail");
const progressBar = $("progressBar");
const resultSection = $("resultSection");
const originalAudio = $("originalAudio");
const filteredAudio = $("filteredAudio");
const downloadBtn = $("downloadBtn");
const resetBtn = $("resetBtn");
const errorEl = $("error");
const normalizeCheck = $("normalizeCheck");
const eqCheck = $("eqCheck");
const compressCheck = $("compressCheck");
const cancelBtn = $("cancelBtn");
const noticeEl = $("notice");
const limitWarning = $("limitWarning");
const voiceWarning = $("voiceWarning");
const formatSelect = $("formatSelect");

const isChromium = !!window.chrome;
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
if (!isChromium && !isSafari) {
  $("browserBanner").style.display = "block";
}
if (!HAS_AUDIO_ENCODER) {
  for (const val of ["m4a", "ogg"]) {
    const opt = formatSelect.querySelector(`[value="${val}"]`);
    opt.disabled = true;
    opt.textContent += " — not supported in this browser";
  }
}

const MISSING_FEATURES = [];
if (typeof WebAssembly === "undefined") MISSING_FEATURES.push("WebAssembly");
if (typeof AudioWorkletNode === "undefined") MISSING_FEATURES.push("AudioWorklet");
if (typeof OfflineAudioContext === "undefined") MISSING_FEATURES.push("OfflineAudioContext");

const IS_MOBILE = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
const LIMIT_INFO = {
  deviceMemoryGB: navigator.deviceMemory, // Chromium only; undefined elsewhere
  isMobile: IS_MOBILE,
};

let fullProcessBlocked = false;
let selectedFile = null;
let filteredBlobUrl = null;
let originalBlobUrl = null;
let decodedMono = null;
let previewState = null;
let lastMeasuredSpeed = 0;

function setIdleButtons() {
  previewBtn.disabled = !selectedFile;
  processBtn.disabled = !selectedFile || fullProcessBlocked;
}

function onSettingsChange() {
  if (selectedFile && resultSection.classList.contains("visible")) {
    setIdleButtons();
  }
}

levelSlider.addEventListener("input", () => {
  levelValue.textContent = levelSlider.value;
  onSettingsChange();
});
normalizeCheck.addEventListener("change", onSettingsChange);
eqCheck.addEventListener("change", onSettingsChange);
compressCheck.addEventListener("change", onSettingsChange);
formatSelect.addEventListener("change", onSettingsChange);

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () =>
  dropZone.classList.remove("dragover"),
);
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});
$("demoBtn").addEventListener("click", async () => {
  $("demoBtn").disabled = true;
  try {
    const response = await fetch("./demo.wav");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    await handleFile(new File([blob], "demo_noisy_speech.wav", { type: "audio/wav" }));
  } catch (err) {
    showError(`Could not load the demo audio: ${err.message}`);
  } finally {
    $("demoBtn").disabled = false;
  }
});

async function handleFile(file) {
  if (MISSING_FEATURES.length) {
    showError(`This browser is missing required features: ${MISSING_FEATURES.join(", ")}. Please use a current version of Chrome, Edge or Safari.`);
    return;
  }
  stopPreview();
  revokeUrls();
  resultSection.classList.remove("visible");
  noticeEl.style.display = "none";
  limitWarning.style.display = "none";
  fullProcessBlocked = false;
  if (file.size > MAX_FILE_BYTES) {
    selectedFile = null;
    decodedMono = null;
    showError(`This file is ${(file.size / 1048576).toFixed(0)} MB. Files over ${MAX_FILE_BYTES / 1048576} MB are not supported because decoding them in the browser can exhaust memory.`);
    return;
  }
  selectedFile = file;
  decodedMono = null;
  dropZone.textContent = file.name;
  dropZone.classList.add("has-file");
  errorEl.classList.remove("visible");

  updateAutoFormatLabel();

  $("controlsSection").style.display = "";
  previewBtn.disabled = true;
  processBtn.disabled = true;
  levelSlider.disabled = true;
  statusLabel.textContent = "Analyzing audio…";
  statusDetail.textContent = "";
  progressBar.style.width = "0%";
  progressBar.classList.remove("done");
  progressBar.classList.add("indeterminate");
  progressSection.classList.add("visible");

  try {
    const mono = await decodeFile();

    const limit = checkDuration(mono.length / SAMPLE_RATE, LIMIT_INFO);
    if (limit.level !== "ok") {
      limitWarning.textContent = limit.message;
      limitWarning.style.display = "";
    }
    fullProcessBlocked = limit.level === "block";

    const suggested = estimateNoiseLevel(mono);
    levelSlider.value = suggested;
    levelValue.textContent = suggested;

    const isSpeech = detectSpeech(mono);
    if (!isSpeech) {
      normalizeCheck.checked = false;
      eqCheck.checked = false;
      compressCheck.checked = false;
      voiceWarning.style.display = "";
    } else {
      normalizeCheck.checked = true;
      eqCheck.checked = true;
      compressCheck.checked = true;
      voiceWarning.style.display = "none";
    }

    levelSlider.disabled = false;
    setIdleButtons();
    progressBar.classList.remove("indeterminate");
    progressSection.classList.remove("visible");
  } catch (err) {
    progressBar.classList.remove("indeterminate");
    console.error(err);
    showError(friendlyError(err, "Failed to analyze audio"));
  }
}

previewBtn.addEventListener("click", () => togglePreview());
processBtn.addEventListener("click", () => processAudio());
resetBtn.addEventListener("click", () => {
  stopPreview();
  resultSection.classList.remove("visible");
  progressSection.classList.remove("visible");
  setIdleButtons();
  revokeUrls();
});

cancelBtn.addEventListener("click", () => {
  cancelBtn.disabled = true;
  statusLabel.textContent = "Cancelling…";
  cancelJob();
});

downloadBtn.addEventListener("click", () => {
  if (!filteredBlobUrl) return;
  const a = document.createElement("a");
  a.href = filteredBlobUrl;
  const baseName = selectedFile.name.replace(/\.[^.]+$/, "");
  const fmt = resolveFormat();
  a.download = `${baseName}_filtered.${FORMAT_EXT[fmt]}`;
  a.click();
});

function revokeUrls() {
  if (filteredBlobUrl) URL.revokeObjectURL(filteredBlobUrl);
  if (originalBlobUrl) URL.revokeObjectURL(originalBlobUrl);
  filteredBlobUrl = null;
  originalBlobUrl = null;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.add("visible");
  progressSection.classList.remove("visible");
  setIdleButtons();
  setTitle(null);
}

function showNotice(msg) {
  noticeEl.textContent = msg;
  noticeEl.style.display = "";
  progressSection.classList.remove("visible");
  setIdleButtons();
  setTitle(null);
}

class CancelError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelError";
  }
}

// One "job" per preview/process run. Cancelling aborts model downloads and,
// where OfflineAudioContext.suspend() is available, stops rendering at the
// next 2-second checkpoint by never resuming the context.
let job = null;
function startJob() {
  job = { cancelled: false, abort: new AbortController(), onCancel: [] };
  cancelBtn.disabled = false;
  noticeEl.style.display = "none";
  return job;
}
function cancelJob() {
  if (!job || job.cancelled) return;
  job.cancelled = true;
  job.abort.abort();
  for (const fn of job.onCancel) fn();
}

function friendlyError(err, prefix) {
  const msg = err?.message || String(err);
  if (err instanceof RangeError || /out of memory|allocation failed|memory/i.test(msg)) {
    return `${prefix}: the device ran out of memory. Try a shorter file, close other tabs, or use the 60-second preview.`;
  }
  if (err?.name === "EncodingError" || /decode/i.test(msg)) {
    return `${prefix}: this file could not be decoded by your browser. Try converting it to WAV, MP3 or M4A first.`;
  }
  return `${prefix}: ${msg}`;
}

const DEFAULT_TITLE = document.title;

function setTitle(prefix) {
  document.title = prefix ? `${prefix} ${DEFAULT_TITLE}` : DEFAULT_TITLE;
}

function setProgress(pct, label, detail) {
  progressBar.style.width = `${pct}%`;
  if (label) statusLabel.textContent = label;
  if (detail !== undefined) statusDetail.textContent = detail;
}

async function decodeFile() {
  if (decodedMono) return decodedMono;
  const arrayBuffer = await selectedFile.arrayBuffer();
  const decodeCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
  await decodeCtx.close();
  decodedMono = mixToMono(audioBuffer);
  return decodedMono;
}

// ---- Lazy model loading -------------------------------------------------
// Nothing is downloaded until the user starts a preview or full run.
// Paths and cache name mirror public/sw.js, which caches exactly these URLs.
// Sizes are only used for the progress bar (bytes of the files in public/).
const MODEL_CACHE_NAME = "deepfilter-model-v1";
const MODEL_ASSETS = [
  { path: "/v2/pkg/df_bg.wasm", label: "AI engine", approxBytes: 9622975 },
  { path: "/v2/models/DeepFilterNet3_onnx.tar.gz", label: "AI model", approxBytes: 7983136 },
];
const MODEL_TOTAL_BYTES = MODEL_ASSETS.reduce((n, a) => n + a.approxBytes, 0);

async function prefetchModelAssets(onProgress, signal) {
  let cache = null;
  try {
    cache = await caches.open(MODEL_CACHE_NAME);
  } catch {
    // Cache Storage unavailable (e.g. insecure context): just download.
  }

  let done = 0; // bytes of fully finished assets
  for (const asset of MODEL_ASSETS) {
    const url = `${MODEL_URL}${asset.path}`;
    if (cache && (await cache.match(url))) {
      done += asset.approxBytes;
      onProgress?.({ phase: "download", loaded: done, total: MODEL_TOTAL_BYTES, cached: true });
      continue;
    }

    const res = await fetch(url, { signal });
    if (!res.ok) {
      throw new Error(`Could not download the ${asset.label} (HTTP ${res.status}). Check your connection and try again.`);
    }
    const forCache = res.clone();
    if (res.body) {
      const reader = res.body.getReader();
      let received = 0;
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        received += value.length;
        onProgress?.({
          phase: "download",
          loaded: done + Math.min(received, asset.approxBytes),
          total: MODEL_TOTAL_BYTES,
        });
      }
    } else {
      await res.arrayBuffer();
    }
    done += asset.approxBytes;
    if (cache) {
      try {
        if (!(await cache.match(url))) await cache.put(url, forCache);
      } catch {
        // Not fatal: the model is already downloaded for this session.
      }
    }
  }
}

let corePromise = null;

function ensureCore(onProgress, signal) {
  if (!corePromise) {
    corePromise = (async () => {
      await swReady;
      await prefetchModelAssets(onProgress, signal);
      onProgress?.({ phase: "init" });
      const core = new DeepFilterNet3Core({
        sampleRate: SAMPLE_RATE,
        noiseReductionLevel: 50,
        assetConfig: { cdnUrl: MODEL_URL },
      });
      await core.initialize();
      return core;
    })().catch((err) => {
      corePromise = null; // allow a retry after a failure or cancel
      throw err;
    });
  }
  return corePromise;
}

function modelProgressHandler(e) {
  if (e.phase === "download") {
    const pct = Math.min(99, Math.round((e.loaded / e.total) * 100));
    const mb = (n) => (n / 1048576).toFixed(1);
    setProgress(
      pct,
      e.cached ? "Loading cached AI model…" : "Downloading AI model (first use only)…",
      `${mb(e.loaded)} / ${mb(e.total)} MB`,
    );
  } else if (e.phase === "init") {
    setProgress(0, "Initializing DeepFilterNet3…", "");
  }
}

async function renderOffline(samples, onProgress, onStatusChange, activeJob) {
  onStatusChange?.("Preparing AI model…");
  let core;
  try {
    core = await ensureCore(modelProgressHandler, activeJob.abort.signal);
  } catch (err) {
    if (activeJob.cancelled) throw new CancelError();
    throw err;
  }
  if (activeJob.cancelled) throw new CancelError();
  core.setSuppressionLevel(parseInt(levelSlider.value));
  onStatusChange?.("Processing audio…");
  const duration = samples.length / SAMPLE_RATE;

  const offlineCtx = new OfflineAudioContext(1, samples.length, SAMPLE_RATE);
  const filterNode = await core.createAudioWorkletNode(offlineCtx);

  const source = offlineCtx.createBufferSource();
  const buf = offlineCtx.createBuffer(1, samples.length, SAMPLE_RATE);
  buf.getChannelData(0).set(samples);
  source.buffer = buf;

  source.connect(filterNode);
  filterNode.connect(offlineCtx.destination);

  const startWall = performance.now();
  let estimateTimer = null;

  const supportsCheckpoints = typeof offlineCtx.suspend === "function";
  if (supportsCheckpoints) {
    const checkpointInterval = 2;
    const checkpoints = Math.floor(duration / checkpointInterval);
    for (let i = 1; i <= checkpoints; i++) {
      const t = i * checkpointInterval;
      offlineCtx.suspend(t).then(() => {
        // Cancel: simply never resume. The context stays suspended, rendering
        // stops, and everything is garbage-collected.
        if (activeJob.cancelled) return;
        const pct = Math.round((t / duration) * 100);
        const elapsedWall = (performance.now() - startWall) / 1000;
        const speed = t / elapsedWall;
        lastMeasuredSpeed = speed;
        const remaining = (duration - t) / speed;
        onProgress(pct, `${pct}% — ~${formatTime(remaining)} remaining`);
        offlineCtx.resume();
      });
    }
  } else {
    const speed = lastMeasuredSpeed || 0.5;
    const estimatedTotal = duration / speed;
    estimateTimer = setInterval(() => {
      if (activeJob.cancelled) return;
      const elapsed = (performance.now() - startWall) / 1000;
      const pct = Math.min(95, Math.round((elapsed / estimatedTotal) * 100));
      const remaining = Math.max(0, estimatedTotal - elapsed);
      onProgress(pct, `~${pct}% — ~${formatTime(remaining)} remaining`);
    }, 500);
  }

  source.start(0);
  const cancelPromise = new Promise((_, reject) => {
    activeJob.onCancel.push(() => reject(new CancelError()));
  });
  let renderedBuffer;
  try {
    renderedBuffer = await Promise.race([offlineCtx.startRendering(), cancelPromise]);
  } finally {
    if (estimateTimer) clearInterval(estimateTimer);
  }

  const elapsedTotal = (performance.now() - startWall) / 1000;
  if (duration > 0) lastMeasuredSpeed = duration / elapsedTotal;
  return renderedBuffer;
}

function detectSpeech(samples) {
  const windowSize = 2048;
  const numWindows = Math.min(10, Math.floor(samples.length / windowSize));

  let speechBandTotal = 0;
  let fullBandTotal = 0;

  for (let w = 0; w < numWindows; w++) {
    const offset = Math.floor((w / numWindows) * (samples.length - windowSize));

    for (let freq = 50; freq <= 8000; freq += 100) {
      const k = Math.round(freq * windowSize / SAMPLE_RATE);
      const omega = (2 * Math.PI * k) / windowSize;
      const coeff = 2 * Math.cos(omega);
      let s0 = 0, s1 = 0, s2 = 0;
      for (let n = 0; n < windowSize; n++) {
        s0 = samples[offset + n] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
      fullBandTotal += power;
      if (freq >= 300 && freq <= 3400) speechBandTotal += power;
    }
  }

  return fullBandTotal > 0 && (speechBandTotal / fullBandTotal) > 0.4;
}

async function applyVoiceOptimization(samples) {
  const doNormalize = normalizeCheck.checked;
  const doEq = eqCheck.checked;
  const doCompress = compressCheck.checked;

  if (!doNormalize && !doEq && !doCompress) return samples;

  let out = samples;

  if (doEq || doCompress) {
    const offlineCtx = new OfflineAudioContext(1, samples.length, SAMPLE_RATE);

    const buf = offlineCtx.createBuffer(1, samples.length, SAMPLE_RATE);
    buf.getChannelData(0).set(samples);
    const source = offlineCtx.createBufferSource();
    source.buffer = buf;

    let chain = source;

    if (doEq) {
      const highpass = offlineCtx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 80;
      highpass.Q.value = 0.7;
      chain.connect(highpass);
      chain = highpass;

      const presence = offlineCtx.createBiquadFilter();
      presence.type = "peaking";
      presence.frequency.value = 3000;
      presence.Q.value = 1.0;
      presence.gain.value = 3;
      chain.connect(presence);
      chain = presence;
    }

    if (doCompress) {
      // Gentle speech compression (standard Web Audio DynamicsCompressorNode).
      const comp = offlineCtx.createDynamicsCompressor();
      comp.threshold.value = -24;
      comp.knee.value = 12;
      comp.ratio.value = 3;
      comp.attack.value = 0.005;
      comp.release.value = 0.2;
      chain.connect(comp);
      chain = comp;
    }

    chain.connect(offlineCtx.destination);
    source.start(0);
    const rendered = await offlineCtx.startRendering();
    out = rendered.getChannelData(0);
  }

  // Normalize AFTER EQ/compression so the final level is what gets measured
  // (compressor makeup gain differs between browsers).
  if (doNormalize) normalizeLoudness(out, SAMPLE_RATE);
  return out;
}

let previewAbort = null;

async function togglePreview() {
  if (previewState || previewAbort) {
    stopPreview();
    return;
  }

  if (!selectedFile) return;

  previewAbort = new AbortController();
  const activeJob = startJob();
  previewBtn.textContent = "Stop preview";
  processBtn.disabled = true;
  progressSection.classList.add("visible");
  progressBar.classList.remove("done");
  setTitle("\u23F3");
  errorEl.classList.remove("visible");

  try {
    setProgress(0, "Decoding audio file…", "");
    const mono = await decodeFile();
    if (activeJob.cancelled) throw new CancelError();

    const previewSamples = mono.length > PREVIEW_SECONDS * SAMPLE_RATE
      ? mono.slice(0, PREVIEW_SECONDS * SAMPLE_RATE)
      : mono;

    setProgress(0, "Preparing…", "");

    const renderedBuffer = await renderOffline(previewSamples, (pct, detail) => {
      setProgress(pct, "Rendering preview…", detail);
    }, (status) => setProgress(0, status, ""), activeJob);

    if (activeJob.cancelled) return;

    const previewDuration = previewSamples.length / SAMPLE_RATE;

    setProgress(95, "Optimizing voice…", "");
    const optimized = await applyVoiceOptimization(renderedBuffer.getChannelData(0));
    if (activeJob.cancelled) return;

    revokeUrls();
    filteredBlobUrl = URL.createObjectURL(encodeWav(optimized, SAMPLE_RATE));
    originalBlobUrl = URL.createObjectURL(encodeWav(previewSamples, SAMPLE_RATE));
    originalAudio.src = originalBlobUrl;
    filteredAudio.src = filteredBlobUrl;
    downloadBtn.style.display = "none";
    resultSection.classList.add("visible");

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const playBuf = ctx.createBuffer(1, optimized.length, SAMPLE_RATE);
    playBuf.getChannelData(0).set(optimized);
    const source = ctx.createBufferSource();
    source.buffer = playBuf;
    source.connect(ctx.destination);

    const startTime = ctx.currentTime;
    source.start(0);
    setTitle("\u25B6\uFE0F");

    const tickProgress = () => {
      if (!previewState) return;
      const elapsed = ctx.currentTime - startTime;
      const pct = Math.min(100, (elapsed / previewDuration) * 100);
      setProgress(pct, "Preview playing…", `${formatTime(elapsed)} / ${formatTime(previewDuration)}`);
      previewState.raf = requestAnimationFrame(tickProgress);
    };

    previewState = { ctx, source, raf: null };
    cancelBtn.disabled = true; // rendering is finished; "Stop preview" stops playback
    tickProgress();

    source.onended = () => stopPreview();
  } catch (err) {
    if (err instanceof CancelError || activeJob.cancelled) {
      stopPreview();
      showNotice("Preview cancelled.");
      return;
    }
    console.error(err);
    stopPreview();
    showError(friendlyError(err, "Preview failed"));
  }
}

function stopPreview() {
  if (previewAbort) {
    previewAbort.abort();
    previewAbort = null;
    cancelJob();
  }
  if (previewState) {
    if (previewState.raf) cancelAnimationFrame(previewState.raf);
    try { previewState.source.stop(); } catch {}
    previewState.ctx.close();
    previewState = null;
  }
  previewBtn.textContent = "Preview (first 60s)";
  setIdleButtons();
  progressSection.classList.remove("visible");
  setTitle(null);
}

async function processAudio() {
  if (!selectedFile || fullProcessBlocked) return;

  stopPreview();
  const activeJob = startJob();
  previewBtn.disabled = true;
  processBtn.disabled = true;
  errorEl.classList.remove("visible");
  resultSection.classList.remove("visible");
  progressSection.classList.add("visible");
  progressBar.classList.remove("done");
  setTitle("\u23F3");

  try {
    setProgress(0, "Decoding audio file…", "");
    const mono = await decodeFile();
    if (activeJob.cancelled) throw new CancelError();

    setProgress(0, "Preparing…", "");

    const renderedBuffer = await renderOffline(mono, (pct, detail) => {
      setProgress(pct, "Processing audio…", detail);
    }, (status) => setProgress(0, status, ""), activeJob);

    if (activeJob.cancelled) throw new CancelError();
    setProgress(90, "Optimizing voice…", "");
    const optimized = await applyVoiceOptimization(renderedBuffer.getChannelData(0));
    if (activeJob.cancelled) throw new CancelError();

    setProgress(95, `Encoding ${resolveFormat().toUpperCase()}…`, "");
    const outputBlob = await encodeAudio(optimized, SAMPLE_RATE);
    if (activeJob.cancelled) throw new CancelError();

    revokeUrls();
    filteredBlobUrl = URL.createObjectURL(outputBlob);
    originalBlobUrl = URL.createObjectURL(selectedFile);
    originalAudio.src = originalBlobUrl;
    filteredAudio.src = filteredBlobUrl;

    progressBar.classList.add("done");
    setProgress(100, "Done!", "");
    setTitle("\u2705");
    downloadBtn.style.display = "";
    resultSection.classList.add("visible");
    setIdleButtons();
  } catch (err) {
    if (err instanceof CancelError || activeJob.cancelled) {
      showNotice("Processing cancelled.");
      return;
    }
    console.error(err);
    showError(friendlyError(err, "Processing failed"));
  }
}

function estimateNoiseLevel(samples) {
  const windowSize = Math.floor(SAMPLE_RATE * 0.05);
  const numWindows = Math.floor(samples.length / windowSize);
  const rmsValues = new Float32Array(numWindows);

  for (let w = 0; w < numWindows; w++) {
    let sum = 0;
    const offset = w * windowSize;
    for (let i = 0; i < windowSize; i++) {
      const s = samples[offset + i];
      sum += s * s;
    }
    rmsValues[w] = Math.sqrt(sum / windowSize);
  }

  const sorted = Array.from(rmsValues).sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(numWindows * 0.1)];
  const signalLevel = sorted[Math.floor(numWindows * 0.9)];

  if (noiseFloor === 0 || signalLevel === 0) return 50;

  const snrDb = 20 * Math.log10(signalLevel / noiseFloor);
  return Math.round(Math.max(5, Math.min(95, 100 - snrDb * 2.5)));
}

function mixToMono(audioBuffer) {
  if (audioBuffer.numberOfChannels === 1) {
    return audioBuffer.getChannelData(0).slice();
  }
  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  const channels = audioBuffer.numberOfChannels;
  for (let ch = 0; ch < channels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += data[i] / channels;
    }
  }
  return mono;
}

const FORMAT_EXT = { wav: "wav", mp3: "mp3", m4a: "m4a", ogg: "ogg" };
const INPUT_TO_OUTPUT = {
  mp3: "mp3",
  m4a: "m4a", aac: "m4a", mp4: "m4a",
  ogg: "ogg", opus: "ogg", webm: "ogg",
};

function resolveFormat() {
  const choice = formatSelect.value;
  if (choice !== "auto") return choice;
  if (!selectedFile) return "wav";
  const ext = selectedFile.name.split(".").pop().toLowerCase();
  const mapped = INPUT_TO_OUTPUT[ext];
  if (mapped && SUPPORTED_OUTPUTS.includes(mapped)) return mapped;
  return "wav";
}

function updateAutoFormatLabel() {
  const autoOpt = formatSelect.querySelector('[value="auto"]');
  const fmt = resolveFormat();
  autoOpt.textContent = `Same as input (${FORMAT_EXT[fmt].toUpperCase()})`;
}

async function encodeAudio(samples, sampleRate) {
  const fmt = resolveFormat();
  if (fmt === "mp3") return encodeMp3(samples, sampleRate);
  if (fmt === "m4a") return encodeWithWebCodecs(samples, sampleRate, {
    MuxerClass: Mp4Muxer.Muxer,
    TargetClass: Mp4Muxer.ArrayBufferTarget,
    muxerOpts: { audio: { codec: "aac", sampleRate, numberOfChannels: 1 }, fastStart: "in-memory" },
    codec: "mp4a.40.2",
    bitrate: 192000,
    frameSize: 1024,
    mimeType: "audio/mp4",
  });
  if (fmt === "ogg") return encodeWithWebCodecs(samples, sampleRate, {
    MuxerClass: WebmMuxer.Muxer,
    TargetClass: WebmMuxer.ArrayBufferTarget,
    muxerOpts: { type: "webm", audio: { codec: "A_OPUS", sampleRate, numberOfChannels: 1 } },
    codec: "opus",
    bitrate: 128000,
    frameSize: 960,
    mimeType: "audio/ogg",
  });
  return encodeWav(samples, sampleRate);
}

function floatToInt16(samples) {
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    int16[i] = Math.max(-1, Math.min(1, samples[i])) * 0x7fff;
  }
  return int16;
}

function encodeMp3(samples, sampleRate) {
  const mp3enc = new lamejs.Mp3Encoder(1, sampleRate, 192);
  const int16 = floatToInt16(samples);

  const chunks = [];
  const blockSize = 1152;
  for (let i = 0; i < int16.length; i += blockSize) {
    const buf = mp3enc.encodeBuffer(int16.subarray(i, i + blockSize));
    if (buf.length > 0) chunks.push(buf);
  }
  const end = mp3enc.flush();
  if (end.length > 0) chunks.push(end);

  return new Blob(chunks, { type: "audio/mpeg" });
}

async function encodeWithWebCodecs(samples, sampleRate, config) {
  if (!HAS_AUDIO_ENCODER) return encodeWav(samples, sampleRate);

  const target = new config.TargetClass();
  const muxer = new config.MuxerClass({ target, ...config.muxerOpts });

  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => console.error("AudioEncoder error:", e),
  });

  encoder.configure({
    codec: config.codec,
    sampleRate,
    numberOfChannels: 1,
    bitrate: config.bitrate,
  });

  for (let i = 0; i < samples.length; i += config.frameSize) {
    const end = Math.min(i + config.frameSize, samples.length);
    const frameData = new Float32Array(end - i);
    frameData.set(samples.subarray(i, end));
    const audioData = new AudioData({
      format: "f32",
      sampleRate,
      numberOfFrames: frameData.length,
      numberOfChannels: 1,
      timestamp: (i / sampleRate) * 1_000_000,
      data: frameData,
    });
    encoder.encode(audioData);
    audioData.close();
  }

  await encoder.flush();
  encoder.close();
  muxer.finalize();

  return new Blob([target.buffer], { type: config.mimeType });
}

function encodeWav(samples, sampleRate) {
  const int16 = floatToInt16(samples);
  const buffer = new ArrayBuffer(44 + int16.byteLength);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + int16.byteLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, int16.byteLength, true);

  new Int16Array(buffer, 44).set(int16);

  return new Blob([buffer], { type: "audio/wav" });
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
