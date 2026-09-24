import { defineConfig } from 'vitest/config'

// Extractors run against synthetic DOM fixtures, so every test file gets jsdom.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'jsdom',
  },
})
