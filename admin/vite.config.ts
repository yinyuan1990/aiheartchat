import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: '/admin/',
  plugins: [vue()],
  server: {
    port: 5181,
    proxy: {
      '/api': { target: 'http://8.162.5.160:20080', changeOrigin: true },
    },
  },
});
