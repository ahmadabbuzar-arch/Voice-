const CACHE_NAME = "deepfilter-model-v1";
const MODEL_ASSETS = [
  "model/v2/pkg/df_bg.wasm",
  "model/v2/models/DeepFilterNet3_onnx.tar.gz",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isModelAsset = MODEL_ASSETS.some((asset) =>
    url.pathname.endsWith(asset),
  );

  if (!isModelAsset) return;

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          cache.put(event.request, response.clone());
          return response;
        });
      }),
    ),
  );
});
