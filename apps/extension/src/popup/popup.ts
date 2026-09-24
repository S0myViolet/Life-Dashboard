/**
 * Toolbar popup: pairing status, the current tab ("Track this conversation"
 * opens the dashboard's attach page, where the owner confirms with their own
 * session; the helper's token cannot select conversations), what is being
 * collected, Pause all, and the opt-in revisit prototype with its terms note.
 */
import { captureParseConversationUrl } from '@personal-home/core'
import type { HelperStateView } from '../shared/protocol.ts'
import { byId, h, PROVIDER_LABEL, relativeTime, sendToWorker } from '../shared/ui.ts'

let state: HelperStateView | null = null
let currentUrl: string | null = null

function renderPairing(s: HelperStateView) {
  const status = byId('pairing-status')
  status.className = ''
  if (!s.paired) {
    status.textContent = 'Not paired. Open Options and enter a pairing code from Settings → Chrome helper.'
    status.className = 'warn'
  } else if (s.authFailed) {
    status.textContent = 'The dashboard no longer accepts this browser. Pair again in Options.'
    status.className = 'problem'
  } else {
    status.textContent = `Paired with ${s.apiOrigin} as “${s.deviceName}”. Selection synced ${relativeTime(s.selectionSyncedAt)}.`
    if (s.selectionError) {
      status.append(h('span', { className: 'warn', text: ` Last sync failed (${s.selectionError}).` }))
    }
  }
  const queue = byId('queue-status')
  queue.textContent =
    s.queued > 0
      ? `${s.queued} capture(s) waiting to upload; next try ${relativeTime(s.nextRetryAt)}.`
      : 'Nothing waiting to upload.'
}

function renderCurrent(s: HelperStateView) {
  const status = byId('current-status')
  const button = byId<HTMLButtonElement>('track')
  button.hidden = true
  const ref = currentUrl ? captureParseConversationUrl(currentUrl) : null
  if (!ref) {
    status.textContent = 'Open a ChatGPT or Claude conversation to track it.'
    return
  }
  const selected = s.conversations.find((c) => c.provider === ref.provider && c.externalId === ref.externalId)
  if (selected) {
    status.textContent = `${PROVIDER_LABEL[ref.provider]} conversation: collected while it is open. Last upload ${relativeTime(selected.lastUploadAt)}.`
    return
  }
  status.textContent = `${PROVIDER_LABEL[ref.provider]} conversation: not tracked. Tracking opens your dashboard to confirm and choose a project.`
  button.hidden = !s.paired || s.authFailed
}

function renderConversations(s: HelperStateView) {
  byId<HTMLInputElement>('paused-all').checked = s.pausedAll
  const list = byId('conversations')
  list.replaceChildren()
  if (s.pausedAll) list.append(h('li', { className: 'warn', text: 'Paused: nothing is collected.' }))
  if (s.conversations.length === 0) {
    list.append(h('li', { className: 'muted', text: 'No conversations selected yet.' }))
    return
  }
  for (const c of s.conversations) {
    const label = `${PROVIDER_LABEL[c.provider]} · ${c.externalId.slice(0, 8)}`
    const detail =
      c.captureState !== 'active'
        ? h('span', { className: 'problem', text: c.lastResult ?? c.captureState })
        : h('span', { className: 'muted', text: c.lastUploadAt ? `uploaded ${relativeTime(c.lastUploadAt)}` : 'not captured yet' })
    list.append(h('li', {}, [h('div', { className: 'row' }, [h('span', { text: label }), detail])]))
  }
}

function renderRevisit(s: HelperStateView) {
  const toggle = byId<HTMLButtonElement>('revisit-toggle')
  const ack = byId<HTMLInputElement>('revisit-ack')
  const status = byId('revisit-status')
  toggle.textContent = s.revisit.enabled ? 'Turn off' : 'Turn on'
  toggle.className = s.revisit.enabled ? '' : 'primary'
  ack.checked = s.revisit.enabled || ack.checked
  ack.disabled = s.revisit.enabled
  toggle.disabled = !s.paired || s.authFailed || (!s.revisit.enabled && !ack.checked)
  const open = s.revisit.collectors.length
  status.textContent = s.revisit.enabled
    ? `On. ${open} tab(s) open, ${s.revisit.queued} queued.`
    : 'Off (default).'
  const blocked = byId('revisit-blocked')
  blocked.replaceChildren()
  for (const provider of ['chatgpt', 'claude'] as const) {
    const b = s.revisit.blocked[provider]
    if (!b) continue
    const resume = h('button', { text: 'Resume' })
    resume.type = 'button'
    resume.addEventListener('click', () => void act({ type: 'ph:resume-revisits', provider }))
    blocked.append(
      h('li', {}, [
        h('div', { className: 'row' }, [
          h('span', {
            className: 'problem',
            text: `${PROVIDER_LABEL[provider]} stopped ${relativeTime(b.at)} (${b.reason.replace('_', ' ')}). Sign in yourself first.`,
          }),
          resume,
        ]),
      ]),
    )
  }
}

function renderLog(s: HelperStateView) {
  const list = byId('log')
  list.replaceChildren()
  if (s.log.length === 0) list.append(h('li', { className: 'muted', text: 'Nothing yet.' }))
  for (const entry of s.log.slice(0, 12)) {
    const cls = entry.kind === 'problem' ? 'problem' : entry.kind === 'warning' ? 'warn' : ''
    list.append(h('li', { className: cls, text: `${relativeTime(entry.at)} — ${entry.text}` }))
  }
}

function render() {
  if (!state) return
  byId('version').textContent = `v${state.extensionVersion}`
  renderPairing(state)
  renderCurrent(state)
  renderConversations(state)
  renderRevisit(state)
  renderLog(state)
}

async function act(request: Parameters<typeof sendToWorker>[0]) {
  state = await sendToWorker(request)
  render()
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  currentUrl = tab?.url ?? null
  byId('open-options').addEventListener('click', () => void chrome.runtime.openOptionsPage())
  byId('sync-now').addEventListener('click', () => void act({ type: 'ph:sync-now' }))
  byId<HTMLInputElement>('paused-all').addEventListener('change', (e) => {
    void act({ type: 'ph:set-paused-all', paused: (e.target as HTMLInputElement).checked })
  })
  byId<HTMLInputElement>('revisit-ack').addEventListener('change', () => render())
  byId('revisit-toggle').addEventListener('click', () => {
    if (!state) return
    const enabling = !state.revisit.enabled
    void act({ type: 'ph:set-revisit', enabled: enabling, acknowledged: byId<HTMLInputElement>('revisit-ack').checked })
  })
  byId('track').addEventListener('click', async () => {
    if (!currentUrl) return
    await sendToWorker<{ ok: boolean }>({ type: 'ph:track', url: currentUrl })
    window.close()
  })
  state = await sendToWorker({ type: 'ph:get-state' })
  render()
}

void init()
