import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Require a valid port from the environment.
const rawPort = process.env.VOLODYSLAV_SERVER_PORT;
const port = Number.parseInt(rawPort ?? "", 10);
if (!rawPort || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Environment variable VOLODYSLAV_SERVER_PORT must be a valid port");
}

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
                swDest: "dist/sw.js",
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
