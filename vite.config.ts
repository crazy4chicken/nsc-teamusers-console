import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src',
  envDir: '..',
  plugins: [vue()],
  envPrefix: 'TUCONSOLE_',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    outDir: '../dist'
  },
  server: {
    port: 5173,
    proxy: {
      // The service is root-relative; the /iam prefix is added by the public
      // reverse proxy (Strip forwarding) and must be stripped before the
      // request reaches the backend.
      '/iam': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/iam/, '')
      }
    }
  }
})
