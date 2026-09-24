# Personal Home capture helper (Chrome MV3)

A private Chrome extension, loaded unpacked by the owner, that collects the ChatGPT and Claude
conversations **you select** into your Personal Home dashboard. It reads only what Chrome renders
in your own signed-in tabs. It is not a verified chat-history API, and nothing here has been
exercised against the live chatgpt.com or claude.ai yet (see "Live verification" below).

## Build and load

```sh
pnpm install
pnpm --filter @personal-home/extension build      # writes apps/extension/dist (gitignored)
pnpm --filter @personal-home/extension test       # Vitest + jsdom on synthetic DOM fixtures
```

1. Open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked** and choose
   `apps/extension/dist`. (Branded Chrome ignores `--load-extension`; use the button.)
2. After every rebuild, click the reload icon on the extension card.
3. **Reload any ChatGPT/Claude tabs that were already open**: Chrome does not inject content
   scripts into tabs opened before the extension was installed or reloaded.

### Stable extension ID (recommended)

An unpacked extension's ID comes from its folder path. The dashboard records the helper's origin
(`chrome-extension://<id>`) at pairing and refuses requests from any other origin, so if you load
the extension from a different folder you must pair again. To pin the ID, build with a public key:

```sh
PH_EXTENSION_KEY='<base64 public key>' pnpm --filter @personal-home/extension build
```

The documented way to get a key is the Chrome Developer Dashboard: upload a zip of `dist`
(without publishing), open **Package → View public key**, copy the text between the BEGIN/END
lines without newlines. The key is public; it is not a secret, but it is not committed either.

### `manifest.json`

`apps/extension/manifest.json` is the template copied to `dist/` by `build.mjs` (which also sets
`version` from `package.json` and, if given, `key` from `PH_EXTENSION_KEY`).

| Key | Why |
|---|---|
| `permissions: storage` | Device token, selection cache, upload queue and settings in `chrome.storage.local`, restricted to the worker and the helper's own pages (not content scripts). |
| `permissions: alarms` | One 1-minute alarm: selection sync, queue retry, wake/startup catch-up, revisits. |
| `host_permissions: https://chatgpt.com/*, https://claude.ai/*` | Content scripts on those sites; reading a revisit tab's URL. |
| `optional_host_permissions` | Your dashboard's address, requested only when you pair (`https://*/*`, or `http://localhost` for development). |
| `content_scripts` | `content-chatgpt.js` / `content-claude.js` at `document_idle`. |
| `background.service_worker` (`type: module`) | Pairing, uploads, badge, catch-up, revisits. |
| `content_security_policy` | Scripts only from the package (MV3 forbids remote code). |

Not requested: `tabs`, `scripting`, `cookies`, `webRequest`, `history`, `notifications`.

## Pairing

1. In the dashboard: **Settings → Chrome helper → Create pairing code**. The code is shown once
   and works once for 10 minutes. Five wrong attempts that name it (its first four characters)
   kill it; other wrong or malformed codes do not touch it. Each network address may fail 10
   times per 10 minutes before the dashboard makes it wait.
2. In the helper: right-click the toolbar icon → **Options**. Enter the dashboard address (for
   example `https://home.example.com`), a name for this browser and the code. Chrome asks to let
   the helper reach the dashboard's address; choose Allow.
3. The dashboard returns a device token once. The helper keeps it in `chrome.storage.local`; the
   dashboard stores only its SHA-256 hash. Revoke a browser from Settings → Chrome helper at any
   time; **Unpair** in Options deletes the token and any queued captures from the browser.

### Where the token is kept, and why

By default `chrome.storage.local` is readable and writable by the extension's content scripts,
which run inside chatgpt.com and claude.ai next to untrusted AI output. The service worker
therefore calls `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` (and
the same for `session`) every time it starts, and pairing checks that the call succeeded
**before** it spends the code or stores a token. After that only the service worker and the
helper's own popup/options pages can use the storage; the content scripts never needed it (they
message the worker). If Chrome refuses the call, the helper does not pair and says why.

Trade-offs considered:

- `chrome.storage.session` is also limited to trusted contexts, but it lives in memory and is
  cleared whenever Chrome quits. The token would be lost on every restart, so startup catch-up
  and the offline queue could not work without pairing again each day. Not chosen.
- Restricting `local` keeps the token (and the pairing address, queue and selection, which a
  content script could otherwise rewrite to redirect uploads) out of reach of the pages while
  surviving restarts. The token is still stored unencrypted in the Chrome profile on disk:
  anyone who can read your OS account's files can read it. If the laptop is lost, revoke the
  browser in Settings → Chrome helper.

Checked locally on 2026-09-24 in Chromium 141 (Playwright, a throwaway extension and a synthetic
page, not the live services): without the call a content script read and wrote
`chrome.storage.local`; after it, both failed with "Access to storage is not allowed from this
context", and the setting was still in force after restarting the browser with the same
profile.

The token can only list the conversations you selected (id, provider, id from the URL, URL, state)
and upload captures or problem reports for them. It cannot select conversations, read captured
text back, or reach anything else.

## Selecting conversations

- Dashboard **Projects → Attach a conversation**: paste a `https://chatgpt.com/c/…` or
  `https://claude.ai/chat/…` link and choose a project; or
- Helper popup on an open conversation → **Track this conversation**. This opens the dashboard's
  `/projects/attach?url=…` page, where you confirm with your own session.

Shared links, temporary chats and other pages cannot be selected.

## What is collected

- The rendered text of user and assistant messages of **selected** conversations, while a tab
  shows them.
- Message identity: ChatGPT `data-message-id` (or `data-turn-id`); for Claude, the row position
  (`data-index`) as `d:<index>:<role>:0`, so an edited Claude message becomes a new version of
  the same message. In ChatGPT an edited prompt or regenerated reply gets new message ids, so it
  is stored as a new message next to the original; the earlier branch is kept, never deleted.
- Order hints (ChatGPT `conversation-turn-N`, Claude `data-index`), capture time, the page
  title, and honest coverage: whether the first and last message were actually seen, whether
  every message between them was seen during the same page visit (`contiguous`, with the number
  of turns never seen when the page lists them), how many messages were rendered and
  accumulated, whether a reply was still streaming, and whether the capture was passive or a
  revisit. The page lists the whole thread through ChatGPT's persistent
  `[data-turn-id-container]` turn wrappers and Claude's `data-index` rows with `aria-setsize`
  (or the rows up to the last one while it is mounted). Without that list the helper claims no
  gap-free view unless a single view shows the whole thread.

### What is NOT collected

- Attachments, images, generated images, files, canvases/artifacts and Deep Research panels.
- Hidden messages: other branches of an edited message that are not displayed, collapsed or
  unrendered content, anything never shown on screen.
- History you did not scroll through. Both apps draw long conversations a window at a time and
  unmount the rest. The helper accumulates each window as it mounts, so **scroll through a long
  conversation once** (top to bottom) to collect it all. Jumping straight to the top or bottom
  (Home/End, dragging the scrollbar) skips the middle; the dashboard then says that messages
  between the first and the last were never in view, and it says when the start or end has not
  been seen.
- Replies that are still streaming (they are collected once finished).
- Cookies, tokens or passwords. The helper never calls ChatGPT's or Claude's internal APIs
  (`/backend-api`, `/api/organizations/…`), never forges requests, never scrolls or clicks in
  your conversations, and never tries to get past a sign-in page or verification check.

Nothing already saved is ever deleted because a page did not show it. Raw text is meant to be
kept by the dashboard for 30 days (hashes, times and summaries would remain after that), but the
purge is not scheduled yet: it arrives with the retention job in Milestone 2. Until then raw text
stays until you remove the conversation in Settings → Chrome helper.

## Terms of use (read before using revisits)

Anthropic's Consumer Terms prohibit crawling, scraping or otherwise harvesting data, and
accessing the services "through automated or non-human means, whether through a bot, script, or
otherwise" except via an API key or with explicit permission. OpenAI's Terms of Use prohibit
"automatically or programmatically extract[ing] data or Output". Neither addresses a personal
extension that reads your own rendered conversations, and there is no carve-out for it
(docs/research/chat-dom.md). Both services offer an official data export as a sanctioned
alternative.

The helper is therefore built to be as close to ordinary reading as possible:

- **Passive capture (default):** only while *you* have a selected conversation open.
- **Background revisits (opt-in prototype, off by default):** the popup explains the risk and
  needs an explicit acknowledgement before it can be switched on. When on, every 30 minutes
  (while Chrome runs) each selected conversation not captured in the last 30 minutes is queued
  (at most 20). At most one collector tab per service is open at a time: a normal background tab
  in your current window, visible in the tab strip, never hidden or minimised. The helper lets
  the page render, captures once, and closes the tab (or after 90 seconds). It only ever closes
  tabs it opened. A sign-in page or verification check stops revisits for that service at once
  and marks the conversation Signed out / Needs attention; resume from the popup after you sign
  in yourself. Switching revisits off or **Pause all** closes collector tabs immediately. Every
  step is in the popup's activity log.

Using revisits may breach those terms and could put your accounts at risk. That decision is
yours.

## States you may see

| Where | State | Meaning |
|---|---|---|
| Dashboard | Collecting | Captured whenever it is open (and on revisits if enabled). |
| Dashboard | Reconnect | The page was signed out. Sign in, then choose Reconnect. |
| Dashboard | Capture needs attention | A verification check was shown, or the page no longer matched the expected structure (the service changed its layout; the helper may need an update). |
| Badge | `!` grey | Not paired. |
| Badge | `!` red | Revoked/unknown token or wrong origin, or a conversation needs attention. |
| Badge | `OFF` | Pause all is on. |
| Badge | number | Captures waiting to upload (offline or dashboard unreachable). |
| Badge | `REV` | A revisit tab is open. |

## Reliability

- The service worker is event-driven (it stops when idle). All listeners are registered at the
  top level; all state is in `chrome.storage.local`.
- The page is read at least every 250 ms while it keeps changing (so windows passed while
  scrolling are kept) and handed to the service worker once it has been quiet for 1.5 s. When
  you switch to another conversation, hide the tab or leave the page, what the visit collected
  is handed over at once (on page unload this is best effort: Chrome may not deliver it).
- Uploads go through a bounded offline queue (40 items / 6 MB, a week at most) with exponential
  backoff and `Retry-After`. A newer capture of the same page visit replaces an older queued one.
- On browser start (`runtime.onStartup`) and when the 1-minute alarm fires after a long gap
  (Chrome fires a missed repeating alarm once on wake), the helper re-syncs the selection,
  retries the queue, asks open conversation tabs to re-check, and (if enabled) queues revisits.
- Payloads stay within the endpoint's limits: at most 2,000 messages and ~2 MB per snapshot
  (larger pages are split into chunks that each report they are partial); a single message over
  200,000 characters is left out and counted, never truncated.

## Live verification protocol (the brief's early gate)

None of this has been run against the real services. The container that built the helper cannot
reach chatgpt.com or claude.ai; every selector comes from open-source exporters' 2026 code
(docs/research/chat-dom.md) and is tested only against synthetic DOM fixtures.

What *was* exercised (2026-09-24, local, synthetic): the built extension loaded into Chromium
141 (Playwright, headless) with SYNTHETIC pages served at `https://chatgpt.com/c/…` and
`https://claude.ai/chat/…` by request interception, against a local dashboard and database. The
module service worker started and created its alarm; pairing through the worker succeeded
(so Chromium sent `Origin: chrome-extension://<id>` on the worker's POST); opening the page
stored 2 messages, a new exchange raised it to 4; a signed-out page paused the conversation on
the dashboard; with revisits switched on, one non-active background tab opened for an unopened
Claude conversation, captured it in revisit mode and was closed by the helper, leaving the
owner's other tabs alone. That run also found (and the helper now handles) Chrome < 150
rejecting the alarms `persistAcrossSessions` field. This is not live verification.

Run each step on **both** services, and record pass/fail with dates in
`docs/INTEGRATION_RESULTS.md`:

1. **Pairing.** Pair as above. If pairing fails with "did not receive this extension's origin",
   Chrome did not send `Origin: chrome-extension://<id>` on the service worker's POST: report it.
2. **Changed messages.** Select a conversation, open it, send a new message. Within a few seconds
   of the reply finishing, Settings → Chrome helper shows two more saved messages and a fresh
   "Last captured".
3. **Long conversations.** Open a conversation with 50+ messages cold (it opens at the bottom).
   The dashboard should say the start was not in view. Press Home (or drag the scrollbar) to jump
   to the top, then End: the dashboard must say that messages in between were never in view and
   must not say "saw every message". Now scroll steadily to the top and back down without
   pausing; the saved count should reach the full length (compare it with the conversation) and
   "saw every message from the first to the last" appear. Then reload and scroll only partway:
   the saved count must not shrink. If the saved count is lower than the real length while the
   dashboard claims every message, the page's thread list (turn wrappers / `aria-setsize`)
   differs from the research notes: report it.
4. **Edited messages.** Edit an earlier prompt (and regenerate a reply). Claude: the same message
   gains a new version. ChatGPT: the new branch appears as new messages next to the original.
   Switch back to the earlier branch with the `<` arrow: no duplicates, no deletions.
5. **Phone-to-web visibility.** Add a message from the phone app. Open the same conversation in
   Chrome on the laptop: the phone message should render and be captured. (Record whether and how
   quickly the web page shows it.) With revisits on, check it arrives within ~30 minutes without
   opening the tab yourself.
6. **Startup catch-up.** Go offline (disconnect Wi-Fi), capture a change (badge shows a number),
   quit Chrome, reconnect, start Chrome: the queue uploads. Put the laptop to sleep for an hour
   and wake it: the activity log shows "Woke up after a pause: catching up".
7. **Signed out / challenge.** Sign out of the service in another tab and reload a selected
   conversation: the dashboard shows Reconnect and saved messages are kept. Sign in, choose
   Reconnect, reload: collecting resumes. (If a verification check appears, it must not be
   clicked by the helper; the conversation shows Capture needs attention.)
8. **Revisits (only if you opt in).** Turn on revisits; within a minute one background tab per
   service opens, renders, and closes itself; the popup log records it. Close a revisit tab
   yourself: it is not reopened until the next interval. Pause all closes it at once.

If a step fails because the page structure differs from the fixtures, save the page's HTML
(DevTools → Elements → copy outerHTML of the thread) privately and update the selectors in
`src/content/extract-*.ts` and the fixtures in `test/fixtures/`.

## Code map

| Path | What |
|---|---|
| `src/content/extract-chatgpt.ts`, `extract-claude.ts` | Pure DOM extractors (selectors and their sources in the file headers). |
| `src/content/accumulator.ts` | Merges virtualised windows by message key; honest coverage. |
| `src/content/runtime.ts` | MutationObserver, debounce, streaming wait, problem reports, SPA navigation. |
| `src/background/background.ts` | Service-worker controller (pairing, sync, queue, badge, catch-up, revisits). |
| `src/background/service-worker.ts` | Top-level listener registration. |
| `src/shared/snapshot.ts`, `queue.ts`, `revisit.ts`, `badge.ts`, `api.ts` | Pure logic and the dashboard client. |
| `src/popup`, `src/options`, `static/` | Popup and options pages. |
| `test/fixtures/` | SYNTHETIC DOM fixtures shaped from the research notes (not captured from the live services). |
