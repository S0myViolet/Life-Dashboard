/**
 * Content-script runtime shared by both providers.
 *
 * PASSIVE by design: it only reads the DOM the owner's own page renders, and
 * only on conversations the owner selected (the service worker answers
 * 'ph:hello'). It never scrolls, clicks, calls the apps' internal APIs, or reads
 * cookies or storage. While the page keeps changing (the owner scrolling a
 * virtualised thread, a reply streaming) it is read at least every
 * readWhileChangingMs, so windows that mount and unmount before the page
 * settles are still accumulated; uploads to the service worker wait until the
 * page has been quiet for the settle delay, except when the owner leaves the
 * conversation, hides the tab or leaves the page: then what the visit
 * collected is sent at once.
 */
import {
  captureParseConversationUrl,
  type CaptureConversationRef,
  type CaptureMode,
  type CaptureProblemState,
  type CaptureProvider,
} from '@personal-home/core'
import type { ContentNotice, ContentRequest, HelloResponse, ObservationResponse } from '../shared/protocol.ts'
import { isLoginPath } from '../shared/revisit.ts'
import { CaptureAccumulator } from './accumulator.ts'
import type { PageExtract } from './extract.ts'

export const RUNTIME_TIMING = {
  /**
   * While the DOM keeps changing, read it at least this often (merged into the
   * accumulator, not uploaded). Both apps unmount turns that scroll out of view,
   * so waiting for the page to settle would lose every window passed on the way.
   */
  readWhileChangingMs: 250,
  /**
   * A read waits at least this long after a DOM change, so an app that renders
   * the next conversation before it changes the URL is noticed (the URL no
   * longer matches) instead of being read into the current one.
   */
  readDelayMs: 50,
  /** Quiet period after the last DOM change before reading the page and uploading. */
  settlePassiveMs: 1500,
  /** Revisit tabs load in the background; give them longer to finish rendering. */
  settleRevisitMs: 4000,
  /** No recognisable thread for this long on a conversation URL → structure_changed. */
  structureGraceMs: 30_000,
  /** While a reply is streaming, re-check this often. */
  streamingRecheckMs: 5000,
  /** Upload anyway after this long (streaming messages are flagged and ignored by the server). */
  maxStreamingWaitMs: 60_000,
  locationPollMs: 1000,
} as const

export interface RuntimeDeps {
  provider: CaptureProvider
  extract: (doc: Document) => PageExtract
  send: (message: ContentRequest) => Promise<unknown>
  onNotice: (listener: (notice: ContentNotice) => void) => void
  doc: Document
  win: Window
  now: () => number
  newId: () => string
}

interface Session {
  ref: CaptureConversationRef
  url: string
  acc: CaptureAccumulator
  collect: boolean
  mode: CaptureMode
  startedAt: number
  firstUnsentAt: number | null
  stopped: boolean
}

export interface CaptureRuntime {
  /** Read the page now (tests; also used by timers). */
  tick(): Promise<void>
  checkLocation(): Promise<void>
  stop(): void
  readonly session: Readonly<Session> | null
}

export function startCaptureRuntime(deps: RuntimeDeps): CaptureRuntime {
  const { doc, win } = deps
  let session: Session | null = null
  let dead = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let followUpTimer: ReturnType<typeof setTimeout> | undefined
  let readTimer: ReturnType<typeof setTimeout> | undefined
  let lastReadAt = Number.NEGATIVE_INFINITY
  let observer: MutationObserver | null = null

  const send = async <T>(message: ContentRequest): Promise<T | null> => {
    if (dead) return null
    try {
      return (await deps.send(message)) as T
    } catch {
      // The extension was reloaded or removed: this page's script is orphaned.
      stop()
      return null
    }
  }

  const schedule = (delay?: number) => {
    if (!session?.collect || session.stopped || dead) return
    clearTimeout(settleTimer)
    const wait = delay ?? (session.mode === 'revisit' ? RUNTIME_TIMING.settleRevisitMs : RUNTIME_TIMING.settlePassiveMs)
    settleTimer = setTimeout(() => void tick(), wait)
  }

  const followUp = (delay: number) => {
    clearTimeout(followUpTimer)
    followUpTimer = setTimeout(() => void tick(), delay)
  }

  /**
   * Read what is mounted now and merge it into the session's accumulator (no
   * upload). Returns null, reading nothing, when the URL has moved on to
   * another conversation: the DOM may already show that one.
   */
  const read = (s: Session): PageExtract | null => {
    if (win.location.href !== s.url) {
      void checkLocation() // same conversation: updates s.url at once; another one: switches session
      if (session !== s || win.location.href !== s.url) return null
    }
    lastReadAt = deps.now()
    clearTimeout(readTimer)
    readTimer = undefined
    const extract = deps.extract(doc)
    if (extract.status === 'ok') s.acc.observe(extract)
    return extract
  }

  /** On a DOM change: read shortly, and at least every readWhileChangingMs while changes continue. */
  const readSoon = () => {
    const s = session
    if (!s?.collect || s.stopped || dead || readTimer !== undefined) return
    const wait = Math.max(RUNTIME_TIMING.readDelayMs, lastReadAt + RUNTIME_TIMING.readWhileChangingMs - deps.now())
    readTimer = setTimeout(() => {
      readTimer = undefined
      if (session === s && s.collect && !s.stopped && !dead) read(s)
    }, wait)
  }

  /** Hand what the visit collected and has not sent yet to the service worker. */
  const upload = async (s: Session): Promise<void> => {
    if (!s.acc.hasUnsent) return
    const version = s.acc.changes
    const observation = s.acc.toObservation(new Date(deps.now()))
    if (!observation) return
    const res = await send<ObservationResponse>({ type: 'ph:observation', observation })
    if (res?.accepted) {
      s.acc.markSent(version)
      if (session === s) s.firstUnsentAt = null
    }
  }

  /**
   * The tab is being hidden or the page left: send now instead of waiting for
   * the page to settle or a reply to finish (streaming messages stay flagged
   * and the server ignores them).
   */
  const flushNow = () => {
    const s = session
    if (!s || !s.collect || s.stopped || dead) return
    read(s)
    void upload(s)
  }

  const reportProblem = async (s: Session, state: CaptureProblemState) => {
    s.stopped = true
    await send({ type: 'ph:problem', url: s.url, state })
  }

  const hello = async (s: Session) => {
    const res = await send<HelloResponse>({ type: 'ph:hello', url: s.url })
    if (session !== s || !res) return
    const wasCollecting = s.collect
    s.collect = res.collect === true
    s.mode = res.mode === 'revisit' ? 'revisit' : 'passive'
    if (s.collect && !wasCollecting) {
      s.startedAt = deps.now()
      ensureObserver()
      schedule(0)
      followUp(RUNTIME_TIMING.structureGraceMs + 250)
    }
  }

  const ensureObserver = () => {
    if (observer || dead) return
    const Observer = (win as Window & typeof globalThis).MutationObserver ?? MutationObserver
    observer = new Observer(() => {
      void checkLocation()
      readSoon()
      schedule()
    })
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-is-streaming', 'data-message-id', 'data-index', 'data-testid', 'aria-label'],
    })
  }

  async function checkLocation(): Promise<void> {
    if (dead) return
    const href = win.location.href
    if (session && session.url === href) return
    const ref = captureParseConversationUrl(href)
    const previous = session
    if (previous && ref && previous.ref.provider === ref.provider && previous.ref.externalId === ref.externalId) {
      previous.url = href // same conversation, different URL shape (e.g. moved into a project)
      return
    }
    if (previous && previous.collect && !previous.stopped) {
      // Leaving a collected conversation (another chat, or a sign-in page).
      // Send what this visit collected but had not sent yet: the page may not
      // have settled, or a reply may still be streaming (those messages stay
      // flagged). The DOM may already show the next page, so it is not read.
      previous.stopped = true
      const signedOut = !ref && isLoginPath(deps.provider, new URL(href).pathname)
      const leaving = upload(previous).then(() =>
        signedOut ? reportProblem(previous, 'signed_out') : undefined,
      )
      if (signedOut) await leaving
    }
    clearTimeout(settleTimer)
    clearTimeout(followUpTimer)
    clearTimeout(readTimer)
    readTimer = undefined
    if (!ref || ref.provider !== deps.provider) {
      session = null
      return
    }
    const next: Session = {
      ref,
      url: href,
      acc: new CaptureAccumulator(href, deps.newId()),
      collect: false,
      mode: 'passive',
      startedAt: deps.now(),
      firstUnsentAt: null,
      stopped: false,
    }
    session = next
    await hello(next)
  }

  async function tick(): Promise<void> {
    const s = session
    if (!s || !s.collect || s.stopped || dead) return
    const extract = read(s)
    if (!extract) return
    const now = deps.now()

    if (extract.status === 'signed_out' || extract.status === 'challenge') {
      // Stop at once; never interact with a sign-in page or a verification check.
      await reportProblem(s, extract.status)
      return
    }
    if (extract.status === 'loading' || extract.status === 'structure_changed') {
      if (s.acc.size === 0) {
        if (now - s.startedAt >= RUNTIME_TIMING.structureGraceMs) {
          await reportProblem(s, 'structure_changed')
        } else {
          followUp(RUNTIME_TIMING.structureGraceMs - (now - s.startedAt) + 250)
        }
      }
      return
    }

    if (!s.acc.hasUnsent) return
    s.firstUnsentAt ??= now
    if (s.acc.isStreaming && now - s.firstUnsentAt < RUNTIME_TIMING.maxStreamingWaitMs) {
      followUp(RUNTIME_TIMING.streamingRecheckMs)
      return
    }
    await upload(s)
  }

  function stop() {
    dead = true
    clearTimeout(settleTimer)
    clearTimeout(followUpTimer)
    clearTimeout(readTimer)
    clearInterval(poll)
    win.removeEventListener('pagehide', flushNow)
    observer?.disconnect()
    observer = null
  }

  deps.onNotice((notice) => {
    if (notice.type === 'ph:recheck' && session && !session.stopped) void hello(session)
  })
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') flushNow()
    else if (doc.visibilityState === 'visible' && session && !session.collect && !session.stopped) void hello(session)
  })
  win.addEventListener('pagehide', flushNow)
  const poll = setInterval(() => void checkLocation(), RUNTIME_TIMING.locationPollMs)
  void checkLocation()

  return {
    tick,
    checkLocation,
    stop,
    get session() {
      return session
    },
  }
}

/** Wires the runtime to the real extension APIs (content-script context). */
export function startInPage(provider: CaptureProvider, extract: (doc: Document) => PageExtract): void {
  const flag = '__personalHomeCapture'
  const w = window as unknown as Record<string, unknown>
  if (w[flag]) return
  w[flag] = true
  startCaptureRuntime({
    provider,
    extract,
    send: (message) => chrome.runtime.sendMessage(message),
    onNotice: (listener) =>
      chrome.runtime.onMessage.addListener((message: unknown, sender) => {
        if (sender.id !== chrome.runtime.id) return
        if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'ph:recheck') {
          listener({ type: 'ph:recheck' })
        }
      }),
    doc: document,
    win: window,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  })
}
