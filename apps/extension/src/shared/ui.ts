/**
 * Small helpers for the popup and options pages. Text is always set with
 * textContent (never innerHTML), because titles and URLs come from web pages.
 */
import type { HelperStateView, PageRequest } from './protocol.ts'

export function sendToWorker<T = HelperStateView>(request: PageRequest): Promise<T> {
  return chrome.runtime.sendMessage(request) as Promise<T>
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; title?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (props.className) el.className = props.className
  if (props.text !== undefined) el.textContent = props.text
  if (props.title) el.title = props.title
  for (const c of children) el.append(c)
  return el
}

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function relativeTime(at: number | null, now = Date.now()): string {
  if (at === null) return 'never'
  const s = Math.round((at - now) / 1000)
  const abs = Math.abs(s)
  if (abs < 45) return s <= 0 ? 'just now' : 'in a moment'
  if (abs < 3600) return RTF.format(Math.round(s / 60), 'minute')
  if (abs < 86_400) return RTF.format(Math.round(s / 3600), 'hour')
  return RTF.format(Math.round(s / 86_400), 'day')
}

export const PROVIDER_LABEL = { chatgpt: 'ChatGPT', claude: 'Claude' } as const
