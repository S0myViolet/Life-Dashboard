/**
 * Toolbar badge: one glance tells the owner whether the helper is working.
 * The most important problem wins.
 */
export interface BadgeInput {
  paired: boolean
  authFailed: boolean
  pausedAll: boolean
  /** Selected conversations whose capture state needs the owner (signed out, challenge, structure). */
  attention: number
  queued: number
  revisitCollecting: boolean
}

export interface Badge {
  text: string
  color: string
  title: string
}

const RED = '#a8412f'
const AMBER = '#9a6a12'
const BLUE = '#3a6b8a'
const GREY = '#5c6670'

export function computeBadge(s: BadgeInput): Badge {
  if (!s.paired) return { text: '!', color: GREY, title: 'Not paired: open the options page to pair with your dashboard.' }
  if (s.authFailed) {
    return { text: '!', color: RED, title: 'The dashboard no longer accepts this browser (revoked?). Pair again.' }
  }
  if (s.pausedAll) return { text: 'OFF', color: GREY, title: 'Paused: nothing is being collected.' }
  if (s.attention > 0) {
    return {
      text: '!',
      color: RED,
      title: `${s.attention} conversation(s) need attention (signed out, verification check or page changed).`,
    }
  }
  if (s.queued > 0) {
    const n = s.queued > 99 ? '99+' : String(s.queued)
    return { text: n, color: AMBER, title: `${s.queued} capture(s) waiting to upload (offline or dashboard unreachable).` }
  }
  if (s.revisitCollecting) return { text: 'REV', color: BLUE, title: 'Background revisit tab open (prototype).' }
  return { text: '', color: BLUE, title: 'Personal Home capture: collecting selected conversations.' }
}
