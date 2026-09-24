import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Unit/integration tests for server code (route handlers, server actions, lib/).
 * Database-backed tests use the shared harness: `createTestDatabase()` from
 * @personal-home/db/testing, then set process.env.DATABASE_URL before importing
 * modules that call getDb().
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
      'server-only': fileURLToPath(new URL('./test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    globalSetup: ['../../packages/db/test/global-setup.ts'],
    include: ['test/**/*.test.ts', 'lib/**/*.test.ts', 'app/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
