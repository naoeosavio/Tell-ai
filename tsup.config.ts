import { defineConfig } from 'tsup';
  export default defineConfig({
  entry: ['src/Tell.ts'],
  format: ["cjs"],
  dts: false,
  sourcemap: false,
  clean: true,
  splitting: false,
  target: "es2020",
  outDir: "dist",
  minify: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});