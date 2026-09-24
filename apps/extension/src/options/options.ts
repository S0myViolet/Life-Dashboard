/**
 * Options page: dashboard address + pairing code entry.
 *
 * The dashboard's host permission is optional and requested here, inside the
 * submit handler (a user gesture), before the service worker redeems the code.
 */
import { normalizeDashboardOrigin, originPermissionPattern } from '../shared/api.ts'
import type { HelperStateView, PairResult } from '../shared/protocol.ts'
import { byId, relativeTime, sendToWorker } from '../shared/ui.ts'

function defaultDeviceName(): string {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  return platform ? `Chrome on ${platform}` : 'Chrome on this computer'
}

function render(s: HelperStateView) {
  const status = byId('status')
  const link = byId<HTMLAnchorElement>('dashboard-link')
  const unpair = byId<HTMLButtonElement>('unpair')
  status.className = ''
  if (!s.paired) {
    status.textContent = 'Not paired yet.'
    link.hidden = true
    unpair.hidden = true
    return
  }
  status.textContent = `Paired with ${s.apiOrigin} as “${s.deviceName}” ${relativeTime(s.pairedAt)}.`
  if (s.authFailed) {
    status.textContent += ' The dashboard no longer accepts this browser: pair again below.'
    status.className = 'problem'
  }
  const target = s.dashboardOrigin ?? s.apiOrigin
  if (target) {
    link.href = new URL('/settings/chrome-helper', target).toString()
    link.hidden = false
  }
  unpair.hidden = false
  const origin = byId<HTMLInputElement>('origin')
  if (!origin.value && s.apiOrigin) origin.value = s.apiOrigin
  const device = byId<HTMLInputElement>('device')
  if (s.deviceName) device.value = s.deviceName
}

async function init() {
  const device = byId<HTMLInputElement>('device')
  device.value = defaultDeviceName()
  render(await sendToWorker({ type: 'ph:get-state' }))

  byId('unpair').addEventListener('click', async () => {
    if (!window.confirm('Unpair this browser? Its token and any queued captures are deleted here.')) return
    const s = await sendToWorker({ type: 'ph:unpair' })
    render(s)
  })

  byId<HTMLFormElement>('pair-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const result = byId('pair-result')
    const button = byId<HTMLButtonElement>('pair-button')
    result.className = ''
    const origin = normalizeDashboardOrigin(byId<HTMLInputElement>('origin').value)
    if (!origin) {
      result.textContent = 'Enter the dashboard address, for example https://home.example.com.'
      result.className = 'problem'
      return
    }
    // Must run in the click/submit gesture, before any other await.
    let granted = false
    try {
      granted = await chrome.permissions.request({ origins: [originPermissionPattern(origin)] })
    } catch {
      granted = false
    }
    if (!granted) {
      result.textContent = 'Chrome did not grant access to the dashboard address, so pairing cannot continue.'
      result.className = 'problem'
      return
    }
    button.disabled = true
    result.textContent = 'Pairing…'
    try {
      const res = await sendToWorker<PairResult>({
        type: 'ph:pair',
        apiOrigin: origin,
        code: byId<HTMLInputElement>('code').value,
        deviceName: byId<HTMLInputElement>('device').value,
      })
      if (res.ok) {
        result.textContent = 'Paired. Conversations you select on the dashboard are now collected while open.'
        result.className = 'ok'
        byId<HTMLInputElement>('code').value = ''
        render(res.state)
      } else {
        result.textContent = res.message
        result.className = 'problem'
      }
    } finally {
      button.disabled = false
    }
  })
}

void init()
