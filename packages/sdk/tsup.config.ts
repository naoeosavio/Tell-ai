import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // `src/index.ts` is the main entry; `src/pure.ts` is the dependency-free
    // protocol surface (tags, system prompt, wire constants — no provider, no
    // network). Same build config on purpose: tsup runs the configs of this
    // file in parallel and the `clean: true` below wipes `dist/`, so a fast
    // extra config would lose its artifacts to that race.
    entry: ['src/index.ts', 'src/pure.ts'],
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
    entry: { browser: 'src/browser.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: false,
    clean: false,
    splitting: false,
    treeshake: true,
    minify: true,
    target: 'es2020',
    noExternal: [
      'ai',
      '@ai-sdk/anthropic',
      '@ai-sdk/cerebras',
      '@ai-sdk/deepseek',
      '@ai-sdk/google',
      '@ai-sdk/moonshotai',
      '@ai-sdk/openai',
      '@ai-sdk/openai-compatible',
      '@ai-sdk/xai',
    ],
    esbuildOptions(options) {
      options.alias = {
        path: './src/shims/node.cjs',
        fs: './src/shims/node.cjs',
        os: './src/shims/node.cjs',
      };
    },
    banner: {
      js: 'var process={version:"",env:{},platform:"browser"};',
    },
  },
  {
    entry: { 'browser-global': 'src/browser-global.ts' },
    format: ['iife'],
    globalName: 'TellSDKGlobal',
    dts: false,
    sourcemap: false,
    clean: false,
    splitting: false,
    treeshake: true,
    minify: true,
    target: 'es2020',
    noExternal: [
      'ai',
      '@ai-sdk/anthropic',
      '@ai-sdk/cerebras',
      '@ai-sdk/deepseek',
      '@ai-sdk/google',
      '@ai-sdk/moonshotai',
      '@ai-sdk/openai',
      '@ai-sdk/openai-compatible',
      '@ai-sdk/xai',
    ],
    esbuildOptions(options) {
      options.alias = {
        path: './src/shims/node.cjs',
        fs: './src/shims/node.cjs',
        os: './src/shims/node.cjs',
      };
    },
    banner: {
      js: 'var process={version:"",env:{},platform:"browser"};',
    },
  },
]);
