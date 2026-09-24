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
 * page has been quiet for the settle delay.
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

  /** Read what is mounted now and merge it into the session's accumulator (no upload). */
  const read = (s: Session): PageExtract => {
    lastReadAt = deps.now()
    clearTimeout(readTimer)
    readTimer = undefined
    const extract = deps.extract(doc)
    if (extract.status === 'ok') s.acc.observe(extract)
    return extract
  }

  /** On a DOM change: read now, or at the end of the current readWhileChangingMs interval. */
  const readSoon = () => {
    const s = session
    if (!s?.collect || s.stopped || dead) return
    const wait = lastReadAt + RUNTIME_TIMING.readWhileChangingMs - deps.now()
    if (wait <= 0) {
      read(s)
    } else if (readTimer === undefined) {
      readTimer = setTimeout(() => {
        readTimer = undefined
        if (session === s && s.collect && !s.stopped && !dead) read(s)
      }, wait)
    }
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
    if (previous && !ref && previous.collect && !previous.stopped) {
      const path = new URL(href).pathname
      if (isLoginPath(deps.provider, path)) await reportProblem(previous, 'signed_out')
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
    const observation = s.acc.toObservation(new Date(now))
    if (!observation) return
    const res = await send<ObservationResponse>({ type: 'ph:observation', observation })
    if (res?.accepted && session === s) {
      s.acc.markSent()
      s.firstUnsentAt = null
    }
  }

  function stop() {
    dead = true
    clearTimeout(settleTimer)
    clearTimeout(followUpTimer)
    clearTimeout(readTimer)
    clearInterval(poll)
    observer?.disconnect()
    observer = null
  }

  deps.onNotice((notice) => {
    if (notice.type === 'ph:recheck' && session && !session.stopped) void hello(session)
  })
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible' && session && !session.collect && !session.stopped) void hello(session)
  })
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
