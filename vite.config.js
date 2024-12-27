import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/lp-data/',
  server: {
    fs: {
      // Allow serving files from root directory
      allow: ['..']
    }
  }
})
