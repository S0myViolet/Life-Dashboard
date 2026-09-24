import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each test file gets its own database cloned from the template, so files can run in parallel.
    fileParallelism: true,
  },
})
