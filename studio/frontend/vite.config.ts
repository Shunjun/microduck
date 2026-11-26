import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: '../web-dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/studio.js',
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.css'))
            ? 'assets/studio.css'
            : 'assets/[name][extname]',
      },
    },
  },
})
