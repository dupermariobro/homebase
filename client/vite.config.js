import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5183,
    host: true,
    proxy: {
      '/api': 'http://127.0.0.1:4830',
      '/ws': { target: 'ws://127.0.0.1:4830', ws: true },
    },
  },
});
