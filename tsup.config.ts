import { defineConfig } from 'tsup';
export default defineConfig([
  {
    entry: { Tell: 'src/cli.ts' },
    format: ['cjs'],
    sourcemap: false,
    splitting: false,
    target: 'es2020',
    outDir: 'dist',
    minify: true,
    dts: false,
    clean: true,
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['cjs', 'esm'],
    sourcemap: false,
    splitting: false,
    target: 'es2020',
    outDir: 'dist',
    minify: true,
    dts: true,
    clean: false,
  },
]);
