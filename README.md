# AI Voice Enhancer (based on boredland/noise)

Browser-based voice enhancement. Background noise is removed by the
[DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet) AI model running
client-side via WebAssembly + AudioWorklet. **No uploads, no server, no paid APIs.**

> Status: the code changes listed under "What changed" were written without network
> access and have **not** been built or run in a browser. Follow
> [Test it](#test-it-github-codespaces) before deploying.

## Features

- Upload audio from your device (or use the demo clip)
- AI noise reduction with a strength slider (auto-suggested from an SNR estimate)
- Voice enhancement: high-pass + presence EQ, compressor, loudness normalization
- Original / enhanced players for comparison; 60-second preview
- Download as WAV (MP3, M4A, OGG also offered; inherited from the original project, not re-tested)
- Progress, **Cancel** button, clear error messages
- Light, mobile-first UI
- AI model (~17 MB) is downloaded **only when you first preview/process**, with progress, then cached by the service worker

## What changed vs. the original repo

| File | Change |
| --- | --- |
| `src/main.js` | Lazy model loading with download progress; cancel support; compressor; loudness normalization moved after EQ/compression; memory/duration limits; friendlier errors; fixed "stop preview" still playing after cancel |
| `src/dsp.js` (new) | Pure helpers: loudness normalization, memory/duration limits |
| `index.html` | Light theme only, mobile layout, compressor toggle, Cancel button, WAV default |
| `test/dsp.test.mjs` (new) | Unit tests for `src/dsp.js` (run and passing) |
| `test/e2e.mjs` (new) | Browser smoke test of the real pipeline (**not yet run**) |
| `vercel.json` (new) | Build/output config and cache headers |

Unchanged: the DeepFilterNet3 engine usage (`DeepFilterNet3Core`, `createAudioWorkletNode`,
48 kHz mono, `OfflineAudioContext` rendering), `public/sw.js`, model and WASM files, GitHub Pages workflow.

## Test it (GitHub Codespaces)

```sh
npm install            # or: bun install
npm test               # unit tests (fast, no browser)
npm run build          # must finish without errors
npm run dev            # open the forwarded port (5173) in a browser
```

Manual checklist (Chrome, then Safari if possible):

1. Fresh page: DevTools > Network shows **no** `df_bg.wasm` / `.tar.gz` request until you click Preview or Process.
2. Click "Try with demo audio", then Preview: the progress card shows "Downloading AI model…" with MB counts, then rendering.
3. Reload and preview again: model loads from cache (label "Loading cached AI model…", no new large downloads).
4. Process the full demo, play Original vs Enhanced (background noise should be audibly reduced), download the WAV and open it in a player.
5. Start processing and press Cancel: progress stops within ~2 s and "Processing cancelled." appears. Run again afterwards to confirm it still works.
6. Cancel during the first model download; confirm a retry works.
7. Console shows no errors. Try a corrupt/non-audio file and confirm a clear message.

Automated smoke test of the real engine (needs a browser download):

```sh
npm run build
npm i --no-save playwright && npx playwright install --with-deps chromium
node test/e2e.mjs
```

If `npm run dev` shows a model/WASM 404 or an initialization error, open DevTools > Network and
compare the requested URL with `public/model/v2/...`; the wrapper library decides those paths
(see "Known limitations").

## Deploy

### GitHub

```sh
git init && git add . && git commit -m "AI Voice Enhancer"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

The included workflow deploys to GitHub Pages on push to `main` (enable Pages > Source: GitHub Actions).

### Vercel

1. Push the repo to GitHub.
2. Vercel > Add New > Project > import the repo. Framework preset: Vite.
3. `vercel.json` sets build command `npm run build` and output `dist`. Leave Install Command on auto-detect; if the install step fails with the Bun lockfile, override it with `npm install`.
4. Deploy. The page must be served over HTTPS (Vercel does this) for the service worker and AudioWorklet.

## Known limitations

- **Not built or run in a browser by the author.** Only `src/dsp.js` was executed (unit tests, including one on `public/demo.wav`). The AI path, cancellation, progress UI and layout are unverified.
- Model download progress comes from my own prefetch of the two asset URLs found in `public/sw.js`. If the wrapper library requests different URLs or cache keys, the model could download twice (progress still works, but wastes bandwidth). Check the Network tab.
- Cancel stops rendering at the next 2-second checkpoint via `OfflineAudioContext.suspend()`. If a browser lacks `suspend`, cancel only discards the result; the render finishes in the background.
- Processing runs on the main thread (the OfflineAudioContext is not available in Web Workers). The AI itself runs in an AudioWorklet. The tab can feel sluggish on long files.
- Memory limits are a heuristic based on `navigator.deviceMemory` (Chromium only) and a rough copy-count model; real low-memory phones were not tested. Files over 200 MB are rejected.
- Output is mono 48 kHz (original behavior). Stereo input is mixed down.
- Loudness normalization is RMS-based with a peak ceiling, not LUFS. Compressor makeup gain varies by browser; normalization compensates.
- Firefox is much slower for WASM workloads (see original project notes).
- MP3/M4A/OGG export is inherited and untested here; WAV is the recommended format.
- The repository has **no LICENSE file**. See `NOTICE.md`.

## Credits

- [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) by Hendrik Schröter
- [boredland/noise](https://github.com/boredland/noise) (original web app)
- [deepfilternet3-noise-filter](https://www.npmjs.com/package/deepfilternet3-noise-filter) WASM/AudioWorklet wrapper by Mezon
- [@breezystack/lamejs](https://www.npmjs.com/package/@breezystack/lamejs), [mp4-muxer](https://www.npmjs.com/package/mp4-muxer), [webm-muxer](https://www.npmjs.com/package/webm-muxer)
