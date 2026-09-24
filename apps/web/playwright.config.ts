/**
 * End-to-end tests against a production build (`next build` + `next start`) on
 * port 3200 with the test-only sign-in (PH_E2E_AUTH=1). e2e/global-setup.ts
 * clones the migrated template database, seeds an owner and a stranger, builds
 * and starts the app, and tears everything down afterwards.
 *
 *   pnpm --filter @personal-home/web test:e2e
 *   PH_E2E_SKIP_BUILD=1 pnpm --filter @personal-home/web test:e2e   # reuse .next
 *
 * Browsers: Chromium only. The "iphone" project emulates an iPhone-sized
 * viewport, touch and user agent with the Chromium engine — WebKit is not
 * installed in this environment, so real Safari behaviour is not covered.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, defineConfig, devices } from '@playwright/test'

const E2E_PORT = Number(process.env.PH_E2E_PORT ?? 3200)
const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`

/**
 * Use the Chromium build Playwright expects when present; otherwise the newest
 * chromium-* under PLAYWRIGHT_BROWSERS_PATH (or PH_CHROMIUM_PATH). Never downloads.
 */
function chromiumExecutable(): string | undefined {
  if (process.env.PH_CHROMIUM_PATH) return process.env.PH_CHROMIUM_PATH
  try {
    if (existsSync(chromium.executablePath())) return undefined
  } catch {
    // fall through
  }
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!base || !existsSync(base)) return undefined
  const dirs = readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  for (const dir of dirs) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = join(base, dir, sub)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

const executablePath = chromiumExecutable()
const launchOptions = executablePath ? { executablePath } : {}

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // One worker: tests share one seeded database and reset the owner's settings between tests.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
    serviceWorkers: 'allow',
    launchOptions,
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions,
      },
    },
    {
      name: 'iphone',
      use: {
        ...devices['iPhone 13'],
        // WebKit is not installed here: emulate the iPhone viewport with Chromium.
        browserName: 'chromium',
        launchOptions,
      },
    },
  ],
})
