/**
 * Validation of model output before anything is stored or shown.
 *
 * Model output is treated as untrusted too: it may have been steered by injected evidence. So
 * after JSON parsing, and before the zod schema check:
 *   - every `citations` array keeps only evidence ids that were actually provided;
 *   - every URL-like string that is not one of the provided source links is replaced (in
 *     values, object keys and dropped citations), which closes the "render this link/image"
 *     exfiltration channel for scheme, `www.` and protocol-relative links. Rendering model text
 *     without Markdown/HTML image support remains the complementary defence.
 * Convention for callers: put evidence ids in arrays named `citations`.
 */
import { z } from 'zod'

export interface AiOutputContext {
  evidenceIds: readonly string[]
  allowedUrls: readonly string[]
}

export type AiOutputFailure = 'empty' | 'invalid_json' | 'schema_mismatch'

export type AiOutputResult<T> =
  | {
      ok: true
      value: T
      /** Citations removed because they referenced ids that were not provided (URLs removed, truncated). */
      droppedCitations: string[]
      /** Number of URLs removed from text. The URLs themselves are not kept (possible exfiltration). */
      strippedUrls: number
    }
  | { ok: false; error: AiOutputFailure; issues: string[] }

export const AI_REMOVED_LINK_TEXT = '[link removed]'

/*
 * URL detection is one left-to-right scan with bounded look-ahead (linear time, no backtracking
 * regex), so a long adversarial string cannot burn CPU. A URL starts at:
 *   - a known scheme and ':' (https:, data:, javascript:, mailto:, ...) or any `scheme://` or
 *     `scheme:\\` form;
 *   - `www.`;
 *   - two or more '/' or '\' that begin a token or follow punctuation (//host, \\host, /\host),
 *     whatever the host looks like (IDN, punycode, IP literal, no path);
 *   - a bare host (ASCII, IDN or punycode labels, IPv4, trailing-dot FQDN) followed by a port,
 *     a path ('/' or '\'), a query or a fragment.
 * A URL runs to the next ASCII space or control character, which is where a CommonMark link
 * destination ends, so text after a quote, backtick, '<' or ')' cannot ride along on an allowed
 * URL. Bare `name.ext/...` tokens whose last label is a common code or document file extension
 * (Next.js/Vercel, README.md#setup) are treated as prose: a schemeless link destination resolves
 * against the app's own origin and plain text is not linked, while the same names with a scheme,
 * `www.` or `//` are still removed. Some of those extensions are also country TLDs (md, py, rs,
 * sh); that bare-host gap is accepted for the same reason.
 */
const KNOWN_SCHEME_RE = /(?:https?|ftps?|file|data|javascript|vbscript|mailto|blob|wss?|sms|tel|intent):/iy
const GENERIC_SCHEME_RE = /[a-z][a-z0-9+.-]{0,31}:[\\/]{2}/iy
const WWW_RE = /www\./iy
const TLD_RE = /^(?:xn--[a-z0-9-]{1,59}|[\p{L}\p{M}]{2,63})$/iu
const IPV4_LABEL_RE = /^\d{1,3}$/
const NON_ASCII_HOST_CHAR_RE = /[\p{L}\p{M}\p{N}]/u
const CODE_FILE_SUFFIXES = new Set([
  'cjs', 'css', 'csv', 'cts', 'doc', 'docx', 'env', 'gif', 'go', 'htm', 'html', 'ipynb', 'java',
  'jpeg', 'jpg', 'js', 'json', 'jsonc', 'jsx', 'kt', 'lock', 'log', 'md', 'mdx', 'mjs', 'mts',
  'pdf', 'php', 'png', 'ppt', 'pptx', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'svg',
  'swift', 'toml', 'ts', 'tsx', 'txt', 'vue', 'webp', 'xls', 'xlsx', 'xml', 'yaml', 'yml',
])
/** Characters that may follow a URL in prose or Markdown without being part of it. */
const TRAILING_PUNCT = new Set([...'.,;:!?)]}\'">*_~`|'])
/** At most this many trailing characters are ignored when matching an allowed URL. */
const MAX_TRAILING_ON_ALLOWED = 4
/** Characters after `//` that cannot begin a host. */
const NOT_AUTHORITY_START = new Set([...')]}>"\'`,;:!?#|<*'])

const SLASH = 0x2f
const BACKSLASH = 0x5c

function isBreak(c: number): boolean {
  return c <= 0x20 || c === 0x7f
}

function isAsciiAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
}

function isAsciiDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39
}

function isSchemeChar(c: number): boolean {
  return isAsciiAlpha(c) || isAsciiDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e
}

/** ASCII '.' only: treating '。' as a separator would turn CJK sentences into hosts. */
function isLabelSeparator(c: number): boolean {
  return c === 0x2e
}

function isSlash(c: number): boolean {
  return c === SLASH || c === BACKSLASH
}

function isHostChar(c: number): boolean {
  if (c < 0x80) return isAsciiAlpha(c) || isAsciiDigit(c) || c === 0x2d || c === 0x5f
  if (c >= 0xd800 && c <= 0xdfff) return true
  return NON_ASCII_HOST_CHAR_RE.test(String.fromCharCode(c))
}

/** A bare host at `p` (already known to start a label) followed by a port, path, query or fragment. */
function bareHostUrlAt(text: string, p: number, to: number): boolean {
  let q = p
  while (q < to) {
    const c = text.charCodeAt(q)
    if (!isHostChar(c) && !isLabelSeparator(c)) break
    q++
  }
  let r = q
  if (r < to && text.charCodeAt(r) === 0x3a) {
    const digitsStart = r + 1
    r = digitsStart
    while (r < to && r - digitsStart < 5 && isAsciiDigit(text.charCodeAt(r))) r++
    if (r === digitsStart) return false
  }
  if (r >= to) return false
  const next = text.charCodeAt(r)
  const pathLike =
    isSlash(next) ||
    ((next === 0x3f || next === 0x23) && r + 1 < to && !TRAILING_PUNCT.has(text[r + 1]!))
  if (!pathLike) return false
  const labels = text.slice(p, q).split('.')
  if (labels[labels.length - 1] === '') labels.pop() // trailing-dot FQDN
  if (labels.length < 2 || labels.some((l) => l === '')) return false
  if (labels.length === 4 && labels.every((l) => IPV4_LABEL_RE.test(l))) return true
  const tld = labels[labels.length - 1]!
  return tld.length <= 63 && TLD_RE.test(tld) && !CODE_FILE_SUFFIXES.has(tld.toLowerCase())
}

/** Index in [from, to) where the first URL starts, or -1. `to` is the end of a token. */
function findUrlStart(text: string, from: number, to: number): number {
  for (let p = from; p < to; p++) {
    const c = text.charCodeAt(p)
    const prev = p > from ? text.charCodeAt(p - 1) : -1
    if (isAsciiAlpha(c) && (prev < 0 || !isSchemeChar(prev))) {
      KNOWN_SCHEME_RE.lastIndex = p
      if (KNOWN_SCHEME_RE.test(text) && KNOWN_SCHEME_RE.lastIndex < to) return p
      GENERIC_SCHEME_RE.lastIndex = p
      if (GENERIC_SCHEME_RE.test(text)) return p
    }
    if (isSlash(c)) {
      if (prev < 0 || (!isHostChar(prev) && !isLabelSeparator(prev) && !isSlash(prev))) {
        let q = p
        while (q < to && isSlash(text.charCodeAt(q))) q++
        if (q - p >= 2 && q < to && !NOT_AUTHORITY_START.has(text[q]!)) return p
      }
      continue
    }
    if (isHostChar(c) && (prev < 0 || (!isHostChar(prev) && !isLabelSeparator(prev)))) {
      WWW_RE.lastIndex = p
      if (WWW_RE.test(text) && WWW_RE.lastIndex < to) return p
      if (bareHostUrlAt(text, p, to)) return p
    }
  }
  return -1
}

function normalizeUrl(u: string): string | null {
  try {
    return new URL(u).href
  } catch {
    return null
  }
}

function allowedUrlSet(allowedUrls: readonly string[]): ReadonlySet<string> {
  const allowed = new Set<string>()
  for (const u of allowedUrls) {
    allowed.add(u)
    const n = normalizeUrl(u)
    if (n) allowed.add(n)
  }
  return allowed
}

function isAllowedUrl(candidate: string, allowed: ReadonlySet<string>): boolean {
  if (allowed.has(candidate)) return true
  const n = normalizeUrl(candidate)
  return n !== null && allowed.has(n)
}

function stripUrls(text: string, allowed: ReadonlySet<string>): { text: string; stripped: number } {
  let out = ''
  let copied = 0
  let stripped = 0
  let i = 0
  while (i < text.length) {
    if (isBreak(text.charCodeAt(i))) {
      i++
      continue
    }
    let end = i
    while (end < text.length && !isBreak(text.charCodeAt(end))) end++
    const start = findUrlStart(text, i, end)
    if (start >= 0) {
      const span = text.slice(start, end)
      let trailing = 0
      while (trailing < span.length - 1 && TRAILING_PUNCT.has(span[span.length - 1 - trailing]!)) trailing++
      let keep = false
      if (allowed.size > 0) {
        for (let k = 0; k <= Math.min(trailing, MAX_TRAILING_ON_ALLOWED) && !keep; k++) {
          keep = isAllowedUrl(span.slice(0, span.length - k), allowed)
        }
      }
      if (!keep) {
        out += text.slice(copied, start) + AI_REMOVED_LINK_TEXT + span.slice(span.length - trailing)
        copied = end
        stripped++
      }
    }
    i = end
  }
  return { text: stripped === 0 ? text : out + text.slice(copied), stripped }
}

/** Replace every URL in `text` that is not in `allowed`. */
export function stripAiUntrustedUrls(
  text: string,
  allowedUrls: readonly string[],
): { text: string; stripped: number } {
  return stripUrls(text, allowedUrlSet(allowedUrls))
}

const MAX_DEPTH = 32

interface SanitizeState {
  ids: ReadonlySet<string>
  allowed: ReadonlySet<string>
  dropped: string[]
  stripped: number
}

function cleanText(text: string, state: SanitizeState): string {
  const r = stripUrls(text, state.allowed)
  state.stripped += r.stripped
  return r.text
}

function isUnsafeKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype'
}

function sanitize(value: unknown, state: SanitizeState, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error('output nesting too deep')
  if (typeof value === 'string') return cleanText(value, state)
  if (Array.isArray(value)) return value.map((v) => sanitize(v, state, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [rawKey, v] of Object.entries(value)) {
      if (isUnsafeKey(rawKey)) continue
      // Keys are model text too (z.record outputs); the first of any colliding keys wins.
      const key = cleanText(rawKey, state)
      if (isUnsafeKey(key) || Object.hasOwn(out, key)) continue
      if (key === 'citations' && Array.isArray(v)) {
        const kept: string[] = []
        for (const c of v) {
          if (typeof c === 'string' && state.ids.has(c.trim())) {
            if (!kept.includes(c.trim())) kept.push(c.trim())
          } else {
            // Callers may show or log flagged citations, so they get the same URL filter.
            state.dropped.push(cleanText(String(c), state).slice(0, 64))
          }
        }
        out[key] = kept
        continue
      }
      out[key] = sanitize(v, state, depth + 1)
    }
    return out
  }
  return value
}

function stripCodeFence(raw: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i.exec(raw)
  return m ? m[1]! : raw
}

/**
 * Parse and validate raw model text against `schema`, filtering citations and URLs first.
 * Issues are schema paths/messages only, never output text.
 */
export function validateAiOutput<T>(
  raw: string,
  schema: z.ZodType<T>,
  ctx: AiOutputContext,
): AiOutputResult<T> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'empty', issues: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(raw))
  } catch {
    return { ok: false, error: 'invalid_json', issues: [] }
  }
  const state: SanitizeState = {
    ids: new Set(ctx.evidenceIds),
    allowed: allowedUrlSet(ctx.allowedUrls),
    dropped: [],
    stripped: 0,
  }
  let cleaned: unknown
  try {
    cleaned = sanitize(parsed, state, 0)
  } catch {
    return { ok: false, error: 'schema_mismatch', issues: ['output nesting too deep'] }
  }
  const result = schema.safeParse(cleaned)
  if (!result.success) {
    return {
      ok: false,
      error: 'schema_mismatch',
      issues: result.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`),
    }
  }
  return {
    ok: true,
    value: result.data,
    droppedCitations: state.dropped.slice(0, 50),
    strippedUrls: state.stripped,
  }
}

// JSON Schema keywords the Gemini Developer API documents for responseJsonSchema.
const SUPPORTED_SCHEMA_KEYS = new Set([
  '$id',
  '$defs',
  '$ref',
  '$anchor',
  'type',
  'format',
  'title',
  'description',
  'enum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'oneOf',
  'properties',
  'additionalProperties',
  'required',
  'propertyOrdering',
])

function filterSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(filterSchema)
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    // `const` is not in the documented list, but `enum` is: keep string literals and union
    // discriminators as a one-value enum so JSON mode is told the allowed value. Other const
    // types are dropped (zod still checks them); non-string enums are not documented.
    if (key === 'const') {
      if (typeof value === 'string' && !('enum' in node)) out.enum = [value]
      continue
    }
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) continue
    if (key === 'properties' || key === '$defs') {
      const map: Record<string, unknown> = {}
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        map[name] = filterSchema(sub)
      }
      out[key] = map
    } else if (key === 'enum' || key === 'required' || key === 'propertyOrdering') {
      out[key] = value
    } else {
      out[key] = filterSchema(value)
    }
  }
  return out
}

/**
 * JSON Schema for Gemini's JSON response mode, derived from the zod schema that validates the
 * output. Keywords the API does not document (string lengths, patterns, $schema) are removed;
 * the zod schema still enforces them after the response arrives.
 */
export function aiResponseJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' })
  return filterSchema(json) as Record<string, unknown>
}
