import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
  },
  // SWC emits the decorator metadata Nest needs for dependency injection.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
