#!/usr/bin/env node
/**
 * Render the PWA icons from apps/web/public/icons/icon.svg with Playwright's Chromium.
 *
 *   node scripts/render-icons.mjs
 *
 * Writes (and the manifest / root layout reference):
 *   icon-192.png            192×192, transparent rounded corners (purpose "any")
 *   icon-512.png            512×512, transparent rounded corners (purpose "any")
 *   icon-maskable-512.png   512×512, full-bleed background, glyph inside the 80% safe zone
 *   apple-touch-icon.png    180×180, full-bleed and opaque (iOS applies its own mask)
 *
 * Uses the Chromium that Playwright expects when it is installed; otherwise the newest
 * chromium-* under PLAYWRIGHT_BROWSERS_PATH, or PH_CHROMIUM_PATH if set. Never downloads.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = join(ROOT, 'apps', 'web')
const ICONS = join(WEB, 'public', 'icons')
const require = createRequire(join(WEB, 'package.json'))
const { chromium } = require('@playwright/test')

export function findChromium() {
  if (process.env.PH_CHROMIUM_PATH) return process.env.PH_CHROMIUM_PATH
  try {
    if (existsSync(chromium.executablePath())) return undefined
  } catch {
    // fall through to scanning
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

const svg = readFileSync(join(ICONS, 'icon.svg'), 'utf8')
const background = /<rect[^>]*\sfill="(#[0-9a-fA-F]{3,8})"/.exec(svg)?.[1] ?? '#3a6b8a'
const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

/** HTML for one icon: optional opaque background, the SVG scaled and centred. */
function iconHtml(size, { fullBleed, scale }) {
  const inner = Math.round(size * scale)
  return `<!doctype html><html><head><style>
    html, body { margin: 0; padding: 0; background: transparent; }
    .icon { width: ${size}px; height: ${size}px; display: grid; place-items: center;
            background: ${fullBleed ? background : 'transparent'}; }
    img { width: ${inner}px; height: ${inner}px; display: block; }
  </style></head><body><div class="icon"><img src="${svgDataUrl}" alt=""></div></body></html>`
}

const OUTPUTS = [
  { file: 'icon-192.png', size: 192, fullBleed: false, scale: 1 },
  { file: 'icon-512.png', size: 512, fullBleed: false, scale: 1 },
  // Maskable: platforms may crop to a circle of radius 40% — shrink the artwork into that zone.
  { file: 'icon-maskable-512.png', size: 512, fullBleed: true, scale: 0.8 },
  // iOS masks its own rounded square and turns transparency black: fill the corners.
  { file: 'apple-touch-icon.png', size: 180, fullBleed: true, scale: 1 },
]

const executablePath = findChromium()
const browser = await chromium.launch(executablePath ? { executablePath } : {})
try {
  for (const out of OUTPUTS) {
    const page = await browser.newPage({
      viewport: { width: out.size, height: out.size },
      deviceScaleFactor: 1,
    })
    await page.setContent(iconHtml(out.size, out))
    await page.waitForFunction(() => {
      const img = document.querySelector('img')
      return img && img.complete && img.naturalWidth > 0
    })
    const png = await page.screenshot({
      clip: { x: 0, y: 0, width: out.size, height: out.size },
      omitBackground: !out.fullBleed,
      type: 'png',
    })
    writeFileSync(join(ICONS, out.file), png)
    console.log(`wrote ${join('apps/web/public/icons', out.file)} (${png.length} bytes)`)
    await page.close()
  }
} finally {
  await browser.close()
}
