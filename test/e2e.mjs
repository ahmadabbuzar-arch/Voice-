// Browser smoke test for the REAL pipeline (DeepFilterNet3 WASM + AudioWorklet).
// NOT run by the author (no network / no browser in the authoring sandbox).
//
//   npm run build
//   npm i --no-save playwright && npx playwright install --with-deps chromium
//   node test/e2e.mjs
//
// Serves ./dist, loads the demo file, processes it, downloads the WAV and checks
// that it is a valid, playable-length WAV that differs from the input.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import assert from "node:assert/strict";

const root = new URL("../dist/", import.meta.url).pathname;
const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".wav": "audio/wav", ".css": "text/css" };
const server = createServer(async (req, res) => {
  try {
    const rel = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(root, rel.endsWith("/") ? rel + "index.html" : rel);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
}).listen(4173);

const browser = await chromium.launch();
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:4173/");
await page.click("#demoBtn");
await page.waitForFunction(() => !document.querySelector("#processBtn").disabled, null, { timeout: 60000 });
await page.click("#processBtn");
await page.waitForSelector("#resultSection.visible", { timeout: 15 * 60 * 1000 });
const [download] = await Promise.all([page.waitForEvent("download"), page.click("#downloadBtn")]);
await writeFile("e2e-output.wav", await readFile(await download.path()));
await browser.close();
server.close();

const out = await readFile("e2e-output.wav");
const orig = await readFile(new URL("../public/demo.wav", import.meta.url));
assert.equal(out.toString("ascii", 0, 4), "RIFF");
assert.equal(out.toString("ascii", 8, 12), "WAVE");
assert.equal(out.readUInt32LE(24), 48000);
const outSamples = (out.length - 44) / 2, origSamples = (orig.length - 44) / 2;
assert.ok(Math.abs(outSamples - origSamples) < 48000 * 0.1, "length should match the input");
let diff = 0, nonzero = 0;
for (let i = 0; i < 20000; i++) {
  const a = out.readInt16LE(44 + i * 2 + 96000), b = orig.readInt16LE(44 + i * 2 + 96000);
  if (a !== b) diff++;
  if (a !== 0) nonzero++;
}
assert.ok(diff > 10000 && nonzero > 1000, "output must differ from input and not be silent");
assert.deepEqual(errors, [], "no page errors");
console.log("e2e OK -> e2e-output.wav");
