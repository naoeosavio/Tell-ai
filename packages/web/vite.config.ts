import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // esbuild 0.28 cannot lower destructuring to safari14 (part of Vite's
      // default ESBUILD_MODULES_TARGET); pin to es2020 (same as the server
      // tsup target) so no downlevel transform is attempted.
      target: 'es2020',
    },
    // No custom dev-server tweaks: default HMR + file watching.
  };
});
