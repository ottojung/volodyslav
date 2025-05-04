
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const port = parseInt(process.env.VOLODYSLAV_SERVER_PORT);

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
       // Proxy upload API calls to backend.
      '/api/upload': {
        target: `http://localhost:${port}`,
        changeOrigin: true,
      },
    },
  }
});
