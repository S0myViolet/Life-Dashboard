# Research notes: Next.js 16.3.x + React 19 + Tailwind CSS v4 (plus Server Actions security and Vercel Hobby limits) for a pnpm-workspace personal dashboard. Verification pass on 2026-09-24.

_Collected 2026-09-24 via web research (verified by a second pass). Sources are linked per fact. The build container itself cannot reach these hosts._

## Corrections and surprises

- CORRECTED: The Next 16 upgrade guide's 'Version Requirements' table lists only Node.js 20.9.0+, TypeScript 5.1.0+ and browsers (Chrome/Edge/Firefox 111+, Safari 16.4+). React 19.2 is not a stated minimum. The guide only says the App Router uses the React Canary that includes 19.2 features, and next@16.3.6 peerDependencies still accept react ^18.2.0 || ^19.0.0. Pinning react 19.3.0 is fine.
- CORRECTED: the eslint-config-next monorepo setting is `settings: { next: { rootDir: 'packages/my-app/' } }`, used with the `@next/next` plugin (`import eslintNextPlugin from '@next/eslint-plugin-next'`). rootDir accepts paths, globs or arrays of them.
- ADDED: any `runtime` key in proxy.ts config fails `next build`, not only 'edge'. Re-tested: `runtime: 'nodejs'` fails with "Route segment config is not allowed in Proxy file at \"./proxy.ts\". Proxy always runs on Node.js runtime." (E1031). In dev this is only logged once.
- CORRECTED: a chrome-extension:// Origin does parse to a host (the 32-char extension ID), and an exact-ID entry in experimental.serverActions.allowedOrigins would pass the CSRF check (tested against the installed isCsrfOriginAllowed). The recommendation to use Route Handlers from the extension still holds, for a different reason: Server Action IDs are encrypted and non-deterministic per build, so they are not a stable API.
- ADDED: Server Actions requests with no Origin header are let through with only a warning ('Missing `origin` header from a forwarded Server Actions request.'). Per-action authn/authz is mandatory; the CSRF check is not an auth mechanism.
- ADDED: under cacheComponents the route segment config docs list `dynamic`, `dynamicParams`, `revalidate` and `fetchCache` as removed. `instant` is documented in route-segment-config/instant.mdx (values true, false or { level: 'warning' }) and only works when cacheComponents is enabled. The use-cache.mdx page cited originally does not mention `instant`.
- The service-worker emission to /_next/static/service-worker/sw.js with automatic Service-Worker-Allowed and Cache-Control headers is not described in the PWA guide. It is backed by the published next@16.3.6 package source (router-server.js, build/index.js) and a local `next start` run, which were re-run and confirmed in this pass.
- Vercel facts could NOT be re-verified in this pass: vercel.com and web.archive.org are blocked by the egress proxy and the session's WebSearch budget (200) is used up. The core values (Hobby 300 s max, 4.5 MB body, once-daily Hobby cron with hour-window precision, CRON_SECRET Bearer) match prior knowledge. The 1800 s beta, the 'January 2026: 100 crons per project on all plans' change and the `x-vercel-cron-schedule` header are marked unverified.
- Turbopack still cannot resolve `./x.js` to x.ts in 16.3.6 (re-tested: "Module not found: Can't resolve './lib.js'"). Issue #82945 is open with linked PR #95426. Explicit `.ts`/`.tsx` specifiers work.

## Facts

### Current versions on the npm registry as of 2026-09-24: next latest 16.3.6 (canary 16.4.0-canary.43), react 19.3.0, tailwindcss 4.3.3, @tailwindcss/postcss 4.3.3, eslint-config-next 16.3.6, web-push 3.6.7. The repo's apps/web/package.json already pins these versions.

`npm view next dist-tags` gives latest: "16.3.6". next@16.3.6 package.json has engines {node: ">=20.9.0"} and peer react "^18.2.0 || ... || ^19.0.0". Checked from the local shell against the npm registry. (Re-checked in this pass: all versions match, and apps/web/package.json pins next 16.3.6, react/react-dom 19.3.0, tailwindcss and @tailwindcss/postcss 4.3.3, eslint-config-next 16.3.6, web-push 3.6.7.)

Source: https://registry.npmjs.org/next · confidence: verified-official-doc

### In Next 16, middleware.ts is renamed to proxy.ts. You can export either a named function `proxy` or a default function. It runs on the Node.js runtime, and the `runtime` config option is not allowed. **(load-bearing)**

The file goes at the project root or in src/, at the same level as `pages` or `app`. `export function proxy(request: NextRequest) {...}` or `export default function proxy(request) {...}`. The docs say: "Note that multiple proxy from the same file are not supported." Runtime section, verbatim: "Proxy defaults to using the Node.js runtime. The `runtime` config option is not available in Proxy files. Setting the `runtime` config option in Proxy will throw an error." Version history: v16.0.0 deprecated Middleware and renamed it to Proxy. Codemod: `npx @next/codemod@canary middleware-to-proxy .` Installed source (dist/build/analysis/get-page-static-info.js) confirms that a missing export gives: The file "..." must export a function, either as a default export or as a named "proxy" export.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/03-file-conventions/proxy.mdx · confidence: verified-official-doc

### Tested locally with next@16.3.6: any `runtime` key in the proxy.ts config fails `next build`, including `runtime: 'nodejs'`. A plain `export function proxy` with a matcher builds and shows up as 'ƒ Proxy (Middleware)'. **(load-bearing)**

Re-tested in this pass. `runtime: 'edge'` fails at Turbopack compile with: "Error: Next.js can't recognize the exported `config` field in route. Proxy does not support Edge runtime." `runtime: 'nodejs'` compiles but then fails at 'Collecting page data' with: "Error: Route segment config is not allowed in Proxy file at \"./proxy.ts\". Proxy always runs on Node.js runtime. Learn more: https://nextjs.org/docs/messages/middleware-to-proxy" (error code E1031). In `next dev` this is only logged once and the runtime is forced to nodejs. Working config: `export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|sw.js).*)'] }`. Upgrade guide, verbatim: "The `edge` runtime is **NOT** supported in `proxy`." and "If you want to continue using the `edge` runtime, keep using `middleware`." (middleware is deprecated).

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/upgrading/version-16.mdx · confidence: verified-official-doc

### Proxy matcher syntax is `export const config = { matcher }`. The matcher can be a string, an array, a regex string, or objects with source/has/missing/locale. **(load-bearing)**

Doc examples: `matcher: ['/about/:path*', '/dashboard/:path*']`; negative lookahead `'/((?!api|_next/static|_next/image|.*\\.png$).*)'`; object form `{ source: '/api/:path*', locale: false, has: [{ type: 'header', key: 'Authorization', value: 'Bearer Token' }, { type: 'query', key: 'userId', value: '123' }], missing: [{ type: 'cookie', key: 'session', value: 'active' }] }`. The next.config flags are `skipTrailingSlashRedirect` and `skipProxyUrlNormalize` (renamed from `skipMiddlewareUrlNormalize`).

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/03-file-conventions/proxy.mdx · confidence: verified-official-doc

### Next 16 removed synchronous access to the request APIs. cookies(), headers(), draftMode(), params and searchParams must all be awaited. **(load-bearing)**

Example: `export default async function Page({ searchParams }: { searchParams: Promise<Record<string,string>> }) { const sp = await searchParams }`. Codemod: `npx @next/codemod@canary next-async-request-api .` Type helpers `PageProps`, `LayoutProps` and `RouteContext` come from `npx next typegen`. In image metadata functions (opengraph-image, twitter-image, icon, apple-icon), params and id are Promises, and sitemap functions receive id as a Promise. The Promise-typed searchParams page built and rendered locally under 16.3.6.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/upgrading/version-16.mdx · confidence: verified-official-doc

### Turbopack is now the default for both `next dev` and `next build`. Opt out with `--webpack`. The Turbopack config moved from experimental.turbopack to a top-level `turbopack` key. If the project has a custom `webpack` config, `next build` fails unless you pass --webpack. **(load-bearing)**

Build output shows "▲ Next.js 16.3.6 (Turbopack)" (re-seen locally). Remove `--turbopack` from scripts. Opt-out script from the docs: `"build": "next build --webpack"`. Verbatim: "If your project has a custom `webpack` configuration and you run `next build` (which now uses Turbopack by default), the build will **fail** to prevent misconfiguration issues." CORRECTED minimum versions (the 'Version Requirements' table): Node.js 20.9.0+ (Node 18 dropped), TypeScript 5.1.0+, browsers Chrome 111+, Edge 111+, Firefox 111+, Safari 16.4+. React 19.2 is NOT a listed minimum. The guide says the App Router uses the latest React Canary, which includes React 19.2 features. next@16.3.6 peerDependencies still allow react "^18.2.0 || 19.0.0-rc-de68d2f4-20241204 || ^19.0.0". The guide's install command is `npm install next@latest react@latest react-dom@latest`, plus the latest @types/react and @types/react-dom.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/upgrading/version-16.mdx · confidence: verified-official-doc

### `next lint` has been removed and `next build` no longer runs linting. Run ESLint (or Biome) directly. The `eslint` key in next.config should be removed. **(load-bearing)**

Verbatim: "The `next lint` command has been removed." "`next build` no longer runs linting." "The `eslint` option in the Next.js config file is also removed." Codemod: `npx @next/codemod@canary next-lint-to-eslint-cli .` Re-checked: the installed next@16.3.6 dist/cli folder has no next-lint.js (it has next-build, next-dev, next-start, next-typegen, next-upgrade, next-analyze and others). Lint script: `"lint": "eslint ."`.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/upgrading/version-16.mdx · confidence: verified-official-doc

### eslint-config-next 16 ships native flat-config arrays. The subpath exports are '.', './core-web-vitals', './typescript' and './parser'. For monorepos, the Next app location is set with `settings: { next: { rootDir } }`. **(load-bearing)**

eslint.config.mjs (verbatim from the docs):
```js
import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
const eslintConfig = defineConfig([...nextVitals, ...nextTs, globalIgnores(['.next/**','out/**','build/**','next-env.d.ts'])])
export default eslintConfig
```
Re-checked locally: the package.json exports are exactly '.', './core-web-vitals', './typescript' and './parser'. core-web-vitals is an array of length 4 and typescript is an array of length 5. peerDependencies are eslint ">=9.0.0" and typescript ">=3.3.1". CORRECTED monorepo key path, from the docs: `{ files: ['**/*.{js,jsx,ts,tsx}'], plugins: { '@next/next': eslintNextPlugin }, settings: { next: { rootDir: 'packages/my-app/' } } }`, with `import eslintNextPlugin from '@next/eslint-plugin-next'`. rootDir takes relative or absolute paths, globs (e.g. "packages/*/") or an array of them.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/05-config/03-eslint.mdx · confidence: verified-official-doc

### `cacheComponents: true` is a top-level next.config option (default false). It replaces experimental.ppr, experimental.dynamicIO and experimental.useCache, and enables 'use cache', cacheLife and cacheTag. It requires the Node.js runtime. **(load-bearing)**

`const nextConfig: NextConfig = { cacheComponents: true }`. The default of false is confirmed in the installed next/dist/server/config-shared.js (`cacheComponents: false`). Docs, verbatim: "Cache Components requires the Node.js runtime. Migrate any routes that set the deprecated `runtime = 'edge'` export...". experimental.dynamicIO and experimental.useCache are removed. Import without the unstable_ prefix: `import { cacheLife, cacheTag } from 'next/cache'`. Installed next/cache exports cacheLife, cacheTag, updateTag, refresh, revalidateTag and revalidatePath, and the unstable_ aliases still exist. Inside 'use cache' you cannot call cookies(), headers() or searchParams; read them outside and pass them in as arguments. All cached functions must be async, and their args and returns must be serializable (not class instances, symbols, WeakMap/WeakSet or URL instances). The default cacheLife profile is stale 5 min (client), revalidate 15 min (server), and never expires by time.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/05-config/01-next-config-js/cacheComponents.mdx · confidence: verified-official-doc

### Tested locally: with cacheComponents enabled, `export const dynamic = ...` fails the build, and reading runtime data outside <Suspense> fails prerendering. The escape hatch is `export const instant = false`. `export const maxDuration` was not rejected. **(load-bearing)**

Re-tested in this pass with next@16.3.6. Error 1 (Turbopack compile): "Route segment config \"dynamic\" is not compatible with `nextConfig.cacheComponents`. Please remove it." Error 2 (prerender): "Route \"/\": Next.js encountered uncached or runtime data during prerendering. `fetch(...)`, `cookies()`, `headers()`, `params`, `searchParams`, or `connection()` accessed outside of `<Suspense>`..." The listed fixes are [stream] `<Suspense fallback>`, [cache] "use cache", and [block] `export const instant = false`. Adding `export const instant = false` (with `export const maxDuration = 60`) built successfully as ƒ /. The route segment config docs say v16.0.0 removed `dynamic`, `dynamicParams`, `revalidate` and `fetchCache` when Cache Components is enabled; the remaining options are dynamicParams, runtime ('nodejs' default; 'edge' deprecated), preferredRegion and maxDuration. instant.mdx: values are true, false, or `{ level: 'warning' }`, and "The `instant` export only works when cacheComponents is enabled." With cacheComponents off (the default), awaiting searchParams in a page builds fine as a dynamic route (re-seen).

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/instant.mdx · confidence: verified-official-doc

### Other Next 16 cache API changes: revalidateTag now requires a second cacheLife-profile argument; updateTag() and refresh() are new for use in Server Actions. reactCompiler is now stable at the top level.

`revalidateTag('posts', 'max')`. `updateTag(tag)` updates immediately (read-your-writes). `refresh()` refreshes the client router from a Server Action. `reactCompiler: true` is top level (previously experimental). Also removed: AMP, serverRuntimeConfig/publicRuntimeConfig, unstable_rootParams. Parallel route slots now require default.js. next/image changes: minimumCacheTTL default 14400, qualities default [75], local IPs blocked unless images.dangerouslyAllowLocalIP.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/upgrading/version-16.mdx · confidence: verified-official-doc

### The official PWA guide defines the manifest in app/manifest.ts with a default export returning MetadataRoute.Manifest. **(load-bearing)**

`import type { MetadataRoute } from 'next'; export default function manifest(): MetadataRoute.Manifest { return { name: 'Next.js PWA', short_name: 'NextPWA', description, start_url: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#000000', icons: [{ src: '/icon-192x192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512x512.png', sizes: '512x512', type: 'image/png' }] } }`. Web push on iOS requires "iOS 16.4+ for applications installed to the home screen". For local HTTPS testing use `next dev --experimental-https`.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/progressive-web-apps.mdx · confidence: verified-official-doc

### The v16.3.6 PWA guide registers the service worker as a bundled module via `new URL(..., import.meta.url)`, not as public/sw.js. **(load-bearing)**

```ts
const registration = await navigator.serviceWorker.register(
  new URL('../lib/service-worker.js', import.meta.url),
  { scope: '/', updateViaCache: 'none' }
)
```
The service worker source is `lib/service-worker.js`, with `push` (`event.waitUntil(self.registration.showNotification(data.title, options))`) and `notificationclick` (`event.notification.close(); event.waitUntil(clients.openWindow('https://your-website.com'))`) handlers. The subscribe call is `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!) })`. Verbatim: "For full service-worker-based offline caching, one option is Serwist, which provides Next.js integration examples for both Turbopack and webpack." The guide itself does not explain where the bundled SW is emitted or which headers it gets.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/progressive-web-apps.mdx · confidence: verified-official-doc

### Tested locally with next@16.3.6: Turbopack compiles a service worker referenced this way to /_next/static/service-worker/sw.js. `next start` then serves it with Service-Worker-Allowed: / and Cache-Control: public, max-age=0, must-revalidate, so scope '/' works. **(load-bearing)**

Re-tested in this pass. The build emitted .next/static/service-worker/sw.js, and the client chunk was rewritten to `navigator.serviceWorker.register("/_next/static/service-worker/sw.js",{scope:"/",updateViaCache:"none"})`. Response headers from `next start`: `Service-Worker-Allowed: /`, `Cache-Control: public, max-age=0, must-revalidate`, `Content-Type: application/javascript; charset=UTF-8`. Installed package source: next/dist/server/lib/router-server.js (`if (matchedOutput.itemPath.startsWith('/service-worker/')) { res.setHeader('Cache-Control','public, max-age=0, must-revalidate'); res.setHeader('Service-Worker-Allowed', config.basePath || '/') }`), which only applies when no cache-control was already set. next/dist/build/index.js pushes a routes-manifest header `${basePath}/_next/static/service-worker/:path*` → Service-Worker-Allowed (internal: true) when that directory is non-empty, so hosted deployments that honour routes-manifest headers get it too. This is evidence from the published package and a local run, not from the docs text.

Source: https://registry.npmjs.org/next/-/next-16.3.6.tgz · confidence: verified-official-doc

### The PWA guide's web-push setup uses VAPID keys from env vars NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, calls webpush.setVapidDetails, and sends from a Server Action. **(load-bearing)**

Key generation in the guide: `npm install -g web-push` (or the pnpm/yarn/bun global equivalents), then `web-push generate-vapid-keys`. `npx web-push generate-vapid-keys` also works but is not in the guide. Setup: `webpush.setVapidDetails('mailto:your-email@example.com', process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!)`. Send: `await webpush.sendNotification(subscription, JSON.stringify({ title: 'Test Notification', body: message, icon: '/icon.png' }))`. The guide's app/actions.ts ('use server') keeps the subscription in memory, with the comment: "In a production environment, you would want to store the subscription in a database..."

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/progressive-web-apps.mdx · confidence: verified-official-doc

### The PWA guide's next.config security headers: global X-Content-Type-Options, X-Frame-Options and Referrer-Policy, plus Content-Type, Cache-Control and CSP headers for source '/sw.js'. **(load-bearing)**

`source: '/(.*)'` gets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`. `source: '/sw.js'` gets `Content-Type: application/javascript; charset=utf-8`, `Cache-Control: no-cache, no-store, must-revalidate`, `Content-Security-Policy: default-src 'self'; script-src 'self'`. This '/sw.js' rule only applies if you serve public/sw.js yourself; it does not match the bundled /_next/static/service-worker/sw.js path (confirmed: the bundled path is different, see the previous fact).

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/progressive-web-apps.mdx · confidence: verified-official-doc

### Tailwind v4 with Next: install tailwindcss, @tailwindcss/postcss and postcss; add postcss.config.mjs with the '@tailwindcss/postcss' plugin; put `@import "tailwindcss";` in app/globals.css. No tailwind.config.js is needed. **(load-bearing)**

`npm install tailwindcss @tailwindcss/postcss postcss`
postcss.config.mjs: `const config = { plugins: { "@tailwindcss/postcss": {} } }; export default config;`
globals.css: `@import "tailwindcss";`
Re-checked locally in a Next 16.3.6 Turbopack build with tailwindcss 4.3.3.

Source: https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/app/(docs)/docs/installation/framework-guides/nextjs.tsx · confidence: verified-official-doc

### Tailwind v4 design tokens are CSS variables inside @theme. Namespaces generate utilities: --color-*, --font-*, --text-*, --breakpoint-*, --radius-*, --spacing-*, --shadow-*. Use @theme inline when a token references another variable. **(load-bearing)**

`@theme { --color-mint-500: oklch(0.72 0.11 178); }` produces bg-mint-500 etc. `@theme inline { --font-sans: var(--font-inter); }` generates `.font-sans { font-family: var(--font-inter); }`. `@theme static { ... }` always emits the variables. Reset a namespace with `--color-*: initial;`. Use :root for plain CSS variables that should not generate utilities. Other namespaces in the docs table: --font-weight-*, --tracking-*, --leading-*, --tab-size-*, --container-*, --inset-shadow-*, --drop-shadow-*, --blur-*, --perspective-*, --zoom-*, --aspect-*, --ease-*, --animate-*.

Source: https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/docs/theme.mdx · confidence: verified-official-doc

### Tailwind v4 dark mode follows prefers-color-scheme by default. For a class- or attribute-based toggle, redefine the variant with @custom-variant.

Class: `@custom-variant dark (&:where(.dark, .dark *));` Attribute: `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));` Toggle: `document.documentElement.classList.toggle('dark', localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches))`. Checked locally: the output CSS contains `.dark\:bg-black:where(.dark,.dark *)`.

Source: https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/docs/dark-mode.mdx · confidence: verified-official-doc

### Tailwind v4 scans for classes starting from the current working directory and skips .gitignore'd files, node_modules, binaries, CSS and lockfiles. A pnpm workspace package outside apps/web is not scanned unless you add @source. **(load-bearing)**

Docs, verbatim: "Tailwind uses the current working directory as its starting point when scanning for class names by default." The ignored items are .gitignore'd files, node_modules, binary files, CSS files, and common package manager lock files. @source paths are "relative to the stylesheet". Re-tested in this pass: without @source, a class string in packages/core/src (`text-fuchsia-700`) was missing from the built CSS when building from apps/web. With `@source "../../../packages/core/src";` in apps/web/app/globals.css it was present. Other syntax: `@import "tailwindcss" source("../src")`, `@import "tailwindcss" source(none)`, `@source not "..."`, `@source inline("...")`, `@source not inline("...")`.

Source: https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/docs/detecting-classes-in-source-files.mdx · confidence: verified-official-doc

### Under Turbopack, pnpm, npm and Yarn workspace packages are transpiled automatically, so transpilePackages is not needed for them with the App Router. It is still needed for raw TypeScript in node_modules and for webpack with the Pages Router. **(load-bearing)**

Verbatim: "Turbopack transpiles workspace packages (npm, pnpm, or Yarn workspaces) in your monorepo automatically under both routers." It is still needed for a node_modules dependency with raw TS/JSX, for webpack + Pages Router with monorepo packages outside the app dir, and for Pages Router bundling of node_modules deps. Verbatim: "Values are package names, including scoped names like `@scope/pkg`. Paths and glob patterns are not supported." Example: `transpilePackages: ['package-name', '@scope/pkg']`. Verbatim: "A package cannot appear in both `transpilePackages` and `serverExternalPackages`; Next.js throws at build start if it does."

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/05-config/01-next-config-js/transpilePackages.mdx · confidence: verified-official-doc

### Tested locally: explicit `.ts` import specifiers work under Next 16.3.6 Turbopack, both inside a workspace package and in the app. The setup was TS 6.0.3 with allowImportingTsExtensions + noEmit, and the package exports raw .ts files. No transpilePackages entry was needed. **(load-bearing)**

Re-tested in this pass (next build passed compile and the TypeScript check). Setup: package.json `"exports": { ".": "./src/index.ts", "./*": "./src/*.ts" }`, `"type": "module"`. packages/core/src/index.ts has `export { greet } from './greet.ts'` and `export type { Greeting } from './types.ts'`. The page imported `@t/core`, `@t/core/extra`, `./lib.ts` and `./Sw.tsx`. tsconfig: moduleResolution Bundler, allowImportingTsExtensions, noEmit, verbatimModuleSyntax. Re-tested the reverse: changing to `import { local } from './lib.js'` (file is lib.ts) fails with "Module not found: Can't resolve './lib.js'". Issue #82945 ("Turbopack: support importing .ts/.tsx via .js extension (parity with webpack resolve.extensionAlias)") is still open, with linked PR #95426. Evidence is a local build plus a GitHub issue, not official docs.

Source: https://github.com/vercel/next.js/issues/82945 · confidence: secondary-source

### Server Actions CSRF protection: actions can only be called by POST. Next compares the Origin header's host with x-forwarded-host (or host) and aborts on a mismatch, unless the origin host is in `experimental.serverActions.allowedOrigins` (still under experimental in 16.3.6). A request with no Origin header is allowed through with only a warning. **(load-bearing)**

```js
module.exports = { experimental: { serverActions: { allowedOrigins: ['my-proxy.com', '*.my-proxy.com'] } } }
```
Docs: `*` matches one label; `**` matches one or more labels and only at the start. "Partial replacement is not supported. Write `*.my-proxy.com`, rather than `app-*.my-proxy.com`." Ports must be written explicitly. "A request that carries no `Origin` header at all is allowed through with a warning rather than rejected." "Behind a reverse proxy, no entry is needed as long as the proxy forwards the public host in `x-forwarded-host`." Installed source csrf-protection.js: a single-label `*` or `**` pattern never matches, and matching is case-insensitive. action-handler.js: originHost = `new URL(origin).host`; a mismatch logs "... does not match `origin` header ... Aborting the action." and throws 'Invalid Server Actions request.' (E80). The config schema (config-schema.js, config-shared.d.ts ExperimentalConfig) has serverActions only under experimental. CORRECTED: for `chrome-extension://<id>`, `new URL(origin).host` is the 32-char extension ID (tested: isCsrfOriginAllowed('<id>', ['<id>']) === true), so the ID could technically be allowlisted. The extension should still call Route Handlers with its own auth, because Server Action IDs are "encrypted, non-deterministic" per build and are not a stable public API.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.mdx · confidence: verified-official-doc

### The default Server Actions body size limit is 1 MB. Change it with experimental.serverActions.bodySizeLimit, as a number of bytes or a string like '2mb'. **(load-bearing)**

`experimental: { serverActions: { bodySizeLimit: '2mb' } }`. Installed source, action-handler.js: `const defaultBodySizeLimit = '1 MB'; ... : 1024 * 1024 // 1 MB`, and custom values are parsed with next/dist/compiled/bytes. Docs: "The limit applies to the raw HTTP request body, including the bytes that `multipart/form-data` adds", so reserve about 10–20 KB of overhead for uploads.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.mdx · confidence: verified-official-doc

### Server Actions are publicly reachable POST endpoints, so every action must check authentication and authorization itself. Closure values are encrypted with a per-build key, which can be set with NEXT_SERVER_ACTIONS_ENCRYPTION_KEY. Unused actions are removed from the client bundle. **(load-bearing)**

The docs say to "treat Server Actions as reachable via direct POST requests and verify authentication and authorization inside each one", and "A page-level authentication check does not extend to the Server Actions defined within it. Always re-verify inside the action." "A new private key is generated for each action every time a Next.js application is built." NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "a base64-encoded value whose decoded length matches a valid AES key size (16, 24, or 32 bytes)", needed for self-hosting across multiple servers. "Unused Server Actions (referenced by their IDs) are removed from client bundle... Next.js creates encrypted, non-deterministic IDs". CSRF: "only this HTTP method [POST] is allowed to invoke them".

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/data-security.mdx · confidence: verified-official-doc

### Vercel Hobby with fluid compute (on by default): function maxDuration defaults to 300 s and cannot go higher. Pro and Enterprise default to 300 s with a maximum of 800 s. **(load-bearing)**

Hobby: default 300s, max 300s. Pro/Enterprise: default 300s, max 800s. Hobby memory is fixed at 2 GB / 1 vCPU. The request/response body limit is 4.5 MB; exceeding it returns 413 FUNCTION_PAYLOAD_TOO_LARGE. Set it in Next with `export const maxDuration = 300` in a route or page (maxDuration is still a valid route segment config in 16.3.6, including with cacheComponents; its default is 'Set by deployment platform'). NOT re-verified in this pass: vercel.com and web.archive.org are blocked by the egress proxy and the WebSearch budget is used up. These values match the verifier's pre-2026 knowledge, but the source was not re-opened. The '1800s opt-in (beta)' sub-claim is split out as unverified.

Source: https://vercel.com/docs/functions/limitations · confidence: secondary-source

### Vercel cron on Hobby: each cron job may run at most once per day, and a more frequent expression fails the deploy. Invocation can land anywhere in the scheduled hour. Crons run in UTC, only on production deployments, as HTTP GET, and authenticate with CRON_SECRET as a Bearer token. **(load-bearing)**

Example: `0 8 * * *` fires between 08:00:00 and 08:59:59 on Hobby. vercel.json: `{ "crons": [{ "path": "/api/cron/daily", "schedule": "0 5 * * *" }] }`. The user agent is `vercel-cron/1.0`. If the CRON_SECRET env var is set, Vercel sends `Authorization: Bearer ${CRON_SECRET}`; check it and return 401 on a mismatch. NOT re-verified in this pass (vercel.com is blocked, the WebSearch budget is used up, and web.archive.org is blocked). This matches the verifier's pre-2026 knowledge. The newer sub-claims (100 crons per project, the x-vercel-cron-schedule header) are split out as unverified.

Source: https://vercel.com/docs/cron-jobs/usage-and-pricing · confidence: secondary-source

### UNVERIFIED Vercel sub-claims from the original research: Pro/Enterprise can opt in to 1800 s maxDuration (beta); since January 2026 every plan allows 100 cron jobs per project with no per-team cap (Hobby used to be 2); cron requests carry an `x-vercel-cron-schedule` header.

These could not be confirmed against vercel.com in this pass, and they are not in the verifier's prior knowledge. Before relying on them, check vercel.com/docs/cron-jobs/usage-and-pricing, vercel.com/docs/cron-jobs/manage-cron-jobs and vercel.com/docs/functions/limitations in a browser. The design should not depend on the header; authenticate with CRON_SECRET instead. Hobby's once-per-day limit makes the per-project count irrelevant for hourly or minute-level jobs anyway.

Source: https://vercel.com/docs/cron-jobs/usage-and-pricing · confidence: unverified

### The Vercel Hobby plan is for personal, non-commercial use only. A private personal dashboard fits that.

Commercial usage means any deployment used for the financial gain of anyone involved in producing it, including a paid employee or consultant writing the code. Commercial use requires Pro or Enterprise. Vercel may disable Hobby deployments at its discretion. vercel.com is blocked for direct fetch, so these come from vercel.com search results.

Source: https://vercel.com/docs/limits/fair-use-guidelines · confidence: secondary-source
