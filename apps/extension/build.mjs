// Builds the unpacked extension into apps/extension/dist (gitignored).
//
//   pnpm --filter @personal-home/extension build            # one build
//   PH_EXTENSION_KEY=<base64 public key> pnpm ... build      # pin the extension ID (see README)
//   pnpm --filter @personal-home/extension build -- --watch
//
// Everything is bundled locally: MV3 forbids remote code, and the extension
// pages' CSP only allows scripts from the package itself.
import { build, context } from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const dist = resolve(root, 'dist')
const watch = process.argv.includes('--watch')

/**
 * @personal-home/core is plain ESM without a "sideEffects" flag. Marking its
 * modules side-effect free lets esbuild drop the areas the helper never uses
 * (jobs, AI, settings ...), which keeps the content scripts small.
 */
const coreIsPure = {
  name: 'core-side-effect-free',
  setup(b) {
    b.onResolve({ filter: /^@personal-home\/core$/ }, async (args) => {
      if (args.pluginData?.skip) return undefined
      const result = await b.resolve(args.path, {
        kind: args.kind,
        resolveDir: args.resolveDir,
        pluginData: { skip: true },
      })
      return { ...result, sideEffects: false }
    })
    b.onResolve({ filter: /^\.\.?\/.*\.ts$/ }, async (args) => {
      if (args.pluginData?.skip || !args.importer.includes('/packages/core/src/')) return undefined
      const result = await b.resolve(args.path, {
        kind: args.kind,
        resolveDir: args.resolveDir,
        pluginData: { skip: true },
      })
      return { ...result, sideEffects: false }
    })
  },
}

const common = {
  bundle: true,
  target: 'chrome120',
  platform: 'browser',
  legalComments: 'none',
  logLevel: 'info',
  sourcemap: 'linked',
  minify: false,
  plugins: [coreIsPure],
}

const builds = [
  // The service worker is an ES module ("type": "module" in the manifest).
  { entryPoints: { background: 'src/background/service-worker.ts' }, format: 'esm' },
  // Content scripts cannot be modules.
  { entryPoints: { 'content-chatgpt': 'src/content/chatgpt-entry.ts' }, format: 'iife' },
  { entryPoints: { 'content-claude': 'src/content/claude-entry.ts' }, format: 'iife' },
  { entryPoints: { popup: 'src/popup/popup.ts', options: 'src/options/options.ts' }, format: 'esm' },
].map((b) => ({ ...common, ...b, outdir: dist, absWorkingDir: root }))

async function writeManifest() {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'))
  manifest.version = pkg.version
  const key = process.env.PH_EXTENSION_KEY?.trim()
  if (key) {
    if (!/^[A-Za-z0-9+/=]+$/.test(key)) throw new Error('PH_EXTENSION_KEY must be a base64 public key')
    manifest.key = key
  }
  await writeFile(resolve(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function copyStatic() {
  await cp(resolve(root, 'static'), dist, { recursive: true })
}

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })
await copyStatic()
await writeManifest()

if (watch) {
  const contexts = await Promise.all(builds.map((b) => context(b)))
  await Promise.all(contexts.map((c) => c.watch()))
  console.log('Watching for changes (static files and manifest are copied once).')
} else {
  await Promise.all(builds.map((b) => build(b)))
  console.log(`Built ${dist}`)
}
