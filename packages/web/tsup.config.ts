import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { server: 'src/server/server.ts' },
  format: ['esm'],
  dts: false,
  sourcemap: false,
  // clean:true — safe because `npm run build` runs tsup FIRST and then
  // `vite build --emptyOutDir false` appends the frontend assets into the
  // same dist/ (server.js + index.html/assets coexist; __dirname serve).
  clean: true,
  splitting: false,
  target: 'es2020',
  outDir: 'dist',
  // node-pty (native), ws and vite (rollup's native loader) cannot be bundled
  // into the ESM bundle — they are resolved from node_modules at runtime.
  // The AI stack (@tell-ai/sdk + ai + providers) must also stay external:
  // bundling it pulls in @vercel/oidc (a transitive dep of `ai`), whose
  // dynamic require() of node builtins crashes in pure ESM at startup
  // (Error: Dynamic require of "path" is not supported).
  external: ['node-pty', 'ws', 'vite', '@tell-ai/sdk', '@tell-ai/core', 'ai', /^@ai-sdk\//, '@vercel/oidc'],
  minify: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
