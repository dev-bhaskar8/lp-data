import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// Custom plugin to copy CSV files
const copyCSVFiles = () => {
  return {
    name: 'copy-csv-files',
    writeBundle() {
      const csvFiles = ['7d', '30d', '90d'].map(t => `crypto_correlations_${t}.csv`)
      csvFiles.forEach(file => {
        if (fs.existsSync(file)) {
          fs.copyFileSync(file, path.resolve('dist', file))
        }
      })
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), copyCSVFiles()],
  base: process.env.NODE_ENV === 'production' ? '/lp-data/' : '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: './index.html',
      },
      output: {
        manualChunks: undefined,
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'index.css') return 'assets/main.css';
          return 'assets/[name].[ext]';
        },
        chunkFileNames: 'assets/[name].js',
        entryFileNames: 'assets/[name].js'
      }
    }
  },
  server: {
    fs: {
      // Allow serving files from root directory
      allow: ['..']
    }
  }
})
