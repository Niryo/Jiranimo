import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // E2E tests share a persistent Chrome profile — they must run sequentially
    fileParallelism: false,
  },
});
