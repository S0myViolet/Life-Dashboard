/**
 * Full-text search helpers for notes (and journal entries). Postgres does the searching with the
 * generated `search` tsvector ('simple' configuration); this module builds a safe query string and
 * turns highlighted snippets into plain segments the UI renders without HTML injection.
 */

export const NOTES_SEARCH_MAX_TERMS = 8
export const NOTES_SEARCH_MAX_TERM_LENGTH = 64
export const NOTES_SEARCH_MAX_INPUT = 200

/**
 * Highlight delimiters for ts_headline. Private-use code points: the snippet source is stripped of
 * them first, so the only occurrences in a snippet are the ones Postgres inserted.
 */
export const NOTES_HIGHLIGHT_START = ''
export const NOTES_HIGHLIGHT_STOP = ''

/**
 * Turn what the owner typed into a to_tsquery('simple', …) string: every word becomes a prefix
 * term and all terms must match ("meet not" finds "meeting notes"). Only letters and digits
 * survive, so the result can never contain tsquery operators or quotes. Returns null when there
 * is nothing to search for.
 */
export function notesSearchTsQuery(input: string): string | null {
  if (typeof input !== 'string') return null
  const words = input
    .slice(0, NOTES_SEARCH_MAX_INPUT)
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
  if (!words) return null
  const terms = [...new Set(words.map((w) => w.slice(0, NOTES_SEARCH_MAX_TERM_LENGTH)))].slice(
    0,
    NOTES_SEARCH_MAX_TERMS,
  )
  return terms.length === 0 ? null : terms.map((t) => `'${t}':*`).join(' & ')
}

export interface NotesHighlightSegment {
  text: string
  match: boolean
}

/** Split a ts_headline result into plain text segments. Unbalanced markers are tolerated. */
export function notesHighlightSegments(snippet: string | null | undefined): NotesHighlightSegment[] {
  if (!snippet) return []
  const out: NotesHighlightSegment[] = []
  let match = false
  let buf = ''
  const push = () => {
    if (buf === '') return
    const last = out[out.length - 1]
    if (last && last.match === match) last.text += buf
    else out.push({ text: buf, match })
    buf = ''
  }
  for (const ch of snippet) {
    if (ch === NOTES_HIGHLIGHT_START) {
      push()
      match = true
    } else if (ch === NOTES_HIGHLIGHT_STOP) {
      push()
      match = false
    } else {
      buf += ch
    }
  }
  push()
  return out
}
