# Research notes: DOM and URL structure of chatgpt.com and claude.ai (2025-2026) as used by open-source exporter extensions, plus the terms-of-use position on automated extraction (checked against the sources on 2026-09-24)

_Collected 2026-09-24 via web research (verified by a second pass). Sources are linked per fact. The build container itself cannot reach these hosts._

## Corrections and surprises

- CORRECTED: the chatgpt-exporter issues cited as evidence of selector churn are the wrong kind of evidence. #373 is a maintainer's troubleshooting guide ('[Troubleshooting] No Export button?', 2026-08-09). #381 ('Exporter on Firefox breaks ChatGPT web', 2026-08-27) is caused by the userscript's own fetch override conflicting with Firefox sandboxing, not by a ChatGPT DOM change. They were replaced with revivalstack v3.0.0, the obsidian-AI-exporter selector comments and ai-hub.
- CORRECTED: chatgpt-exporter image.ts does not filter placeholder wrappers on --last-known-height alone. The filter is `has a conversation-turn descendant || offsetHeight > 0 || --last-known-height set`.
- CORRECTED: the steipete/oracle turn-selector union also includes `[data-message-author-role]` on article/div/section. STOP_BUTTON_SELECTORS has a third entry, a form-scoped `aria-label*="stop" i` with dictation/voice/read exclusions. dwell-protocol warns that an unscoped aria-label*=stop matches sidebar chat titles.
- CORRECTED: ADR-017's ChatGPT mount counts (6/14/8) were measured on an 'mweb proxy' (mobile web), not desktop. Desktop windowing evidence comes from a separate 2026-07-29 measurement (mid-scroll window turns 17-21).
- UNVERIFIED: the 'Clio issue #256 (2026-09-05) 53 unique vs 20 in DOM' citation could not be located (no repo owner given; web-search budget exhausted; GitHub issue search returned nothing). The virtualization claim itself is well supported by ADR-017, issue #499 and kadragon/prompt-vault (Claude: 6 of 56 rows rendered cold, aria-setsize=56).
- NEW: ChatGPT image-generation turns (`section[data-turn-id][data-turn="assistant"]`) have no `[data-message-id]` and no `.markdown.prose` (obsidian ADR-041). Dedupe on data-turn-id; data-message-id alone misses these turns.
- NEW/CORRECTED: on Claude, `data-is-streaming` sits on the same element as `.font-claude-response` in obsidian's fixtures, but on an ancestor wrapper in claude-font-fix. Use `closest('[data-is-streaming]')`. During streaming, `.standard-markdown` is also nested inside `.progressive-markdown`, so checking for `.standard-markdown` does not prove completion.
- NEW: Claude's version arrows have also shipped as 'Previous message', not only 'Previous version' (Prompty selectors.ts). Attachment-only Claude user rows have no [data-testid="user-message"] node (prompt-vault), so counting user messages by that testid can undercount.
- NEW: ChatGPT exposes a `data-streaming-response-status` attribute (for example "thinking"), used by codex-chatgpt-web as a streaming signal. Another candidate signal next to the stop button.
- UPGRADED: Claude URL shapes claude.ai/chat/{uuid} and claude.ai/project/{uuid} are confirmed by the official Claude help center (Open Claude Desktop with a link, article 14729294). The nested /project/<id>/chat/<uuid> form (PCE-Core only) and /recents remain unverified.
- OpenAI terms wording is confirmed through verbatim mirror copies. Rest of world: 'Effective: January 1, 2026' (SpiderX/portage-overlay). EU: 'Updated: 16 January 2026' with gerund wording (OpenTermsArchive). The extraction bullet dates back to at least the Jan 31, 2024 version. openai.com and help.openai.com are still egress-blocked, so this stays secondary-source.
- The codex #17860 Cloudflare 403 concerns the Codex CLI endpoints (/backend-api/codex/responses, /backend-api/plugins/featured), not the conversation endpoints. Other sources say the challenges generally hit non-browser clients and datacenter IPs. That server-side fetches 'will' be challenged is an inference, now worded as 'likely'.
- Minor: the earlier summary wrote `tree=True` for the Claude endpoint. agarwalvishal's README uses `tree=true`, while daymade and Prompty use `tree=True`. Both spellings appear in the wild.
- Environment limits: this session's WebSearch budget (200) was already used up, so verification used WebFetch, GitHub code search and raw.githubusercontent.com. GitHub issue_read/get_file_contents are restricted to the user's repo, so issue pages were read through WebFetch.

## Facts

### ChatGPT conversation URL: https://chatgpt.com/c/<uuid>. chatgpt-exporter gets the chat ID with one regex that covers plain chats, custom GPTs, projects and share links. **(load-bearing)**

Confirmed in src/page.ts: `/^\/(?:share(?:\/[a-z]+)?|c|g\/[a-z0-9-]+\/c)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i`. Temporary chat: `new URLSearchParams(location.search).get('temporary-chat') === 'true'`. Share page: `location.pathname.startsWith('/share') && !location.pathname.endsWith('/continue')`. page.ts also has `checkIfConversationStarted()` = `!!document.querySelector('[data-testid^="conversation-turn-"]')`. Simpler regex from obsidian-AI-exporter src/content/extractors/chatgpt.ts: `/\/c\/([a-f0-9-]+)/i`. Its e2e page-match regex is in e2e/selectors/auth-check.ts: `/^https:\/\/chatgpt\.com\/(?:c\/|g\/[^/]+\/c\/)/`.

Source: https://raw.githubusercontent.com/pionxzh/chatgpt-exporter/master/src/page.ts · confidence: secondary-source

### URLs for custom GPTs and Projects are nested under /g/<id>/c/<uuid>. Project IDs are `g-p-` plus 32 hex characters, and a project path segment can appear with or without a `-<name>` slug. A project's home page is /g/g-p-<id>[-slug]/project. **(load-bearing)**

lroolle/chat-exporter DEVLOG.md, section '[2025-01-11] Dev Log: ChatGPT Markdown Exporter': `/\/g\/(g-(?:p-)?[a-zA-Z0-9]+)/`, `const isProject = gptId?.startsWith('g-p-');`. Examples: `chatgpt.com/g/g-2DQzU5UZl/c/{id}`, `chatgpt.com/g/g-689ae2f1363881919fc41124c7dbc2fd/c/{id}`, `chatgpt.com/g/g-p-{id}/c/{id}`. Confirmed in ElonQian1/Elon (scripts/chatgpt-fresh-project-smoke.ps1 and android assets): `^g-p-[a-f0-9]{32}$`; conversation `^(?:/g/g-p-[a-f0-9]{32}(?:-[A-Za-z0-9_-]{1,124})?)?/c/(<uuid>)$`; project home `^/g/g-p-[a-f0-9]{32}(?:-[A-Za-z0-9_-]{1,124})?/project$`. Confirmed in youdie006/prodex CHANGELOG.md: "measured within one send, the same project renders as both `/g/g-p-<id>/project` and `/g/g-p-<id>-<name>/c/<id>`", so compare by project ID. Confirmed in niakw/NiakGPT breadcrumb-v100.js: `location.pathname.match(/^\/g\/(g-p-[^/?#]+)(?:[/?#]|$)/i)`. Note that `[^/?#]+` also captures the `-<name>` slug.

Source: https://github.com/lroolle/chat-exporter/blob/main/DEVLOG.md · confidence: secondary-source

### ChatGPT turn container as of 2026: a <section> (not <article>) with data-testid="conversation-turn-N", data-turn="user|assistant" and data-turn-id=<uuid>. It changed from article to section in 2026-03. **(load-bearing)**

Confirmed verbatim in the obsidian-AI-exporter selectors/chatgpt.ts comment (ref bc4e054): "ChatGPT changed from <article> to <section> in 2026-03; the article variants matched nothing on the live site by 2026-07 and were removed". Selectors: `'section[data-turn-id]'`, `'section[data-testid^="conversation-turn"]'`. DES-003 fixture: `<section data-turn-id="b6bda243-..." data-turn="assistant">`. defuddle fixtures also use `<section data-testid="conversation-turn-1">`. Corrected steipete/oracle CONVERSATION_TURN_SELECTOR (verbatim): `'article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"], section[data-testid^="conversation-turn"], ' + "article[data-message-author-role], div[data-message-author-role], section[data-message-author-role], " + "article[data-turn], div[data-turn], section[data-turn]"`. For resilience, select on the attribute and ignore the tag.

Source: https://raw.githubusercontent.com/sho7650/obsidian-AI-exporter/main/src/content/extractors/selectors/chatgpt.ts · confidence: secondary-source

### ChatGPT message elements carry data-message-author-role, data-message-id (UUID) and data-message-model-slug. One assistant turn can hold several message elements. Image-generation turns have no data-message-id and no .markdown.prose. **(load-bearing)**

DES-003 fixture (confirmed): `<div data-message-author-role="assistant" data-message-id="56d7ef64-7cc6-4736-9711-b8b6d6789351" data-message-model-slug="gpt-5-2"><div class="markdown prose dark:prose-invert w-full break-words light markdown-new-styling">`. kepano/defuddle src/extractors/chatgpt.ts (confirmed): `// ChatGPT can split one assistant turn into multiple message elements` then `Array.from(turn.querySelectorAll('[data-message-author-role]')).filter(el => el.closest('[data-testid^="conversation-turn-"]') === turn)`. defuddle fixture also shows `data-turn-start-message="true"`. chatgpt-exporter src/main.tsx (confirmed): `document.querySelectorAll('main [data-testid^="conversation-turn-"] [data-message-id]')`. obsidian-AI-exporter docs/adr/041-chatgpt-generated-image-capture.md: an image-generation turn is `section[data-turn-id][data-turn="assistant"]` with "**no** `.markdown.prose`, **no** `[data-message-id]`". Key identity on data-turn-id, and use data-message-id only when it is present.

Source: https://github.com/sho7650/obsidian-AI-exporter/blob/main/docs/design/DES-003-chatgpt-extractor.md · confidence: secondary-source

### ChatGPT content roots: assistant markdown is `.markdown.prose` and user text is `.whitespace-pre-wrap`. Each turn has a localized sr-only heading such as "ChatGPT said:". **(load-bearing)**

Confirmed obsidian-AI-exporter selectors. User: `'[data-message-author-role="user"] .whitespace-pre-wrap'`, `'section[data-turn="user"] .whitespace-pre-wrap'`, `'.user-message-bubble-color .whitespace-pre-wrap'`. Assistant: `'[data-message-author-role="assistant"] .markdown.prose'`, `'section[data-turn="assistant"] .markdown.prose'`, `'.markdown.prose.dark\\:prose-invert'`. Markdown: `'.markdown.prose'`, `'.markdown-new-styling'`. defuddle reads the author with `h4.sr-only, h5.sr-only, h6.sr-only` and has the comment "Get the localized author text from the sr-only heading". Current defuddle fixtures use `<h4 class="sr-only">You said:</h4>` / `<h4 class="sr-only">ChatGPT said:</h4>` (also h5). Older article-era snapshots (for example saypi doc/dom/chatgpt/agent-turn-article.html) use h6. Do not match on the heading text.

Source: https://raw.githubusercontent.com/sho7650/obsidian-AI-exporter/main/src/content/extractors/selectors/chatgpt.ts · confidence: secondary-source

### ChatGPT streaming is detected mainly by the stop button being visible. Secondary signals are a class on the active markdown container and a data-streaming-response-status attribute. The per-turn action buttons on the last assistant turn signal completion. **(load-bearing)**

steipete/oracle src/browser/constants.ts (confirmed verbatim): `STOP_BUTTON_SELECTOR = '[data-testid="stop-button"]'`; `STOP_BUTTON_SELECTORS = [STOP_BUTTON_SELECTOR, '[data-testid="composer-stop-button"]', 'form button[aria-label*="stop" i]:not([aria-label*="dictat" i]):not([aria-label*="voice" i]):not([aria-label*="read" i])']`; `FINISHED_ACTIONS_SELECTOR = 'button[data-testid="copy-turn-action-button"], button[data-testid="good-response-turn-action-button"], button[data-testid="bad-response-turn-action-button"], button[aria-label="Share"]'`. copy-turn-action-button also appears on user turns (defuddle fixture), so scope the check to the last assistant turn. LangQueue src/content/adapters/chatgpt.ts (confirmed): `// Active response's markdown container gets this class while streaming` → `document.querySelector('.streaming-animation')`. `.result-streaming` still appears in many scripts (e.g. llm-council inject.js). dwell-protocol content.js (confirmed): `'button[data-testid="stop-streaming"]', // ChatGPT (older)`. It also warns that a bare `aria-label*="stop"` matched sidebar conversation titles ("6 Train Not Stopping"). miuuyy/codex-chatgpt-web browser-worker.ts counts `[data-streaming-response-status]` elements, and its tests use the value `"thinking"`.

Source: https://github.com/steipete/oracle/blob/main/src/browser/constants.ts · confidence: secondary-source

### ChatGPT virtualizes long conversations: turns are mounted and unmounted while you scroll in either direction, so reading the DOM once after scrolling loses messages. **(load-bearing)**

obsidian-AI-exporter ADR-017 (Date: 2026-07-06). ChatGPT, measured on an "mweb proxy" (mobile web, not desktop): "Initial mounted: 6 messages (at bottom)", "After scrolling up: 14 mounted at top", "Scroll back to bottom: back to 6; earlier 8 evicted". Stable IDs: "`data-message-id` / `data-turn-id` (uuid)". Scroll container: `div[data-scroll-root]`, with fallback `[class*="not-print:overflow-y-auto"]`. selectors/chatgpt.ts comment (confirmed): "the sidebar <nav> also has `flex-1 flex-col overflow-y-auto` (plain, scrollTop 0), so a class-only `overflow-y-auto` selector picks the nav and skips auto-scroll (verified live 2026-07)". Desktop evidence (chatgpt.ts, 2026-07-29, issue #353): "a mid-scroll window reported turns 17-21, the top window 1-21". UNVERIFIED: the 'Clio issue #256 (2026-09-05) 53 vs 20' citation could not be found. Fix: attach a MutationObserver to the scroll container before scrolling, capture each turn as it mounts, dedupe by data-turn-id (data-message-id may be missing), and order by the conversation-turn-N ordinal or by merge.

Source: https://github.com/sho7650/obsidian-AI-exporter/blob/main/docs/adr/017-autoscroll-virtualized-platforms.md · confidence: secondary-source

### Outer ChatGPT turn wrappers ([data-turn-id-container]) stay in the DOM after their content is unmounted and can exist before the message body hydrates. An empty wrapper does not mean the turn is empty. **(load-bearing)**

Corrected chatgpt-exporter src/exporter/image.ts. The filter is an OR of three conditions, not only --last-known-height: `threadEl.querySelectorAll('[data-turn-id-container][data-is-intersecting]')).filter(element => !!element.querySelector('[data-testid^="conversation-turn-"]') || element.offsetHeight > 0 || !!element.style.getPropertyValue('--last-known-height'))`, then `.map(element => element.dataset.turnIdContainer).filter(id => !!id && id !== 'client-created-root')`. AI-MarkDone docs/adr/ADR-0028-chatgpt-staged-slot-hydration.md (confirmed): "ChatGPT can create the outer `data-turn-id-container` topology before it hydrates every message body... A user prompt can also be mounted first with an empty body and receive its text in a later DOM mutation." miuuyy/codex-chatgpt-web docs/architecture.md (confirmed): "The submission baseline includes the persistent `data-turn-id-container` wrappers of virtualized history."

Source: https://github.com/pionxzh/chatgpt-exporter/blob/master/src/exporter/image.ts · confidence: secondary-source

### Sources disagree on whether the N in data-testid="conversation-turn-N" is a stable ordinal. Use data-turn-id (or data-message-id when present) for identity. **(load-bearing)**

obsidian-AI-exporter selectors/chatgpt.ts (confirmed): "The `data-testid` ordinal is numbered across the whole conversation and is NOT renumbered per mounted window (measured live 2026-07-29: a mid-scroll window reported turns 17-21, the top window 1-21)". ADR-022 and ADR-036 repeat this. miuuyy/codex-chatgpt-web docs/architecture.md (confirmed): "use ChatGPT's logical `data-turn-id`, not the `conversation-turn-N` display index, which can change during rendering". AI-MarkDone docs/architecture/DEPENDENCY_RULES.md (verbatim): "UUIDs and mutable `conversation-turn-N` values are never sorted as ordinals."

Source: https://github.com/miuuyy/codex-chatgpt-web/blob/main/docs/architecture.md · confidence: secondary-source

### ChatGPT branch navigation for edited or regenerated messages ("< 2/2 >") consists of two buttons with aria-labels and a tabular-nums counter. The aria-labels are localized.

Confirmed: `button[aria-label="Previous response"]` / `button[aria-label="Next response"]` (LLMChatNavigator src/platform/chatgpt/convo/ChatGptConvoController.ts; arjuna-dev/chatGPT-branches requirements.md). Counter: `div .tabular-nums` whose textContent matches `/^\d+\/\d+$/`. A saved page snapshot shows `<div class="px-0.5 text-sm font-semibold tabular-nums">2/2</div>` and `aria-label="Edit message"`. PCE-Core pce_core/adapters/chatgpt.yaml (confirmed): "current ChatGPT UI labels arrows \"Previous/Next response\" in EN, \"上一回复\"/\"下一回复\" in zh-CN", with selectors `button[aria-label*="Previous response" i]`, `button[aria-label*="Previous reply" i]`, `button[aria-label*="Previous" i]`, `button[aria-label*="上一回复"]`. The statement that only the selected branch is rendered is plausible, but no source checked here says so directly.

Source: https://github.com/arjuna-dev/chatGPT-branches/blob/main/.kiro/specs/chatgpt-branching-extension/requirements.md · confidence: secondary-source

### Claude chat URLs are claude.ai/chat/<uuid> and project URLs are claude.ai/project/<uuid>. Both IDs are UUIDs (official help center). **(load-bearing)**

support.claude.com 'Open Claude Desktop with a link' (fetched): `claude://claude.ai/chat/{conversation-id}` and `claude://claude.ai/project/{project-id}`: "Opens a specific chat or project by its ID. The ID is the UUID you see at the end of the chat or project URL in Claude."

Source: https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link · confidence: verified-official-doc

### Extensions match Claude chats with `/chat/<uuid>` in the path and a strict hostname check. Other routes include /new and /share/<snapshot-id>, and a nested /project/<id>/chat/<uuid> form is reported. **(load-bearing)**

obsidian-AI-exporter src/content/extractors/claude.ts (confirmed): `window.location.pathname.match(/\/chat\/([a-f0-9-]{36})/i)`. Hostname check: `window.location.hostname === 'claude.ai'` (the docs say this is strict equality for CodeQL). e2e/selectors/auth-check.ts: `/^https:\/\/claude\.ai\/chat\//`. PCE-Core pce_browser_extension_wxt/entrypoints/claude.content.ts: `/^\/(?:new(?:$|\/)|chat\/|project\/[^/]+\/chat\/)/i`, with the comment "/project/<id>/chat/<uuid> — Projects chat". That nested form is not confirmed elsewhere, but an unanchored `/chat/<uuid>` match covers both. daymade SKILL.md: the share page `/share/<snapshot-id>` is keyed by the snapshot ID, which is not the conversation ID. `/recents` is unverified.

Source: https://github.com/sho7650/obsidian-AI-exporter/blob/main/src/content/extractors/claude.ts · confidence: secondary-source

### Claude user messages are marked with [data-testid="user-message"]. The class-based markers (.bg-bg-300, !font-user-message) were removed in 2026-08. Attachment-only user rows have no user-message node. **(load-bearing)**

obsidian-AI-exporter selectors/claude.ts (confirmed verbatim): `userMessage: ['[data-testid="user-message"]', // Grid container (HIGH)`, `'.whitespace-pre-wrap.break-words', // Legacy inner <p> (LOW fallback)]`. Comment: "2026-08: two fallbacks dropped, both measured at zero on the live pages. `.bg-bg-300 p` — Claude removed the bg-bg-300 token outright (the user bubble is now `.bg-neutral-30 dark:…bg-surface-3 .rounded-xl`)... the `!font-user-message` class that made this substring match work disappeared a day after bg-bg-300 did." kadragon/prompt-vault CHANGELOG (2026-07-25): "The attachment-only row — no `user-message` node at all". Count user turns by row, not only by user-message nodes.

Source: https://raw.githubusercontent.com/sho7650/obsidian-AI-exporter/main/src/content/extractors/selectors/claude.ts · confidence: secondary-source

### Claude assistant replies are `.font-claude-response`, with data-is-streaming="true|false" either on that element or on an ancestor wrapper. Markdown is `.standard-markdown` when finished and `.progressive-markdown` while streaming. **(load-bearing)**

obsidian-AI-exporter selectors (confirmed): `assistantResponse: ['.font-claude-response', '[class*="font-claude-response"]', '[data-is-streaming]']`, `markdownContent: ['.standard-markdown', '[class*="markdown"]']`. Where the attribute sits differs by source. obsidian DES-002/DES-006 fixtures put it on the same element: `<div data-test-render-count="2"><div class="font-claude-response" data-is-streaming="false"><div class="standard-markdown">`. Azzoril/claude-font-fix dom-structure.md shows `div[data-is-streaming] <- "true" during streaming, "false" when done` as a wrapper around `.font-claude-response`. Robust check: `el.closest('[data-is-streaming]')`. claude-font-fix also says `.progressive-markdown` is the outer wrapper during streaming, `.standard-markdown` is nested inside it during streaming, and `.standard-markdown` is the direct container when complete. Thinking layout: `div.grid.grid-rows-[auto_auto]` with `div.row-start-1` for thinking and `div.row-start-2` for the answer. Legacy `.font-claude-message` is still used as a fallback (Zhaimiaoyizhi/TurnMap). Streaming test: `document.querySelector('[data-is-streaming="true"]')` (jackwener/OpenCLI clis/claude/utils.js). teddashh/multi-ai-chat comment: "NOT just [data-is-streaming] — \"false\" also matches". Exclude Deep Research artifacts with `.font-claude-response:not(#markdown-artifact)` (revivalstack/ai-chat-exporter and others).

Source: https://github.com/Azzoril/claude-font-fix/blob/main/dom-structure.md · confidence: secondary-source

### Sources disagree on where data-is-streaming appears. One says only the last reply container has it, so it cannot be used to count messages.

doggy8088/ask-bridge CHANGELOG.md (verbatim confirmed): "回覆容器採 `.font-claude-response`（`data-is-streaming` 屬性僅掛在最後一則回覆容器，不適合用於訊息計數）" ("use `.font-claude-response` as the reply container; the `data-is-streaming` attribute is only attached to the last reply container, so it is not suitable for counting messages"). The version/date header (0.2.2, 2026-07-10) was not re-checked. obsidian-AI-exporter fixtures (DES-002/DES-006) show `data-is-streaming="false"` on each response. Count messages with `.font-claude-response` and `[data-testid="user-message"]` (or with [data-index] rows).

Source: https://github.com/doggy8088/ask-bridge/blob/main/CHANGELOG.md · confidence: secondary-source

### Claude also virtualizes the thread. Rows are [data-index] wrappers (one per message, monotonic) inside a [data-autoscroll-container] scroller, and turns are also wrapped in div[data-test-render-count]. **(load-bearing)**

ADR-017 (2026-07-06), confirmed: Claude "Initial mounted: 3 turns (at bottom)"; "After scrolling up: grows to 5→7; `scrollHeight` 27310→30616"; "Scroll back to bottom: back to 3; earlier turns evicted". Stable ID: "`data-index` on the row wrapper (monotonic; user=20, asst=21)". selectors/claude.ts (confirmed): `conversationRow: ['[data-index]']`, `scrollContainer: ['[data-autoscroll-container]', '.overflow-y-auto.overflow-x-hidden.flex-1:has([data-index])']`. Comment: "2026-09 (issue #499)... Claude's redesigned left sidebar (`dframe-nav-scroll`) now carries the same three classes... (a 22-message thread came out as 7)... The thread scroller is the only element carrying `data-autoscroll-container` (measured live 2026-09-12: 1 match, holding every `[data-index]` row)". kadragon/prompt-vault (2026-07-25): on a 56-row conversation opened cold, "6 rows rendered (8 turn nodes) against a declared `aria-setsize` of 56". `aria-setsize` gives the total row count for a completeness check. `div[data-test-render-count]` wraps turns in obsidian fixtures and is used by insidebar-ai, CodeWebChat and ai-hub.

Source: https://github.com/sho7650/obsidian-AI-exporter/blob/main/docs/adr/017-autoscroll-virtualized-platforms.md · confidence: secondary-source

### Claude edited-message versions are navigated with buttons labelled "Previous version" and "Next version" next to an "N / M" counter. The action bar has data-testids. Assistant rows have no dedicated data-testid.

Yidiiiz/Prompty claude-extension-build-prompt.md (confirmed) lists as "Confirmed stable DOM hooks": `data-testid="user-message"`, `data-testid="chat-input"` (composer), `data-testid="action-bar-edit"` / `"action-bar-retry"` / `"action-bar-copy"`, `data-testid="file-upload"`, `aria-label="Previous version"` / `aria-label="Next version"` beside a visible `N / M` counter, and `div[data-selection-tooltip="true"]`. Prompty docs/recon-report.md §8: "Assistant message container has no dedicated `data-testid` in the snapshot". The current heuristic is a row with an action-bar copy/retry control and no user-message node. Prompty src/shared/selectors.ts: "claude.ai has shipped this arrow as \"Previous version\", \"Previous message\", etc.", so it matches a case-insensitive 'previous' substring inside one message row. The ojura/claude-web-navigation-fix detail was not re-checked.

Source: https://github.com/Yidiiiz/Prompty/blob/main/claude-extension-build-prompt.md · confidence: secondary-source

### Many popular exporters skip the DOM entirely and call the apps' internal, undocumented JSON endpoints with the user's session cookie.

ChatGPT (pionxzh/chatgpt-exporter): src/constants.ts maps `'https://chatgpt.com': 'https://chatgpt.com/backend-api'`. src/api.ts uses `/api/auth/session` (on baseUrl) and, on apiUrl, `/conversation/:id`, `/conversations` (offset, limit), `/share/:id`, `/files/download/:id`, `/gizmos/snorlax/sidebar`, `/gizmos/:gizmo/conversations`. src/temporaryChat.ts: `const CONVERSATION_STREAM_PATH = '/backend-api/f/conversation'`. Claude (agarwalvishal/claude-chat-exporter README, confirmed): `GET /api/organizations/{orgId}/chat_conversations/{conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`, with orgId from the `lastActiveOrg` cookie. Branch switch (Prompty src/page/api.ts): `PUT .../chat_conversations/{conv}/current_leaf_message_uuid` with body `JSON.stringify({ current_leaf_message_uuid: leafUuid })`. The Prompty recon also adds `&consistency=strong` to the tree GET. Share: `GET /api/chat_snapshots/<snapshot-id>?rendering_mode=messages&render_all_tools=true` (daymade). None of these are official APIs.

Source: https://github.com/agarwalvishal/claude-chat-exporter/blob/main/README.md · confidence: secondary-source

### Anthropic's Consumer Terms (effective October 8, 2025) prohibit scraping and automated or non-human access to the Services, except through an API key or with explicit permission. **(load-bearing)**

Fetched and confirmed verbatim: "Effective October 8, 2025". "To crawl, scrape, or otherwise harvest data or information from our Services other than as permitted under these Terms." / "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise." / Full sentence for the third quote: "You also must not abuse, harm, interfere with, or disrupt our Services, including, for example, introducing viruses or malware, spamming or DDoSing Services, or bypassing any of our systems or protective measures." There is no carve-out for personal browser extensions.

Source: https://www.anthropic.com/legal/consumer-terms · confidence: verified-official-doc

### Anthropic assigns Outputs to the user, subject to compliance with the Terms.

Verbatim, confirmed: "As between you and Anthropic, and to the extent permitted by applicable law, you retain any right, title, and interest that you have in the Inputs you submit. Subject to your compliance with our Terms, we assign to you all of our right, title, and interest—if any—in Outputs."

Source: https://www.anthropic.com/legal/consumer-terms · confidence: verified-official-doc

### OpenAI's Terms of Use forbid automatically or programmatically extracting data or Output, and forbid circumventing rate limits or protective measures. **(load-bearing)**

openai.com is egress-blocked, so this was checked against verbatim mirror copies. Rest of world (SpiderX/portage-overlay licenses/OpenAI): "Effective: January 1, 2026"; "What you cannot do."; "Automatically or programmatically extract data or Output (defined below)."; "Interfere with or disrupt our Services, including circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations we put on our Services." EU (OpenTermsArchive/genai-contrib-versions ChatGPT/Terms of Service.md): "Updated: 16 January 2026", gerund wording "Automatically or programmatically extracting data or Output" and "Interfering with or disrupting our Services, including circumventing any rate limits or restrictions or bypassing any protective measures or safety mitigations". The same bullet was already in the Jan 31, 2024 version.

Source: https://openai.com/policies/row-terms-of-use/ · confidence: secondary-source

### Both vendors offer an official, sanctioned export of the user's own conversations, which is an alternative to scraping.

Claude (fetched, confirmed): initials in the lower left → Settings → Privacy → "Export data". "The download link will expire 24 hours after delivery." "Data exports are available to individual Claude users on Free, Pro, and Max plans." On Team/Enterprise, "Only your organization's Primary Owner can access data exports." The file format is not stated. ChatGPT (help.openai.com blocked; secondary sources): Settings → Data controls → Export data → confirm. The emailed link expires after 24 hours, delivery can take up to 7 days, and the ZIP contains `conversations.json` (or numbered `conversations-NNN.json`) plus `chat.html`. One secondary source says ChatGPT Business/Enterprise workspace accounts cannot use this method.

Source: https://support.claude.com/en/articles/9450526-export-your-claude-data · confidence: verified-official-doc

### No official OpenAI or Anthropic statement was found that specifically permits or forbids a personal extension reading the user's own rendered conversation DOM. **(load-bearing)**

Checked the Anthropic consumer terms (fetched), the OpenAI terms (via mirror copies) and the Claude help center. Neither vendor's terms has a carve-out for this case, and neither addresses it explicitly. Whether passive DOM reading counts as 'programmatically extract' or 'automated or non-human means' is a legal question these sources do not answer.

Source: https://www.anthropic.com/legal/consumer-terms · confidence: unverified

### Documented failure mode: selector and class churn. Several projects report broken exports after UI updates. **(load-bearing)**

Confirmed examples: ChatGPT turns changed from <article> to <section> (2026-03; article selectors matched nothing by 2026-07, per obsidian-AI-exporter). Claude removed `.bg-bg-300` and then `!font-user-message` a day later (dropped 2026-08). Claude's sidebar redesign (`dframe-nav-scroll`) broke class-based scroll-container selectors in 2026-09 (issue #499). revivalstack/ai-chat-exporter README v3.0.0: "Critical Platform Fixes: Major updates to DOM selectors to restore broken exports across platforms." sunnycho100/ai-hub docs/DOM_SELECTORS_REFERENCE_CLAUDE.md: "Always use a multi-selector fallback strategy — Claude frequently updates its Tailwind classes." Correction: chatgpt-exporter #373 is a maintainer '[Troubleshooting] No Export button?' guide (2026-08-09), and #381 'Exporter on Firefox breaks ChatGPT web' (2026-08-27) is caused by the userscript's own fetch override conflicting with Firefox sandboxing. Neither is evidence of DOM churn. Mitigations: prefer data-testid / data-* attributes, keep ordered fallback lists, and run a live check that rejects zero-match selectors.

Source: https://github.com/revivalstack/ai-chat-exporter/blob/main/README.md · confidence: secondary-source

### Documented failure mode: Cloudflare challenges hit non-browser clients calling chatgpt.com/backend-api (403 with a `cf-mitigated: challenge` response header). An in-page content script shares the browser session and TLS fingerprint and is normally not affected. **(load-bearing)**

openai/codex #17860 (opened 2026-04-15), title: "Linux/WSL2: Cloudflare 403 blocks all chatgpt.com API requests — rustls TLS fingerprint detected as bot while macOS native-tls works fine on same network". The affected endpoints are `chatgpt.com/backend-api/codex/responses` and `/backend-api/plugins/featured`, not the conversation endpoints. Corroboration: Gitlawb/zero docs/oauth-subscriptions.md: "non-browser / headless clients get `cf-mitigated: challenge` → `403`"; judder659/Forven: requests from non-residential IPs (servers/VPS) get a 403 challenge; miuuyy/codex-chatgpt-web checks the `cf-mitigated`/`challenge` response header. GreedySearch-pi CHANGELOG (confirmed): ChatGPT renders Turnstile "inside a closed shadow DOM"; only the hidden `<input id="cf-chl-widget-…_response">` is visible to DOM queries. hanzi-browse domain-skills.json: claude.ai "Fresh browser fingerprints sometimes get a Cloudflare Turnstile challenge". Implication (inference): read the DOM or make same-origin fetches in the content script. Server-side fetches (for example from Supabase Edge Functions) to chatgpt.com or claude.ai are likely to be challenged.

Source: https://github.com/openai/codex/issues/17860 · confidence: secondary-source

### Documented failure mode: localized UI strings. The sr-only author headings and the aria-labels on branch and action buttons change with the UI language.

ChatGPT branch arrows: "Previous response"/"Next response" (EN) vs "上一回复"/"下一回复" (zh-CN), per PCE-Core pce_core/adapters/chatgpt.yaml (confirmed). defuddle's sr-only heading comment says "localized". codex-chatgpt-web tests match reasoning-stopped labels in several languages ("Рассуждение остановлено", "Réflexion interrompue", "생각 중지됨"). Use data-message-author-role, data-turn and data-testid rather than visible or ARIA text.

Source: https://github.com/zstnbb/PCE-Core/blob/main/pce_core/adapters/chatgpt.yaml · confidence: secondary-source
