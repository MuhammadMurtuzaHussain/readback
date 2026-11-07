import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Two builds from one UI:
//  viewer: a single self-contained HTML file with no engine. The CLI injects a report into it.
//  site:   the public page, with the engine, so analysis happens in the visitor's browser.
export default defineConfig(({ mode }) => ({
  base: './',
  publicDir: mode === 'viewer' ? false : 'public',
  plugins: [react(), ...(mode === 'viewer' ? [viteSingleFile()] : [])],
  define: { __HAS_ENGINE__: JSON.stringify(mode !== 'viewer') },
  build: {
    outDir: mode === 'viewer' ? 'dist/viewer' : 'dist/site',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: 'es' },
}));
