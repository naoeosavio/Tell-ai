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
    // Pure text helpers with no `node:*` import, published as a subpath so the
    // browser bundles (Web frontend) can own the same wording without pulling
    // the Node runtime into the client build.
    entry: { 'loop-feedback': 'src/loop-feedback.ts' },
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
