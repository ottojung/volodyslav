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
            registerType: "prompt",
            manifest: {
                name: "Volodyslav",
                short_name: "Volodyslav",
                start_url: "/",
                display: "standalone",
                background_color: "#ffffff",
                theme_color: "#000000",
            },
            injectManifest: {
                swSrc: "src/sw.js", // This is correct
                swDest: "dist/sw.js", // But we need to specify the full destination
                // Disable minification to avoid terser
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
