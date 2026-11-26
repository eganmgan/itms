import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export function isLocalPreviewOrigin(origin: string | undefined, host: string | undefined) {
  if (!origin || !host || origin !== `http://${host}`) return false
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)
  } catch {
    return false
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_TARGET || 'http://127.0.0.1:3001',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            if (isLocalPreviewOrigin(request.headers.origin, request.headers.host)) proxyRequest.removeHeader('origin')
          })
        },
      },
      '/ws': {
        target: process.env.VITE_BACKEND_TARGET || 'http://127.0.0.1:3001',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
