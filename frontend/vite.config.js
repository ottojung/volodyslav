import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxy upload API calls to backend during development
      '/upload': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  }
});