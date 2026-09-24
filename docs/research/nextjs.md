# Research notes: Next.js 16.3.x + React 19 + Tailwind CSS v4 (plus Server Actions security and Vercel Hobby limits) for a pnpm-workspace personal dashboard

_Collected 2026-09-24 via web research (single pass, not yet re-verified). Sources are linked per fact. The build container itself cannot reach these hosts._

## Corrections and surprises

- nextjs.org, tailwindcss.com and vercel.com are all blocked by the egress proxy. The Next and Tailwind facts come from their docs source on raw.githubusercontent.com (Next docs pinned to tag v16.3.6), plus local builds with next@16.3.6. The Vercel facts come only from vercel.com search results, marked secondary-source.
- The v16.3.6 PWA guide no longer uses public/sw.js. It registers `new URL('../lib/service-worker.js', import.meta.url)`, and Turbopack emits that as /_next/static/service-worker/sw.js with `Service-Worker-Allowed: /` and `Cache-Control: public, max-age=0, must-revalidate` added automatically (checked locally). The guide's own headers() rule for `source: '/sw.js'` does not match that path. Pick one approach: the bundled SW (then drop the /sw.js header rule), or public/sw.js with the rule.
- Server Actions config is still `experimental.serverActions.{allowedOrigins, bodySizeLimit}` in the 16.3.6 docs and config schema, not a top-level key.
- Tailwind v4 does not scan pnpm workspace packages outside the app folder. Classes used in packages/* are dropped unless you add `@source "../../../packages/<pkg>/src";` to globals.css (checked locally).
- With cacheComponents enabled, `export const dynamic` fails the build, and any cookies()/headers()/searchParams/uncached fetch outside <Suspense> fails prerendering. The new escape hatch is `export const instant = false`. cacheComponents defaults to false. If it stays off, the older dynamic-rendering behaviour applies apart from the required awaits.
- React latest on npm is 19.3.0, not 19.2. The Next 16 upgrade guide's minimum is React 19.2.
- Vercel lifted cron limits in January 2026 to 100 cron jobs per project on every plan with no per-team cap. Hobby still allows only once-daily schedules with hour-level timing precision, so hourly or minute-level reminders and push jobs need another scheduler, such as Supabase pg_cron.
- Chrome extensions cannot call Server Actions from their own origin: the Origin host check fails, and allowedOrigins matches hostnames, not chrome-extension:// origins. The extension should call Route Handlers with its own auth.
- Explicit `.ts` import specifiers work under Turbopack (checked locally). The unsupported pattern is importing `./x.js` to mean x.ts, which has no extensionAlias parity (issue #82945).

## Facts

### Current versions on the npm registry as of 2026-09-24: next latest 16.3.6 (canary 16.4.0-canary.43), react 19.3.0, tailwindcss 4.3.3, @tailwindcss/postcss 4.3.3, eslint-config-next 16.3.6, web-push 3.6.7. The repo's apps/web/package.json already pins these versions.

`npm view next dist-tags` gives latest: "16.3.6". next@16.3.6 package.json has engines {node: ">=20.9.0"} and peer react "^18.2.0 || ... || ^19.0.0". Checked from the local shell against the npm registry.

Source: https://registry.npmjs.org/next · confidence: verified-official-doc

### In Next 16, middleware.ts is renamed to proxy.ts. You can export either a named function `proxy` or a default function. It runs on the Node.js runtime, and the `runtime` config option is not allowed. **(load-bearing)**

The file goes at the project root or in src/, at the same level as app/. `export function proxy(request: NextRequest) {...}` or `export default function proxy(request) {...}`. You cannot export more than one proxy function per file. The docs say: "Proxy defaults to using the Node.js runtime. The `runtime` config option is not available in Proxy files." Version history: v16.0.0 deprecated Middleware and renamed it to Proxy. Codemod: `npx @next/codemod@canary middleware-to-proxy .`

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/03-file-conventions/proxy.mdx · confidence: verified-official-doc

### Tested locally with next@16.3.6: putting `runtime: 'edge'` in the proxy.ts config fails the build. A plain `export function proxy` with a matcher builds and shows up as 'ƒ Proxy (Middleware)'. **(load-bearing)**

Error text: "Next.js can't recognize the exported `config` field in route. Proxy does not support Edge runtime." Working config: `export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|sw.js).*)'] }`. The upgrade guide says: "The `edge` runtime is NOT supported in `proxy`. If you want to continue using the `edge` runtime, keep using `middleware`" (middleware is deprecated).

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/upgrading/version-16.mdx · confidence: verified-official-doc

### Proxy matcher syntax is `export const config = { matcher }`. The matcher can be a string, an array, a regex string, or objects with source/has/missing/locale. **(load-bearing)**

Examples: `matcher: '/about/:path*'`; `matcher: ['/about', '/contact']`; `'/((?!api|_next/static|_next/image|.*\\.png$).*)'`; `{ source: '/api/:path*', locale: false, has: [...], missing: [...] }`. The config flag `skipMiddlewareUrlNormalize` is renamed to `skipProxyUrlNormalize`.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/03-file-conventions/proxy.mdx · confidence: verified-official-doc

### Next 16 removed synchronous access to the request APIs. cookies(), headers(), draftMode(), params and searchParams must all be awaited. **(load-bearing)**

Example: `export default async function Page({ searchParams }: { searchParams: Promise<Record<string,string>> }) { const sp = await searchParams }`. Codemod: `npx @next/codemod@canary next-async-request-api .` Type helpers `PageProps`, `LayoutProps` and `RouteContext` come from `npx next typegen`. In image functions (opengraph-image etc.), params and id are Promises, and sitemap() receives id as a Promise.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/upgrading/version-16.mdx · confidence: verified-official-doc

### Turbopack is now the default for both `next dev` and `next build`. Opt out with `--webpack`. The Turbopack config moved from experimental.turbopack to a top-level `turbopack` key. If the project has a custom `webpack` config, `next build` fails unless you pass --webpack. **(load-bearing)**

Build output shows "▲ Next.js 16.3.6 (Turbopack)" (seen locally). Remove `--turbopack` from scripts. Opt-out script: `"build": "next build --webpack"`. The docs say: "If your project has a custom `webpack` configuration and you run `next build`, the build will fail". Minimum versions: Node 20.9+, TypeScript 5.1.0+, React 19.2.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/upgrading/version-16.mdx · confidence: verified-official-doc

### `next lint` has been removed and `next build` no longer runs linting. Run ESLint (or Biome) directly. The `eslint` key in next.config should be removed. **(load-bearing)**

The docs say: "The `next lint` command has been removed. Use Biome or ESLint directly. `next build` no longer runs linting." Codemod: `npx @next/codemod@canary next-lint-to-eslint-cli .` The installed next@16.3.6 dist/cli folder has no next-lint.js. Lint script: `"lint": "eslint ."`.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/upgrading/version-16.mdx · confidence: verified-official-doc

### eslint-config-next 16 ships native flat-config arrays. The subpath exports are '.', './core-web-vitals', './typescript' and './parser'. **(load-bearing)**

eslint.config.mjs:
```js
import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
export default defineConfig([...nextVitals, ...nextTs, globalIgnores(['.next/**','out/**','build/**','next-env.d.ts'])])
```
Checked locally: core-web-vitals is an array of 4 configs and typescript is an array of 5. The peer dependency is eslint >=9.0.0. For monorepos, use `settings` with `rootDir` (key name as given by the docs page summary; exact key path not verified).

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/05-config/03-eslint.mdx · confidence: verified-official-doc

### `cacheComponents: true` is a top-level next.config option (default false). It replaces experimental.ppr, experimental.dynamicIO and experimental.useCache, and enables 'use cache', cacheLife and cacheTag. It requires the Node.js runtime. **(load-bearing)**

`const nextConfig: NextConfig = { cacheComponents: true }`. experimental.dynamicIO and experimental.useCache are removed. Import without the unstable_ prefix: `import { cacheLife, cacheTag } from 'next/cache'`. Inside 'use cache' you cannot call cookies(), headers() or searchParams; read them outside and pass them in as arguments. All cached functions must be async, and their args and returns must be serializable. The default cacheLife profile is 5 min client stale and 15 min server revalidate.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/05-config/01-next-config-js/cacheComponents.mdx · confidence: verified-official-doc

### Tested locally: with cacheComponents enabled, `export const dynamic = ...` fails the build, and reading runtime data outside <Suspense> fails prerendering. The escape hatch is `export const instant = false`. `export const maxDuration` was not rejected. **(load-bearing)**

Error 1: "Route segment config \"dynamic\" is not compatible with `nextConfig.cacheComponents`. Please remove it." Error 2: "Next.js encountered uncached or runtime data during prerendering. `fetch(...)`, `cookies()`, `headers()`, `params`, `searchParams`, or `connection()` accessed outside of `<Suspense>`..." The listed fixes are: wrap in `<Suspense>`, use "use cache", or `export const instant = false`. With cacheComponents off (the default), awaiting searchParams in a page builds fine as a dynamic route.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/01-directives/use-cache.mdx · confidence: verified-official-doc

### Other Next 16 cache API changes: revalidateTag now requires a second cacheLife-profile argument; updateTag() and refresh() are new for use in Server Actions. reactCompiler is now stable at the top level.

`revalidateTag('posts', 'max')`. `updateTag(tag)` updates immediately (read-your-writes). `refresh()` refreshes the client router from a Server Action. `reactCompiler: true` is top level (previously experimental). Also removed: AMP, serverRuntimeConfig/publicRuntimeConfig, unstable_rootParams. Parallel route slots now require default.js. next/image changes: minimumCacheTTL default 14400, qualities default [75], local IPs blocked unless images.dangerouslyAllowLocalIP.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/upgrading/version-16.mdx · confidence: verified-official-doc

### The official PWA guide defines the manifest in app/manifest.ts with a default export returning MetadataRoute.Manifest. **(load-bearing)**

`import type { MetadataRoute } from 'next'; export default function manifest(): MetadataRoute.Manifest { return { name, short_name, description, start_url: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#000000', icons: [{ src: '/icon-192x192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512x512.png', sizes: '512x512', type: 'image/png' }] } }`. Web push on iOS requires iOS 16.4+ and the app installed to the home screen. For local HTTPS testing use `next dev --experimental-https`.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/progressive-web-apps.mdx · confidence: verified-official-doc

### The v16.3.6 PWA guide registers the service worker as a bundled module via `new URL(..., import.meta.url)`, not as public/sw.js. **(load-bearing)**

```ts
const registration = await navigator.serviceWorker.register(
  new URL('../lib/service-worker.js', import.meta.url),
  { scope: '/', updateViaCache: 'none' }
)
```
The service worker source is `lib/service-worker.js` and has `push` and `notificationclick` handlers (`self.registration.showNotification(data.title, options)`, `clients.openWindow(...)`). The subscribe call is `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!) })`. For offline caching the guide points to Serwist, which has examples for both Turbopack and webpack.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/progressive-web-apps.mdx · confidence: verified-official-doc

### Tested locally with next@16.3.6: Turbopack compiles a service worker referenced this way to /_next/static/service-worker/sw.js. `next start` then serves it with Service-Worker-Allowed: / and Cache-Control: public, max-age=0, must-revalidate, so scope '/' works. **(load-bearing)**

Response headers seen: `Service-Worker-Allowed: /`, `Cache-Control: public, max-age=0, must-revalidate`, `Content-Type: application/javascript; charset=UTF-8`. Source: next/dist/server/lib/router-server.js (`if (matchedOutput.itemPath.startsWith('/service-worker/')) { res.setHeader('Cache-Control','public, max-age=0, must-revalidate'); res.setHeader('Service-Worker-Allowed', config.basePath || '/') }`). next/dist/build/index.js also adds a routes-manifest header for `${basePath}/_next/static/service-worker/:path*` with Service-Worker-Allowed, so hosted deployments get it too.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/progressive-web-apps.mdx · confidence: verified-official-doc

### The PWA guide's web-push setup uses VAPID keys from env vars NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, calls webpush.setVapidDetails, and sends from a Server Action. **(load-bearing)**

Key generation: `npm install -g web-push` then `web-push generate-vapid-keys` (or `npx web-push generate-vapid-keys`). Setup: `webpush.setVapidDetails('mailto:your-email@example.com', process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!)`. Send: `await webpush.sendNotification(subscription, JSON.stringify({ title, body, icon }))`. The guide's app/actions.ts ('use server') keeps the subscription in memory; for real use, persist it in the DB.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/progressive-web-apps.mdx · confidence: verified-official-doc

### The PWA guide's next.config security headers: global X-Content-Type-Options, X-Frame-Options and Referrer-Policy, plus Content-Type, Cache-Control and CSP headers for source '/sw.js'. **(load-bearing)**

`source: '/(.*)'` gets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`. `source: '/sw.js'` gets `Content-Type: application/javascript; charset=utf-8`, `Cache-Control: no-cache, no-store, must-revalidate`, `Content-Security-Policy: default-src 'self'; script-src 'self'`. This '/sw.js' rule only applies if you serve public/sw.js yourself; it does not match the bundled /_next/static/service-worker/sw.js path.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/progressive-web-apps.mdx · confidence: verified-official-doc

### Tailwind v4 with Next: install tailwindcss, @tailwindcss/postcss and postcss; add postcss.config.mjs with the '@tailwindcss/postcss' plugin; put `@import "tailwindcss";` in app/globals.css. No tailwind.config.js is needed. **(load-bearing)**

`npm install tailwindcss @tailwindcss/postcss postcss`
postcss.config.mjs: `const config = { plugins: { "@tailwindcss/postcss": {} } }; export default config;`
globals.css: `@import "tailwindcss";`
Checked locally in a Next 16.3.6 Turbopack build with tailwindcss 4.3.3.

Source: https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/app/(docs)/docs/installation/framework-guides/nextjs.tsx · confidence: verified-official-doc

### Tailwind v4 design tokens are CSS variables inside @theme. Namespaces generate utilities: --color-*, --font-*, --text-*, --breakpoint-*, --radius-*, --spacing-*, --shadow-*. Use @theme inline when a token references another variable. **(load-bearing)**

`@theme { --color-mint-500: oklch(0.72 0.11 178); }` produces bg-mint-500 etc. `@theme inline { --font-sans: var(--font-inter); }`. `@theme static { ... }` always emits the variables. Reset a namespace with `--color-*: initial;`. Use :root for plain CSS variables that should not generate utilities.

Source: https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/docs/theme.mdx · confidence: verified-official-doc

### Tailwind v4 dark mode follows prefers-color-scheme by default. For a class- or attribute-based toggle, redefine the variant with @custom-variant.

Class: `@custom-variant dark (&:where(.dark, .dark *));` Attribute: `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));` Toggle: `document.documentElement.classList.toggle('dark', localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches))`. Checked locally: the output CSS contains `.dark\:bg-black:where(.dark,.dark *)`.

Source: https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/docs/dark-mode.mdx · confidence: verified-official-doc

### Tailwind v4 scans for classes starting from the current working directory and skips .gitignore'd files, node_modules, binaries, CSS and lockfiles. A pnpm workspace package outside apps/web is not scanned unless you add @source. **(load-bearing)**

Tested locally: a class string in packages/core/src was missing from the CSS when building from apps/web. Adding `@source "../../../packages/core/src";` to apps/web/app/globals.css (the path is relative to the CSS file) fixed it. Other syntax: `@import "tailwindcss" source("../src")`, `@source not "..."`, `@source inline("...")`.

Source: https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/docs/detecting-classes-in-source-files.mdx · confidence: verified-official-doc

### Under Turbopack, pnpm, npm and Yarn workspace packages are transpiled automatically, so transpilePackages is not needed for them with the App Router. It is still needed for raw TypeScript in node_modules and for webpack with the Pages Router. **(load-bearing)**

The docs say: "Turbopack transpiles workspace packages (npm, pnpm, or Yarn workspaces) in your monorepo automatically under both routers." transpilePackages takes package names only, not paths or globs: `transpilePackages: ['package-name', '@scope/pkg']`. A package cannot be in both transpilePackages and serverExternalPackages; Next throws at build start.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/05-config/01-next-config-js/transpilePackages.mdx · confidence: verified-official-doc

### Tested locally: explicit `.ts` import specifiers work under Next 16.3.6 Turbopack, both inside a workspace package and in the app. The setup was TS 6.0.3 with allowImportingTsExtensions + noEmit, and the package exports raw .ts files. No transpilePackages entry was needed. **(load-bearing)**

Setup matched the repo: package.json `"exports": { ".": "./src/index.ts", "./*": "./src/*.ts" }`, `"type": "module"`. packages/core/src/index.ts has `export { greet } from './greet.ts'` and `export type { Greeting } from './types.ts'`. The page imported `@t/core`, `@t/core/extra` and `./lib.ts`. `next build` compiled, passed the TypeScript check, and `next start` rendered the output. rewriteRelativeImportExtensions is not needed because nothing is emitted (noEmit). The unsupported case is the reverse: importing `./x.js` to mean x.ts does not resolve in Turbopack (issue #82945).

Source: https://github.com/vercel/next.js/issues/82945 · confidence: verified-official-doc

### Server Actions CSRF protection: actions can only be called by POST. Next compares the Origin header's host with x-forwarded-host (or host) and aborts on a mismatch. Extra allowed hosts go in `experimental.serverActions.allowedOrigins`, which is still under experimental in the 16.3.6 docs. **(load-bearing)**

```js
module.exports = { experimental: { serverActions: { allowedOrigins: ['my-proxy.com', '*.my-proxy.com'] } } }
```
Wildcards: `*` matches one label; `**` matches one or more labels and only at the start; bare `*` or `**` alone is rejected. Ports must be written explicitly. Checked in installed source: next/dist/server/app-render/action-handler.js (compares originHost with `x-forwarded-host`/`host`, falls back to `isCsrfOriginAllowed(originHost, serverActions?.allowedOrigins)`), and next/dist/server/app-render/csrf-protection.js. Behind a proxy no entry is needed if it forwards x-forwarded-host. A Chrome extension's origin (chrome-extension://...) will not match, so the extension should call Route Handlers, not Server Actions.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.mdx · confidence: verified-official-doc

### The default Server Actions body size limit is 1 MB. Change it with experimental.serverActions.bodySizeLimit, as a number of bytes or a string like '2mb'. **(load-bearing)**

`experimental: { serverActions: { bodySizeLimit: '2mb' } }`. Installed source, action-handler.js: `const defaultBodySizeLimit = '1 MB'; ... : 1024 * 1024 // 1 MB`. For multipart uploads, the docs suggest adding about 10–20 KB of overhead.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.mdx · confidence: verified-official-doc

### Server Actions are publicly reachable POST endpoints, so every action must check authentication and authorization itself. Closure values are encrypted with a per-build key, which can be set with NEXT_SERVER_ACTIONS_ENCRYPTION_KEY. Unused actions are removed from the client bundle. **(load-bearing)**

The docs say to "treat Server Actions as reachable via direct POST requests and verify authentication and authorization inside each one". A page-level auth check does not extend to the actions defined in that page. NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is base64 of a 16, 24 or 32 byte AES key, needed only for self-hosted multi-instance setups.

Source: https://raw.githubusercontent.com/vercel/next.js/v16.3.6/docs/01-app/02-guides/data-security.mdx · confidence: verified-official-doc

### Vercel Hobby with fluid compute (on by default): function maxDuration defaults to 300 s and cannot go higher. Pro and Enterprise default to 300 s with a maximum of 800 s. **(load-bearing)**

Hobby: default 300s, max 300s. Pro/Enterprise: default 300s, max 800s, with opt-in 1800s (beta). Hobby memory is fixed at 2 GB / 1 vCPU. The request/response body limit is 4.5 MB; exceeding it returns 413 FUNCTION_PAYLOAD_TOO_LARGE. Set it in Next with `export const maxDuration = 300` in a route or page. vercel.com is blocked for direct fetch, so these come from vercel.com search results.

Source: https://vercel.com/docs/functions/limitations · confidence: secondary-source

### Vercel cron on Hobby: each cron job may run at most once per day, and a more frequent expression fails the deploy. Invocation can land anywhere in the scheduled hour. Crons run in UTC, only on production deployments, as HTTP GET. **(load-bearing)**

Example: `0 8 * * *` fires between 08:00:00 and 08:59:59 on Hobby. vercel.json: `{ "crons": [{ "path": "/api/cron/daily", "schedule": "0 5 * * *" }] }`. Requests carry user agent `vercel-cron/1.0` and header `x-vercel-cron-schedule`. If the CRON_SECRET env var is set, Vercel sends `Authorization: Bearer ${CRON_SECRET}`; check it and return 401 on a mismatch. Since January 2026, every plan allows 100 cron jobs per project with no per-team cap (Hobby's per-team cap used to be 2). vercel.com is blocked for direct fetch, so these come from vercel.com search results.

Source: https://vercel.com/docs/cron-jobs/usage-and-pricing · confidence: secondary-source

### The Vercel Hobby plan is for personal, non-commercial use only. A private personal dashboard fits that.

Commercial usage means any deployment used for the financial gain of anyone involved in producing it, including a paid employee or consultant writing the code. Commercial use requires Pro or Enterprise. Vercel may disable Hobby deployments at its discretion. vercel.com is blocked for direct fetch, so these come from vercel.com search results.

Source: https://vercel.com/docs/limits/fair-use-guidelines · confidence: secondary-source
