# Research notes: Chrome Extensions Manifest V3 (Chrome 140+; stable is about 152-153 as of 2026-09-24): alarms, service worker lifetime, tabs/windows/scripting, content scripts and messaging, CORS, storage, badge, notifications, loading unpacked, remote code

_Collected 2026-09-24 via web research (single pass, not yet re-verified). Sources are linked per fact. The build container itself cannot reach these hosts._

## Corrections and surprises

- Chrome 150 added alarms.AlarmCreateInfo.persistAcrossSessions (default true in Chrome), and Chrome 152 added AlarmCreateInfo.name. Older guidance said alarms 'may be cleared upon browser restart', and one search extract pulled 'Alarms are not saved when you close Chrome' from the deprecated Chrome Apps codelab. Treat both as outdated: in current Chrome, alarms persist by default. Still re-create alarms in onStartup and onInstalled to be safe.
- Alarms in unpacked extensions have no rate limit, so the 30-second minimum is not enforced while this private extension stays unpacked.
- developer.chrome.com API reference pages are now titled 'browser.X' because Chrome 148 exposes every API under the browser namespace as well as chrome. Declaring a devtools_page turns off the browser namespace for the whole extension.
- runtime.onMessage can return a Promise natively only in recent Chrome: 148 per the browser-namespace doc, 146 per another extract. Earlier versions need `return true` + sendResponse.
- Since Chrome 137, branded Chrome ignores the --load-extension command-line flag. Unpacked loading has to go through chrome://extensions, or use Chromium or Chrome for Testing.
- The MV3 CSP allows localhost sources in script-src for unpacked extensions only.
- chrome-types is generated from Chromium trunk, so some tags (runtime.onEnabled and tabs.create splitWithTabId, both @since Chrome 155) are not on stable yet. Stable Chrome on 2026-09-24 is estimated at about 152-153, which is inferred and was not checked.
- WebFetch was blocked for developer.chrome.com, MDN and chromium.org. Facts marked 'secondary-source' are search-engine extracts of official pages. Facts marked 'verified-official-doc' come from Google's chrome-types@0.1.450 package, generated 2026-09-23 from Chromium source.

## Facts

### Method note: WebFetch was blocked by the egress proxy for developer.chrome.com, developer.mozilla.org and chromium.org. Facts marked 'verified-official-doc' come from the Google-published npm package chrome-types@0.1.450, which Google generates from Chromium source and which is the source for the developer.chrome.com API reference pages. Facts marked 'secondary-source' come from search-engine extracts of official developer.chrome.com pages that could not be fetched directly.

chrome-types header: '// Generated on Wed Sep 23 2026 22:44:06 GMT+0000' '// Built at 4f6f60a0f126d22f11acf933a69c614504e7e20e' '// Includes MV3+ APIs only.' It is generated from Chromium trunk, so a '@since Chrome 15x' tag can refer to a version that is not yet on stable. Local copy: /tmp/claude-0/-home-user-Life-Dashboard/df7b1cd4-c8df-5801-a54e-a0b97a9ae4de/scratchpad/package/index.d.ts

Source: https://www.npmjs.com/package/chrome-types · confidence: verified-official-doc

### The minimum chrome.alarms delay and period is 30 seconds (0.5 minutes). Smaller values are not honored and log a warning. Alarms can also fire later than scheduled by an arbitrary amount. **(load-bearing)**

Verbatim from the create() doc: 'Chrome limits alarms to at most once every 30 seconds but may delay them an arbitrary amount more. That is, setting `delayInMinutes` or `periodInMinutes` to less than `0.5` will not be honored and will cause a warning. `when` can be set to less than 30 seconds after "now" without warning but won't actually cause the alarm to fire for at least 30 seconds.' The 30-second minimum started in Chrome 120 (before that it was 1 minute). Permission: "alarms". Example: chrome.alarms.create('collect', { periodInMinutes: 0.5 })

Source: https://developer.chrome.com/docs/extensions/reference/api/alarms · confidence: verified-official-doc

### Alarms in unpacked extensions have no rate limit.

Verbatim: 'To help you debug your app or extension, when you've loaded it unpacked, there's no limit to how often the alarm can fire.' Because the dashboard extension will stay unpacked, periods under 30 seconds would work for it. Do not rely on this if the extension is ever packed.

Source: https://developer.chrome.com/docs/extensions/reference/api/alarms · confidence: verified-official-doc

### The AlarmCreateInfo fields are when, delayInMinutes, periodInMinutes, persistAcrossSessions (Chrome 150+) and name (Chrome 152+). Creating an alarm with an existing name replaces that alarm. **(load-bearing)**

Signature: create(name?: string, alarmInfo: AlarmCreateInfo): Promise<void>. The initial time is set by 'when' or 'delayInMinutes', not both. For a repeating alarm with neither set, periodInMinutes is used as the delay. Alarm object fields: name, scheduledTime (ms since epoch), periodInMinutes?, persistAcrossSessions. Other methods: get(name), getAll(), clear(name), clearAll(). Event: chrome.alarms.onAlarm.addListener(alarm => ...).

Source: https://developer.chrome.com/docs/extensions/reference/api/alarms · confidence: verified-official-doc

### Alarms survive browser restarts by default in Chrome. Chrome 150 added persistAcrossSessions to make this explicit (default true). **(load-bearing)**

From the IDL: 'Whether the alarm should persist across sessions (browser restarts). In Chrome, this defaults to true to match historical behavior, but you should set this explicitly to maximize compatibility across browsers. @since Chrome 150'. Per the MDN PR: true means the alarm persists until the extension updates; false means it is cleared when the extension is reloaded or updated or the browser restarts. Recommended pattern: in both runtime.onInstalled and runtime.onStartup, call chrome.alarms.get(name) and recreate the alarm if it is missing.

Source: https://developer.chrome.com/docs/extensions/reference/api/alarms ; https://github.com/mdn/content/pull/45712 · confidence: verified-official-doc

### While the device sleeps, alarms do not wake it. On wake, missed alarms fire, and a repeating alarm fires at most once before being rescheduled from the wake time. **(load-bearing)**

Official alarms page (search extract): 'Alarms continue to run while a device is sleeping. However, an alarm will not wake up a device. When the device wakes up, any missed alarms will fire. Repeating alarms will fire at most once and then be rescheduled using the specified period starting from when the device wakes, not taking into account any time that has already elapsed since the alarm was originally set to run.'

Source: https://developer.chrome.com/docs/extensions/reference/api/alarms · confidence: secondary-source

### Since Chrome 117, an extension can have at most 500 active alarms. Past that, chrome.alarms.create() fails.

The promise rejects, or chrome.runtime.lastError is set when using a callback.

Source: https://developer.chrome.com/docs/extensions/reference/api/alarms · confidence: secondary-source

### An extension service worker stops after 30 seconds of inactivity. Receiving an event or calling an extension API resets that timer. It is also stopped if a single event or API call takes more than 5 minutes, or if a fetch() response takes more than 30 seconds to arrive. **(load-bearing)**

Since Chrome 110 every extension event resets the idle timer, and the idle timeout does not trigger while events are pending. The old hard 5-minute total lifetime was removed. Calling extension APIs such as chrome.storage.local.get() also resets the idle timer. Global variables are lost on shutdown, so persist state to chrome.storage.

Source: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle ; https://developer.chrome.com/blog/longer-esw-lifetimes · confidence: secondary-source

### Other things that keep the service worker alive: WebSocket traffic (Chrome 116+), native messaging (Chrome 105+), an active chrome.debugger session (Chrome 118+), and messages from an offscreen document.

Chrome 116: 'Active WebSocket connections now extend extension service worker lifetimes. Sending or receiving messages across a WebSocket in an extension service worker resets the service worker's idle timer.' A native messaging port from runtime.connectNative() keeps the worker alive. There is no official 'keepAlive' API. The supported approach is event-driven work, such as a chrome.alarms tick every 30 seconds or more.

Source: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle ; https://developer.chrome.com/blog/chrome-116-beta-whats-new-for-extensions · confidence: secondary-source

### runtime.onStartup fires when a profile with the extension first starts. runtime.onInstalled fires on install, on extension update and on Chrome update. **(load-bearing)**

From the IDL: onStartup: 'Fired when a profile that has this extension installed first starts up. This event is not fired when an incognito profile is started...' onInstalled: 'Fired when the extension is first installed, when the extension is updated to a new version, and when Chrome is updated to a new version.' details.reason is one of 'install' | 'update' | 'chrome_update' | 'shared_module_update'. details.previousVersion is set when reason is 'update'. runtime.onEnabled is tagged @since Chrome 155, which is not on stable yet. Clicking reload on an unpacked extension fires onInstalled with reason 'update'. That last point is from memory and was not checked against the docs.

Source: https://developer.chrome.com/docs/extensions/reference/api/runtime · confidence: verified-official-doc

### Service worker event listeners must be registered synchronously at the top level of the script. **(load-bearing)**

Official guidance: listeners registered asynchronously, for example inside a promise or callback, are missed when an event wakes the worker. So call chrome.alarms.onAlarm.addListener, chrome.runtime.onMessage.addListener and similar at module top level.

Source: https://developer.chrome.com/docs/extensions/get-started/tutorial/service-worker-events · confidence: secondary-source

### chrome.tabs.create accepts windowId, index, url, active (default true), pinned, openerTabId and splitWithTabId (Chrome 155+), and returns Promise<Tab>. The 'active' flag does not change window focus. **(load-bearing)**

'active' doc: 'Whether the tab should become the active tab in the window. Does not affect whether the window is focused (see windows.update). Defaults to `true`.' Example: const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false, windowId }). No 'tabs' permission is needed to create tabs.

Source: https://developer.chrome.com/docs/extensions/reference/api/tabs · confidence: verified-official-doc

### chrome.tabs.update(tabId, props) accepts url, active, highlighted, pinned, muted, openerTabId and autoDiscardable, and returns Promise<Tab|undefined>. javascript: URLs are rejected. **(load-bearing)**

'A URL to navigate the tab to. JavaScript URLs are not supported; use scripting.executeScript instead.' Setting autoDiscardable:false (Chrome 54+) stops the browser from discarding a collector tab when memory is low. Tab has boolean fields frozen (Chrome 132+), discarded and autoDiscardable.

Source: https://developer.chrome.com/docs/extensions/reference/api/tabs · confidence: verified-official-doc

### chrome.tabs.onUpdated passes (tabId, changeInfo, tab). changeInfo.status is a TabStatus: 'unloaded' | 'loading' | 'complete'. **(load-bearing)**

changeInfo fields: status?, url?, groupId?, splitViewId? (Chrome 140), pinned?, audible?, frozen? (Chrome 132), discarded?, autoDiscardable?, mutedInfo?, plus others. Wait for completion with: if (id === tabId && info.status === 'complete') {...}. Tab.url, title and favIconUrl are only present with the 'tabs' permission or host permission for the page, so host_permissions for chatgpt.com and claude.ai are enough to read tab.url for those tabs.

Source: https://developer.chrome.com/docs/extensions/reference/api/tabs · confidence: verified-official-doc

### chrome.windows.create accepts url (string or array), tabId, left, top, width, height, focused, incognito, type ('normal'|'popup'|'panel') and state ('normal'|'minimized'|'maximized'|'fullscreen'). The minimized, maximized and fullscreen states cannot be combined with left, top, width or height. **(load-bearing)**

Verbatim: 'The initial state of the window. The `minimized`, `maximized`, and `fullscreen` states cannot be combined with `left`, `top`, `width`, or `height`.' windows.update doc: focused 'If `true`, brings the window to the front; cannot be combined with the state 'minimized'.' Collector window: chrome.windows.create({ url: 'https://claude.ai/', state: 'minimized', focused: false, type: 'normal' }). Documented for windows.update; for windows.create, assume focused:true with state 'minimized' is invalid as well.

Source: https://developer.chrome.com/docs/extensions/reference/api/windows · confidence: verified-official-doc

### chrome.scripting.executeScript({target, func|files, args, world, injectImmediately}) returns Promise<InjectionResult[]>. world is 'ISOLATED' (default) or 'MAIN'. Requires the "scripting" permission plus host permission for the target page. **(load-bearing)**

Verbatim: 'By default, the script will be run at `document_idle`, or immediately if the page has already loaded... If the script evaluates to a promise, the browser will wait for the promise to settle and return the resulting value.' func is serialized, so bound variables are lost. args must be JSON-serializable. Exactly one of files or func. ExecutionWorld: 'ISOLATED' is unique to the extension; 'MAIN' is shared with the page's JavaScript (Chrome 95+). InjectionTarget: {tabId, frameIds?, documentIds?, allFrames?}. InjectionResult: {result, frameId, documentId}. Example: const [{result}] = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: () => document.title }).

Source: https://developer.chrome.com/docs/extensions/reference/api/scripting · confidence: verified-official-doc

### In MV3, host access goes in "host_permissions" as match patterns, separate from "permissions". It is requested at install, and the user can later restrict site access. **(load-bearing)**

Manifest snippet: "permissions": ["alarms","storage","scripting","tabs","notifications"], "host_permissions": ["https://chatgpt.com/*", "https://claude.ai/*", "https://<your-dashboard-domain>/*"]. A match pattern needs a path component, such as '/*'. Runtime-granted hosts go in "optional_host_permissions" and are requested with chrome.permissions.request.

Source: https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions · confidence: secondary-source

### Manifest content_scripts entries use "matches" (required), "js", "css", "run_at", "all_frames" and "world". run_at is 'document_start' | 'document_end' | 'document_idle', and the default is document_idle. **(load-bearing)**

RunAt doc: 'document_idle' is chosen by the browser between document_end and right after window.onload, and is guaranteed after the DOM is complete. Example: "content_scripts": [{ "matches": ["https://chatgpt.com/*", "https://claude.ai/*"], "js": ["content.js"], "run_at": "document_idle" }]. The same keys can be registered at runtime with scripting.registerContentScripts, using fields id, matches, js, runAt, allFrames, world and persistAcrossSessions (default true). A MAIN-world script is shared with the page, and the page can interfere with it.

Source: https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts · confidence: verified-official-doc

### ISOLATED-world content scripts can call chrome.runtime.sendMessage, runtime.connect, runtime.onMessage, runtime.getURL, runtime.id and runtime.getManifest, plus chrome.storage and chrome.i18n. Other extension APIs must go through messages. MAIN-world scripts have no direct chrome.* extension API access. **(load-bearing)**

For SPAs such as chatgpt.com and claude.ai, use a MutationObserver in the content script (standard DOM API), e.g. new MutationObserver(cb).observe(document.body, { childList: true, subtree: true }). Debounce, and forward results with chrome.runtime.sendMessage({type:'usage', data}). Use chrome.tabs.sendMessage(tabId, msg) to reach content scripts, because runtime.sendMessage cannot. Messages are JSON-serialized by default.

Source: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts ; https://developer.chrome.com/docs/extensions/develop/concepts/messaging · confidence: secondary-source

### runtime.onMessage listener signature is (message, sender, sendResponse) => boolean | Promise<any> | undefined. To reply asynchronously, return true and call sendResponse later. Returning a Promise directly is supported only in recent Chrome.

The IDL type is 'events.Event<(message, sender, sendResponse) => (boolean | Promise<any>) | undefined>'. According to the 'Transition to browser namespace' page, Chrome 148 shipped both the browser.* namespace and promise-returning onMessage listeners. Another search extract said 146, so the exact version is unclear. For portability, use `return true` + sendResponse.

Source: https://developer.chrome.com/docs/extensions/reference/api/runtime ; https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace · confidence: secondary-source

### fetch() from the extension service worker can reach remote servers without CORS headers from the server, as long as the host is in host_permissions. Content scripts are always subject to CORS as the page's origin, even with host permissions. **(load-bearing)**

Official text (search extract): 'Each running extension exists within its own separate security origin. A script executing in an extension service worker or foreground tab can talk to remote servers outside of its origin, as long as the extension requests host permissions.' Also: 'Content scripts initiate requests on behalf of the web origin that the content script has been injected into and therefore content scripts are also subject to the same origin policy.' Recommended pattern: the content script sends data to the service worker, which calls fetch('https://<dashboard>/api/ingest', {method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer <token>'}, body}). If the host is not in host_permissions, the server must answer CORS for Origin chrome-extension://<id>. Whether the Origin header is sent was not verified.

Source: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests · confidence: secondary-source

### chrome.storage quotas: local is 10485760 bytes (10 MB), or unlimited with the "unlimitedStorage" permission. session is 10485760 bytes, held in memory only, and by default only extension pages and the service worker can access it. sync is 102400 bytes total, 8192 per item, 512 items, 120 writes per minute and 1800 per hour. **(load-bearing)**

Constants: chrome.storage.local.QUOTA_BYTES = 10485760. chrome.storage.session.QUOTA_BYTES = 10485760 ('stored in-memory and will not be persisted to disk', Chrome 102+, MV3). Content scripts can read storage.session only after setAccessLevel({accessLevel:'TRUSTED_AND_UNTRUSTED_CONTEXTS'}). Exceeding a quota rejects the promise or sets runtime.lastError. Permission: "storage". Other APIs: getKeys() and onChanged(changes, areaName).

Source: https://developer.chrome.com/docs/extensions/reference/api/storage · confidence: verified-official-doc

### chrome.action badge API: setBadgeText({text, tabId?}), setBadgeBackgroundColor({color, tabId?}) and setBadgeTextColor (Chrome 110+).

Doc: text 'Any number of characters can be passed, but only about four can fit in the space. If an empty string ('') is passed, the badge text is cleared.' color is an RGBA array [255,0,0,255] or a CSS string '#F00'. Requires the "action" key in the manifest; chrome.action has no permission of its own. Example: await chrome.action.setBadgeText({ text: '42%' }); await chrome.action.setBadgeBackgroundColor({ color: '#d33' }).

Source: https://developer.chrome.com/docs/extensions/reference/api/action · confidence: verified-official-doc

### chrome.notifications.create(id?, options) returns Promise<string>. It requires the "notifications" permission, and type, iconUrl, title and message are required.

TemplateType: 'basic' | 'image' | 'list' | 'progress'. iconUrl may be a data URL, blob URL, or path inside the extension package. Options: requireInteraction (Chrome 50+), silent (Chrome 70+), buttons (at most 2), priority from -2 to 2 (-2 and -1 raise an error on Windows, Linux and Mac), eventTime, progress 0-100. The id may be at most 500 characters, and reusing an id replaces that notification. Events: onClicked, onButtonClicked, onClosed. Example: chrome.notifications.create('limit', { type:'basic', iconUrl:'icon128.png', title:'Claude usage', message:'80% of 5h limit used' }).

Source: https://developer.chrome.com/docs/extensions/reference/api/notifications · confidence: verified-official-doc

### To load unpacked: open chrome://extensions, turn on 'Developer mode', click 'Load unpacked' and choose the folder with manifest.json. Reload from the same page after code changes. **(load-bearing)**

The service worker shows as 'service worker (inactive)' after about 30 seconds idle. Opening its DevTools keeps it alive, which hides lifetime bugs. Since Chrome 137, branded Chrome no longer supports loading extensions with the --load-extension command-line flag; it still works in Chromium and Chrome for Testing. The 'Load unpacked' UI is not affected.

Source: https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world ; https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ · confidence: secondary-source

### An unpacked extension's ID comes from its folder path and changes if it is loaded from a different directory. Adding a "key" (public key) to manifest.json pins the ID. **(load-bearing)**

Docs: 'The ID of an unpacked extension will change if the extension is loaded from a different directory; the ID will change again when the extension is packaged.' Example: "key": "MIIBIjANBgkqh...<base64 SPKI public key>". Ways to get a key: pack the extension once and copy the "key" from <profile>/Extensions/<id>/<ver>/manifest.json, or generate an RSA key pair with openssl and base64-encode the DER public key (the second method is from memory, not the page). A stable ID matters if the dashboard allowlists Origin chrome-extension://<id> for CORS, or uses externally_connectable.

Source: https://developer.chrome.com/docs/extensions/reference/manifest/key · confidence: secondary-source

### MV3 blocks remote code execution in extension pages and the service worker. The CSP floor is "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';". script-src, object-src and worker-src may only contain 'self', 'none' and 'wasm-unsafe-eval', plus any localhost source for unpacked extensions only. **(load-bearing)**

The manifest key is a dictionary: "content_security_policy": { "extension_pages": "...", "sandbox": "..." }. Not allowed: eval or new Function on fetched strings, and <script src> pointing outside the package. Fetching JSON data at runtime is fine. eval-like code can run only in a sandboxed page ("sandbox" manifest key). WebAssembly needs 'wasm-unsafe-eval' declared explicitly. The Web Store remote-code policy does not apply to a private unpacked extension, but the CSP is enforced by the browser regardless: bundle all JS, e.g. with Vite or esbuild.

Source: https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy ; https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code · confidence: secondary-source

### Background or minimized collector tabs are subject to page throttling. Chained timers in pages hidden for more than 5 minutes run about once a minute (Chrome 88+). With Energy Saver on, CPU-intensive hidden tabs can be frozen (Chrome 133+). Tabs can also be discarded.

Intensive throttling applies when the page has been hidden more than 5 minutes, silent at least 30 seconds, WebRTC is not in use, and the timer chain count is 5 or more. Energy Saver freezing applies after more than 5 minutes hidden and silent, and a frozen tab unfreezes on activation. Mitigations: drive collection from chrome.alarms in the service worker, tabs.update({autoDiscardable:false}), and check tab.frozen / tab.discarded. Whether a tab in a minimized window reports visibilityState 'hidden' was not verified; it is likely on most platforms.

Source: https://developer.chrome.com/blog/timer-throttling-in-chrome-88 ; https://developer.chrome.com/blog/freezing-on-energy-saver · confidence: secondary-source

### Structured-clone messaging is opt-in from Chrome 148 through the manifest key "message_serialization": "structured_clone". JSON remains the default.

With it enabled, Date, Set, BigInt, Error, NaN and Infinity survive runtime.sendMessage. toJSON() is ignored under structured clone.

Source: https://developer.chrome.com/blog/structured-clone-messaging · confidence: secondary-source
