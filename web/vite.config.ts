import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': { target: 'https://api.yyheart.com', changeOrigin: true },
      '/ws': { target: 'wss://api.yyheart.com', ws: true },
      '/res': { target: 'https://api.yyheart.com', changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
});
