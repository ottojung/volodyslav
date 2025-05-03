
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
       // Proxy upload API calls to backend.
      '/upload': {
        target: 'http://localhost:29932',
        changeOrigin: true,
      },
    },
  }
});
