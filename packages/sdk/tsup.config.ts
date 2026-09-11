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
    entry: { browser: 'src/browser.ts' },
    format: ['esm'],
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
        'node:path': './src/shims/node.cjs',
        'node:fs': './src/shims/node.cjs',
        'node:os': './src/shims/node.cjs',
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
        'node:path': './src/shims/node.cjs',
        'node:fs': './src/shims/node.cjs',
        'node:os': './src/shims/node.cjs',
      };
    },
    banner: {
      js: 'var process={version:"",env:{},platform:"browser"};',
    },
  },
]);
