import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['server.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: false,
  clean: false,
  splitting: false,
  target: 'es2020',
  outDir: 'dist',
  minify: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
