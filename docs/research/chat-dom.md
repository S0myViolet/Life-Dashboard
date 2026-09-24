# Research notes: DOM and URL structure of chatgpt.com and claude.ai (2025-2026) as used by open-source exporter extensions, plus the terms-of-use position on automated extraction

_Collected 2026-09-24 via web research (single pass, not yet re-verified). Sources are linked per fact. The build container itself cannot reach these hosts._

## Corrections and surprises

- ChatGPT switched turn containers from <article> to <section> around 2026-03 (obsidian-AI-exporter). Many tutorials and older extensions still use `article[data-testid^="conversation-turn"]`, which reportedly matched nothing by 2026-07. One Sept 2026 DOM write-up (Vishal-RAJ-DEV CHATGPT_DOM_DISCOVERY.md, 2026-09-04) still documents `article`, which conflicts. Select on `[data-testid^="conversation-turn-"]` or `[data-turn]` regardless of tag.
- As of mid-2026, both ChatGPT and Claude virtualize long threads, evicting turns in both directions (ChatGPT kept roughly 6-14 turns mounted, Claude roughly 3-7, per live measurements in July 2026). Scrolling to the top and then reading the DOM loses messages. Capture turns as they mount with a MutationObserver during the scroll, keyed by data-message-id / data-turn-id (ChatGPT) or data-index (Claude). ChatGPT also leaves empty `[data-turn-id-container]` placeholder shells behind.
- Sources disagree on whether the N in ChatGPT's `conversation-turn-N` is stable: one project measured it as not renumbered, two others say it can change and must not be used as an ordinal. Use data-turn-id or data-message-id for identity.
- Claude removed the class-based user markers (`.font-user-message`, `.bg-bg-300`) in 2026. `[data-testid="user-message"]` is the surviving hook. Assistant messages have no data-testid, only the `.font-claude-response` class plus the `data-is-streaming` wrapper.
- Many well-known exporters (pionxzh/chatgpt-exporter, several Claude exporters) do not read the DOM. They call undocumented internal JSON endpoints (/backend-api/conversation/{id}; /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages) with session cookies.
- Read literally, Anthropic's consumer terms prohibit scraping and bot/script access, and OpenAI's prohibit 'automatically or programmatically extract data or Output'. Neither has a carve-out for a personal extension reading the user's own chats. The official Settings export (emailed link, 24h expiry) is the sanctioned route.
- openai.com, help.openai.com, community.openai.com and news.ycombinator.com are egress-blocked from this environment, so the OpenAI terms wording comes from search-engine snippets rather than a direct fetch. The GitHub MCP file-read tool was also restricted to the user's own repo, so repo contents were read through code-search snippets and raw.githubusercontent.com fetches, some of which a summarizer condensed.
- The GitHub code search index used here has no dates on individual lines. Dates given come from comments, ADRs or changelogs inside the repos (for example 'measured live 2026-09-12'). obsidian-AI-exporter snapshots are at ref bc4e0549672f5d73969d8e2c72974f587321d19b.

## Facts

### ChatGPT conversation URL: https://chatgpt.com/c/<uuid>. chatgpt-exporter gets the chat ID with one regex that covers plain chats, custom GPTs, projects and share links. **(load-bearing)**

From src/page.ts: `location.pathname.match(/^\/(?:share(?:\/[a-z]+)?|c|g\/[a-z0-9-]+\/c)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)`. Temporary chat check: `new URLSearchParams(location.search).get('temporary-chat') === 'true'`. Share page check: `location.pathname.startsWith('/share') && !location.pathname.endsWith('/continue')`. A simpler regex (obsidian-AI-exporter): `/\/c\/([a-f0-9-]+)/i`. Its e2e page-match regex: `/^https:\/\/chatgpt\.com\/(?:c\/|g\/[^/]+\/c\/)/`.

Source: https://raw.githubusercontent.com/pionxzh/chatgpt-exporter/master/src/page.ts · confidence: secondary-source

### URLs for custom GPTs and Projects are nested under /g/<id>/c/<uuid>. Project IDs start with g-p-, and a project can appear with or without a name slug. **(load-bearing)**

Custom GPT: `chatgpt.com/g/g-2DQzU5UZl/c/{id}` or `chatgpt.com/g/g-689ae2f1363881919fc41124c7dbc2fd/c/{id}`. Project: `chatgpt.com/g/g-p-{id}/c/{id}`. GPT-ID regex from lroolle/chat-exporter DEVLOG (2025): `url.match(/\/g\/(g-(?:p-)?[a-zA-Z0-9]+)/)`, with `isProject = gptId?.startsWith('g-p-')`. Stricter project check (ElonQian1/Elon): projectId `^g-p-[a-f0-9]{32}$`, path `^/g/<projectId>(?:-[A-Za-z0-9_-]{1,124})?/c/<uuid>$`. prodex CHANGELOG: within one send, the same project rendered as both `/g/g-p-<id>/project` (project home) and `/g/g-p-<id>-<name>/c/<id>`, so compare by project ID, not by the whole URL. NiakGPT: `pathname.match(/^\/g\/(g-p-[^/?#]+)(?:[/?#]|$)/i)`.

Source: https://github.com/lroolle/chat-exporter/blob/main/DEVLOG.md · confidence: secondary-source

### ChatGPT turn container, current as of 2026: a <section> (not <article>) with data-testid="conversation-turn-N", data-turn="user|assistant" and data-turn-id=<uuid>. It changed from article to section in 2026-03. **(load-bearing)**

obsidian-AI-exporter src/content/extractors/selectors/chatgpt.ts (ref bc4e054), comment: "ChatGPT changed from <article> to <section> in 2026-03; the article variants matched nothing on the live site by 2026-07 and were removed". Selectors: `'section[data-turn-id]'`, `'section[data-testid^="conversation-turn"]'`. Fixture: `<section data-turn-id="..." data-testid="conversation-turn-2" data-turn="assistant">`. Robust union (steipete/oracle constants.ts): `article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"], section[data-testid^="conversation-turn"], ... article[data-turn], div[data-turn], section[data-turn]`. For resilience, select on the attribute and ignore the tag.

Source: https://raw.githubusercontent.com/sho7650/obsidian-AI-exporter/main/src/content/extractors/selectors/chatgpt.ts · confidence: secondary-source

### ChatGPT message elements carry data-message-author-role, data-message-id (UUID) and data-message-model-slug. One assistant turn can hold several message elements. **(load-bearing)**

DES-003 fixture: `<div data-message-author-role="assistant" data-message-id="56d7ef64-..." data-message-model-slug="gpt-5-2"><div class="markdown prose dark:prose-invert w-full break-words light markdown-new-styling">`. kepano/defuddle chatgpt.ts comment: "ChatGPT can split one assistant turn into multiple message elements", handled by `turn.querySelectorAll('[data-message-author-role]')` filtered with `el.closest('[data-testid^="conversation-turn-"]') === turn`. chatgpt-exporter main.tsx uses `'main [data-testid^="conversation-turn-"] [data-message-id]'`.

Source: https://github.com/sho7650/obsidian-AI-exporter/blob/main/docs/design/DES-003-chatgpt-extractor.md · confidence: secondary-source

### ChatGPT content roots: assistant markdown is `.markdown.prose` and user text is `.whitespace-pre-wrap`. Each turn has a localized sr-only heading such as "ChatGPT said:". **(load-bearing)**

obsidian-AI-exporter selectors: user `'[data-message-author-role="user"] .whitespace-pre-wrap'`, `'section[data-turn="user"] .whitespace-pre-wrap'`, `'.user-message-bubble-color .whitespace-pre-wrap'`. Assistant: `'[data-message-author-role="assistant"] .markdown.prose'`, `'section[data-turn="assistant"] .markdown.prose'`. Markdown: `'.markdown.prose'`, `'.markdown-new-styling'`. defuddle reads the author from `turn.querySelector('h4.sr-only, h5.sr-only, h6.sr-only')`; the saypi fixture has `<h6 class="sr-only">ChatGPT said:</h6>`. The heading text is localized, so do not match on it.

Source: https://raw.githubusercontent.com/sho7650/obsidian-AI-exporter/main/src/content/extractors/selectors/chatgpt.ts · confidence: secondary-source

### ChatGPT streaming is detected mainly by the stop button being visible. A class on the active markdown container is a secondary signal, and the per-turn action buttons appear only once the reply is finished. **(load-bearing)**

steipete/oracle constants.ts: `STOP_BUTTON_SELECTOR = '[data-testid="stop-button"]'`, and STOP_BUTTON_SELECTORS also includes `'[data-testid="composer-stop-button"]'`. Completion signal: `FINISHED_ACTIONS_SELECTOR = 'button[data-testid="copy-turn-action-button"], button[data-testid="good-response-turn-action-button"], button[data-testid="bad-response-turn-action-button"], button[aria-label="Share"]'`. LangQueue adapter comment: "Active response's markdown container gets this class while streaming" → `.streaming-animation`. `.result-streaming` is an older class that many scripts still check. Older stop testid: `button[data-testid="stop-streaming"]` (dwell-protocol).

Source: https://github.com/steipete/oracle/blob/main/src/browser/constants.ts · confidence: secondary-source

### ChatGPT virtualizes long conversations: turns are mounted and unmounted while you scroll in either direction, so reading the DOM once after scrolling loses messages. **(load-bearing)**

obsidian-AI-exporter ADR-017 (2026-07-06, measured live): ChatGPT "initially mounts 6 messages at the bottom", "grows to 14 mounted at top after scrolling up", then evicts 8 on scrolling back. Stable per-turn ID: `data-message-id` / `data-turn-id`. Scroll container: `[data-scroll-root]`, fallback `[class*="not-print:overflow-y-auto"]`. Warning: the sidebar <nav> is also `overflow-y-auto`, so a class-only selector picks the wrong element. Clio issue #256 (2026-09-05): "unique messages seen across the whole scroll: 53" vs "in the DOM at the end: 20". Fix: attach a MutationObserver to the scroll container before scrolling, capture each turn as it mounts, dedupe by `data-message-id`, and order by testid/turn ID.

Source: https://github.com/sho7650/obsidian-AI-exporter/blob/main/docs/adr/017-autoscroll-virtualized-platforms.md · confidence: secondary-source

### Outer ChatGPT turn wrappers stay in the DOM as empty placeholders after their content is unmounted. **(load-bearing)**

chatgpt-exporter src/exporter/image.ts: `threadEl.querySelectorAll('[data-turn-id-container][data-is-intersecting]')`, filtered on `element.style.getPropertyValue('--last-known-height')`; it skips the container ID `'client-created-root'`. AI-MarkDone ADR-0028: "ChatGPT can create the outer `data-turn-id-container` topology before it hydrates every message body". codex-chatgpt-web docs/architecture.md: the baseline "includes the persistent `data-turn-id-container` wrappers of virtualized history". An empty wrapper therefore does not mean the turn is empty.

Source: https://github.com/pionxzh/chatgpt-exporter/blob/master/src/exporter/image.ts · confidence: secondary-source

### Sources disagree on whether the N in data-testid="conversation-turn-N" is a stable ordinal. Use data-turn-id or data-message-id for identity. **(load-bearing)**

obsidian-AI-exporter (measured live 2026-07-29): N "is numbered across the whole conversation and is NOT renumbered per mounted window"; parsed with `/^conversation-turn-(\d+)$/`. miuuyy/codex-chatgpt-web docs/architecture.md: "use ChatGPT's logical `data-turn-id`, not the `conversation-turn-N` display index, which can change during rendering". AI-MarkDone DEPENDENCY_RULES.md: "mutable `conversation-turn-N` values are never sorted as ordinals".

Source: https://github.com/miuuyy/codex-chatgpt-web/blob/main/docs/architecture.md · confidence: secondary-source

### ChatGPT branch navigation for edited or regenerated messages ("< 2/2 >") consists of two buttons with aria-labels and a tabular-nums counter. The aria-labels are localized.

Buttons: `button[aria-label="Previous response"]` and `button[aria-label="Next response"]` (LLMChatNavigator ChatGptConvoController.ts; chatgpt-custom-shortcuts-pro live audit, which also lists `aria-label="Edit message"`). Counter (arjuna-dev/chatGPT-branches spec): `div .tabular-nums` whose text matches `/^\d+\/\d+$/`. PCE-Core chatgpt.yaml: labels are "上一回复"/"下一回复" in zh-CN, so match case-insensitively with `aria-label*=` and expect localization. Only the currently selected branch is rendered. The other branches are not in the DOM.

Source: https://github.com/arjuna-dev/chatGPT-branches/blob/main/.kiro/specs/chatgpt-branching-extension/requirements.md · confidence: secondary-source

### Claude conversation URL: https://claude.ai/chat/<uuid>. A project home page is https://claude.ai/project/<uuid>. Other routes include /new, /recents and /share/<snapshot-id>. **(load-bearing)**

obsidian-AI-exporter claude.ts: `window.location.pathname.match(/\/chat\/([a-f0-9-]{36})/i)`, with hostname check `window.location.hostname === 'claude.ai'` (strict equality, per CodeQL). Page-match regex: `/^https:\/\/claude\.ai\/chat\//`. A Claude desktop deep-link doc lists `claude.ai/chat/{uuid}` and `claude.ai/project/{uuid}`. The share page is keyed by snapshot ID (daymade SKILL.md). PCE-Core also accepts `/project/<id>/chat/<uuid>` (`/^\/(?:new(?:$|\/)|chat\/|project\/[^/]+\/chat\/)/i`). That nested form is unverified, but matching on `/chat/<uuid>` anywhere in the path covers both.

Source: https://github.com/sho7650/obsidian-AI-exporter/blob/main/src/content/extractors/claude.ts · confidence: secondary-source

### Claude user messages are marked with [data-testid="user-message"]. The older class-based markers were removed in 2026. **(load-bearing)**

obsidian-AI-exporter selectors/claude.ts: `userMessage: ['[data-testid="user-message"]', // Grid container (HIGH)`, `'.whitespace-pre-wrap.break-words', // Legacy inner <p> (LOW fallback)]`. Comment: "Claude removed the bg-bg-300 token outright (the user bubble is now `.bg-neutral-30 dark:…bg-surface-3 .rounded-xl`)" and "the `!font-user-message` class that made this substring match work disappeared a day after bg-bg-300 did".

Source: https://raw.githubusercontent.com/sho7650/obsidian-AI-exporter/main/src/content/extractors/selectors/claude.ts · confidence: secondary-source

### Claude assistant replies are `.font-claude-response` inside a wrapper that carries data-is-streaming="true|false". Markdown is `.standard-markdown` when finished and `.progressive-markdown` while streaming. **(load-bearing)**

Selectors: `assistantResponse: ['.font-claude-response', '[class*="font-claude-response"]', '[data-is-streaming]']` and `markdownContent: ['.standard-markdown', '[class*="markdown"]']` (obsidian-AI-exporter). Azzoril/claude-font-fix dom-structure.md: `div[data-is-streaming] <- "true" during streaming, "false" when done` wraps `.font-claude-response`, and uses `:is(.standard-markdown, .progressive-markdown)`. Replies with thinking use a grid: `div.row-start-1` holds thinking and `div.row-start-2` holds the answer. Legacy class: `.font-claude-message`. Streaming test: `document.querySelector('[data-is-streaming="true"]')` (OpenCLI). Do not use the bare `[data-is-streaming]` as a streaming test, because it also matches "false". Exclude Deep Research artifacts: `.font-claude-response:not(#markdown-artifact)`.

Source: https://github.com/Azzoril/claude-font-fix/blob/main/dom-structure.md · confidence: secondary-source

### Sources disagree on where data-is-streaming appears. One says only the last reply container has it, so it cannot be used to count messages.

doggy8088/ask-bridge CHANGELOG [0.2.2] 2026-07-10, calibrated against the live site: "回覆容器採 `.font-claude-response`（`data-is-streaming` 屬性僅掛在最後一則回覆容器，不適合用於訊息計數）" ("use `.font-claude-response` as the reply container; the `data-is-streaming` attribute is only attached to the last reply container, so it is not suitable for counting messages"). Other fixtures (obsidian-AI-exporter DES-002/DES-006) show `data-is-streaming="false"` on each response. Count messages with `.font-claude-response` and `[data-testid="user-message"]`.

Source: https://github.com/doggy8088/ask-bridge/blob/main/CHANGELOG.md · confidence: secondary-source

### Claude also virtualizes the thread. Rows are [data-index] wrappers inside a [data-autoscroll-container] scroller, and turns are also wrapped in div[data-test-render-count]. **(load-bearing)**

ADR-017 (2026-07-06): Claude "initially mounts 3 turns at the bottom" and grows to 5-7 when scrolling up (scrollHeight 27310→30616). Earlier turns are evicted when scrolling back down. Stable ID: `data-index` (monotonic). selectors/claude.ts: `conversationRow: ['[data-index]']`, and `scrollContainer: ['[data-autoscroll-container]', '.overflow-y-auto.overflow-x-hidden.flex-1:has([data-index])']`. Comment: "measured live 2026-09-12: 1 match, holding every `[data-index]` row". An earlier class-only overflow selector matched the sidebar (issue 2026-09). The ai-hub reference doc says `div[data-test-render-count]` identifies each exchange.

Source: https://github.com/sho7650/obsidian-AI-exporter/blob/main/docs/adr/017-autoscroll-virtualized-platforms.md · confidence: secondary-source

### Claude edited-message versions are navigated with buttons labelled "Previous version" and "Next version" next to an "N / M" counter. The action bar has data-testids.

Yidiiiz/Prompty claude-extension-build-prompt.md (July 2026 capture) lists as confirmed DOM hooks: `data-testid="user-message"`, `data-testid="chat-input"` (composer), `data-testid="action-bar-edit"` / `"action-bar-retry"` / `"action-bar-copy"`, and branch buttons `aria-label="Previous version"` / `aria-label="Next version"` beside a visible `N / M` counter. Assistant messages have no dedicated data-testid. ojura/claude-web-navigation-fix: the version buttons and the `n / m` counter live inside the message action bar, and when a message has no action bar the row is 0px tall with no buttons.

Source: https://github.com/Yidiiiz/Prompty/blob/main/claude-extension-build-prompt.md · confidence: secondary-source

### Many popular exporters skip the DOM entirely and call the apps' internal, undocumented JSON endpoints with the user's session cookie.

ChatGPT (pionxzh/chatgpt-exporter src/api.ts): `/api/auth/session`, then `https://chatgpt.com/backend-api/conversation/:id`, `/backend-api/conversations?offset&limit`, `/backend-api/share/:id`. Stream endpoint: `/backend-api/f/conversation`. Claude (agarwalvishal/claude-chat-exporter README): `GET /api/organizations/{orgId}/chat_conversations/{conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`, where "orgId comes from the `lastActiveOrg` cookie". Branch switch: `PUT .../chat_conversations/{conv}/current_leaf_message_uuid` with body `{"current_leaf_message_uuid": "..."}` (Prompty recon). Share: `GET /api/chat_snapshots/<snapshot-id>?rendering_mode=messages&render_all_tools=true`. None of these are official APIs, and any of them can change without notice.

Source: https://github.com/agarwalvishal/claude-chat-exporter/blob/main/README.md · confidence: secondary-source

### Anthropic's Consumer Terms (effective October 8, 2025) prohibit scraping and automated or non-human access to the Services, except through an API key or with explicit permission. **(load-bearing)**

Verbatim: "To crawl, scrape, or otherwise harvest data or information from our Services other than as permitted under these Terms." / "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise." / "...or bypassing any of our systems or protective measures." There is no carve-out for personal browser extensions that read the user's own rendered page. Whether passively reading already-rendered DOM counts is a legal-interpretation question these terms do not answer.

Source: https://www.anthropic.com/legal/consumer-terms · confidence: verified-official-doc

### Anthropic assigns Outputs to the user, subject to compliance with the Terms.

Verbatim: "As between you and Anthropic, and to the extent permitted by applicable law, you retain any right, title, and interest that you have in the Inputs you submit. Subject to your compliance with our Terms, we assign to you all of our right, title, and interest—if any—in Outputs."

Source: https://www.anthropic.com/legal/consumer-terms · confidence: verified-official-doc

### OpenAI's Terms of Use forbid automatically or programmatically extracting data or Output, and forbid circumventing rate limits or protective measures. **(load-bearing)**

"What you cannot do" bullets, as returned by search snippets of openai.com/policies/row-terms-of-use and eu-terms-of-use: "Automatically or programmatically extract data or Output"; "Interfere with or disrupt our Services, including circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations". Per search results, the rest-of-world Terms of Use became effective January 1, 2026 and the EU Terms were updated January 16, 2026. openai.com is blocked from this environment, so the page could not be fetched directly. The wording comes from search-engine snippets.

Source: https://openai.com/policies/row-terms-of-use/ · confidence: secondary-source

### Both vendors offer an official, sanctioned export of the user's own conversations, which is an alternative to scraping.

Claude: initials (lower left) → Settings → Privacy → "Export data". A download link is emailed and expires 24h after delivery. Available on Free, Pro and Max (individual users). On Team/Enterprise only the Primary Owner can export. The article does not state the file format. ChatGPT (via search snippets of help.openai.com): Profile → Settings → Data Controls → Export → Confirm export. The emailed link expires after 24 hours, the export can take up to 7 days, and the zip contains `conversations.json` (large exports are split into numbered JSON files).

Source: https://support.claude.com/en/articles/9450526-export-your-claude-data · confidence: verified-official-doc

### No official OpenAI or Anthropic statement was found that specifically permits or forbids a personal extension reading the user's own rendered conversation DOM. **(load-bearing)**

Searched the Anthropic consumer terms (fetched), OpenAI terms (search snippets only), and both help centers. Neither vendor's terms has a carve-out for this case, and neither addresses it explicitly.

Source: https://www.anthropic.com/legal/consumer-terms · confidence: unverified

### Documented failure mode: selector and class churn. Many projects report broken exports after UI updates. **(load-bearing)**

Examples: ChatGPT turns changed from <article> to <section> (2026-03). Claude removed `.bg-bg-300` and `!font-user-message` one day apart (2026). Claude also has two assistant class variants over time, `.font-claude-message` (older) and `.font-claude-response` (current). The ai-hub reference (Jan 2026) says "Claude frequently updates its Tailwind classes. Always use a multi-selector fallback strategy." chatgpt-exporter issues: #373 "No Export button?" (2026-08-09) and #381 "Exporter on Firefox breaks ChatGPT web" (2026-08-27). revivalstack/ai-chat-exporter v3.0.0: "Major updates to DOM selectors to restore broken exports". Mitigations: prefer data-testid / data-* attributes over Tailwind classes, keep ordered fallback lists, and run a live check that a selector still matches something (obsidian-AI-exporter's baseline contract rejects zero-match selectors).

Source: https://github.com/pionxzh/chatgpt-exporter/issues/373 · confidence: secondary-source

### Documented failure mode: Cloudflare challenges hit non-browser clients calling chatgpt.com/backend-api (403 with a `cf-mitigated: challenge` response header). An in-page content script normally shares the browser session and is not affected. **(load-bearing)**

openai/codex #17860 (opened 2026-04-15): the Linux build's rustls TLS fingerprint gets `cf-mitigated: challenge` and HTTP 403 from chatgpt.com/backend-api, while the macOS native-TLS build passes. GreedySearch-pi CHANGELOG: ChatGPT renders Cloudflare Turnstile "inside a closed shadow DOM"; only a hidden `<input id="cf-chl-widget-…_response">` is visible to DOM queries. Implication: do DOM reading or same-origin fetches inside the content script. Server-side fetches (for example from Supabase Edge Functions) to chatgpt.com or claude.ai will be challenged.

Source: https://github.com/openai/codex/issues/17860 · confidence: secondary-source

### Documented failure mode: localized UI strings. The sr-only author headings and the aria-labels on branch and action buttons change with the UI language.

ChatGPT branch arrows: "Previous response"/"Next response" (EN) vs "上一回复"/"下一回复" (zh-CN), per PCE-Core pce_core/adapters/chatgpt.yaml. defuddle notes that the sr-only heading author text is "localized". Use role attributes (data-message-author-role, data-turn, data-testid) rather than visible or ARIA text.

Source: https://github.com/zstnbb/PCE-Core/blob/main/pce_core/adapters/chatgpt.yaml · confidence: secondary-source
