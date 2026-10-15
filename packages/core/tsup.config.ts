import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: false,
    clean: true,
    splitting: false,
    treeshake: true,
    minify: true,
    target: 'es2020',
  },
  {
    // Browser-safe surface (`src/browser.ts`, pure modules only, no builtin
    // imports). Resolvers with an active `browser` condition (Vite client)
    // take `exports["."].browser`; Node skips it and falls to import/require.
    entry: { browser: 'src/browser.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: false,
    clean: false,
    splitting: false,
    treeshake: true,
    minify: true,
    target: 'es2020',
  },
]);
