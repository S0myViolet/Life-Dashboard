/**
 * Rendered text of a message element, independent of CSS layout (so it behaves
 * the same in Chrome and in jsdom tests): block elements become line breaks;
 * controls, icons, screen-reader-only labels and hidden subtrees are skipped.
 * The server normalizes whitespace again before hashing.
 */

const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR',
  'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'THEAD', 'TFOOT',
  'TR', 'UL',
])

const SKIP_TAGS = new Set([
  'BUTTON', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS',
  'INPUT', 'TEXTAREA', 'SELECT', 'IFRAME', 'OBJECT',
])

function skipped(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true
  if (el.hasAttribute('hidden')) return true
  if (el.getAttribute('aria-hidden') === 'true') return true
  if (el.classList.contains('sr-only')) return true
  const style = (el as HTMLElement).style
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return true
  return false
}

export function renderedText(root: Element): string {
  const parts: string[] = []
  const newline = () => {
    if (parts.length > 0 && parts[parts.length - 1] !== '\n') parts.push('\n')
  }
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue ?? '')
      return
    }
    if (node.nodeType !== 1) return
    const el = node as Element
    if (el !== root && skipped(el)) return
    if (el.tagName === 'BR') {
      parts.push('\n')
      return
    }
    const block = BLOCK.has(el.tagName)
    if (block) newline()
    if (el.tagName === 'TD' || el.tagName === 'TH') {
      if (el.previousElementSibling) parts.push('\t')
    }
    for (const child of Array.from(el.childNodes)) walk(child)
    if (block) newline()
  }
  walk(root)
  return parts
    .join('')
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The outermost elements matching `selector` inside `root` (no element nested in another match). */
export function outermost(root: Element | Document, selector: string): Element[] {
  return Array.from(root.querySelectorAll(selector)).filter((el) => {
    const ancestor = el.parentElement?.closest(selector)
    return !ancestor || ancestor === root || !root.contains(ancestor)
  })
}
