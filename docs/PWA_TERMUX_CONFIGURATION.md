# PWA Termux Configuration

This project targets Android devices running [Termux](https://termux.dev/). The default Workbox build step used by `vite-plugin-pwa` relies on `terser`, which is not always available in Termux environments. To keep the build lightweight and compatible the service worker is hand written, and instead of `terser`, we use `esbuild`.

Key points:

- **injectManifest strategy** – see `frontend/vite.config.js`. The service worker source lives in `frontend/src/sw.js` and is copied as-is during the build.
- **esbuild minify** – the Vite build step uses `esbuild` instead of `terser`.

These adjustments allow the PWA build to complete inside Termux without additional native dependencies.
