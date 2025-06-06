import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const port = parseInt(process.env.VOLODYSLAV_SERVER_PORT);

export default defineConfig({
    plugins: [
        react(),
        VitePWA({
            strategies: "injectManifest",
            srcDir: "src",
            filename: "sw.js",
            registerType: "autoUpdate",
            workbox: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg}']
            },
            includeAssets: ['**/*'],
            manifest: {
                name: "Volodyslav",
                short_name: "Volodyslav",
                start_url: "/",
                display: "standalone",
                background_color: "#ffffff",
                theme_color: "#000000",
                description: "Volodyslav PWA Application",
                orientation: "portrait-primary",
                scope: "/",
                icons: [
                    {
                        src: "/icon-192.png",
                        sizes: "192x192",
                        type: "image/png",
                        purpose: "any maskable"
                    },
                    {
                        src: "/icon-512.png",
                        sizes: "512x512",
                        type: "image/png",
                        purpose: "any maskable"
                    }
                ]
            },
            injectManifest: {
                swSrc: "src/sw.js",
                // swDest should be relative to the build outDir.
                // Using "dist/sw.js" here would nest the output as
                // "dist/dist/sw.js". Keep just the filename to place the
                // service worker directly in the outDir.
                swDest: "sw.js",
                minify: false,
                rollupFormat: "es",
            },
        }),
    ],
    server: {
        proxy: {
            // Proxy upload API calls to backend.
            "/api/upload": {
                target: `http://localhost:${port}`,
                changeOrigin: true,
            },
        },
    },
    build: {
        // Use esbuild instead of terser for better Termux compatibility
        minify: "esbuild",
        // Optimize for Termux environment
        rollupOptions: {
            output: {
                manualChunks: undefined,
            },
        },
    },
});
