import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['lib/**/*.test.js', 'content/**/*.test.js'],
    environment: 'node',
  },
});
