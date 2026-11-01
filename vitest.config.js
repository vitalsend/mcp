import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // Argon2id at MODERATE limits takes seconds per call.
    testTimeout: 60000,
  },
});
