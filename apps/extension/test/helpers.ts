import { JSDOM } from 'jsdom'

export const CHAT_ID = '0b6a1f5e-9a3c-4c1e-8f2d-3a4b5c6d7e8f'
export const CHAT_URL = `https://chatgpt.com/c/${CHAT_ID}`
export const CLAUDE_ID = '5d1c0e2f-7b8a-4c3d-9e0f-1a2b3c4d5e6f'
export const CLAUDE_URL = `https://claude.ai/chat/${CLAUDE_ID}`

/** A standalone jsdom window at `url` with `html` as the body. */
export function pageWindow(html: string, url: string, title = ''): JSDOM['window'] {
  const dom = new JSDOM(`<!doctype html><html><head><title>${title}</title></head><body>${html}</body></html>`, {
    url,
  })
  return dom.window
}

export function pageDocument(html: string, url: string, title = ''): Document {
  return pageWindow(html, url, title).document
}

/** Replace the body (simulates the app re-rendering its virtualised window). */
export function rerender(doc: Document, html: string): void {
  doc.body.innerHTML = html
}
