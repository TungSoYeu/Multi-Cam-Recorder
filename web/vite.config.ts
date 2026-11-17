import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Khi dev: web chạy ở 5173, gọi /api được chuyển tiếp sang server 3000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
