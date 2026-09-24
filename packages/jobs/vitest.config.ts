import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Reuse the database harness (content-addressed template + per-file clones).
    globalSetup: ['../db/test/global-setup.ts'],
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
