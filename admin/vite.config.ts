import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: '/admin/',
  plugins: [vue()],
  server: {
    port: 5181,
    proxy: {
      '/api': { target: 'https://api.yyheart.com', changeOrigin: true },
    },
  },
});
