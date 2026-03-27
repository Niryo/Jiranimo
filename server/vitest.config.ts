import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', '../extension/**/*.test.js'],
    exclude: ['**/*.integration.test.ts', '**/*.e2e.test.ts'],
  },
});
