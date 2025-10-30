import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      // Include the popup HTML, background worker, and content script as entries
      input: {
        popup: 'index.html',
        background: 'src/background.ts',
        content: 'src/content/automation.ts'
      },
      output: {
        // Emit deterministic filenames required by the manifest
        entryFileNames: (chunk) => {
          if (chunk.name === 'background') {
            return 'background.js';
          }
          if (chunk.name === 'content') {
            return 'content.js';
          }
          return 'assets/[name]-[hash].js';
        },
      }
    },
  },
});