import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      outDir: 'dist-electron/main',
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron/preload',
      rollupOptions: {
        input: {
          // Main app preload
          index: resolve('src/preload/index.ts'),
          // Plaid Link child-window preload — compiled separately
          'plaid-link-preload': resolve('electron/preload/plaid-link-preload.ts'),
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    build: { outDir: 'dist' }
  }
})
