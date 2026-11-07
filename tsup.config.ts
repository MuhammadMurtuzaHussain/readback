import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: 'esm',
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: false,
  banner: { js: '#!/usr/bin/env node' },
  external: ['@babel/parser', 'ignore', 'web-tree-sitter', 'tree-sitter-python'],
});
