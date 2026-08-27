import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': { target: 'http://8.162.5.160:20080', changeOrigin: true },
      '/ws': { target: 'ws://8.162.5.160:20080', ws: true },
      '/res': { target: 'http://8.162.5.160:20080', changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
});
