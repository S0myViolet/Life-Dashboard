/**
 * Validation of model output before anything is stored or shown.
 *
 * Model output is treated as untrusted too: it may have been steered by injected evidence. So
 * after JSON parsing, and before the zod schema check:
 *   - every `citations` array keeps only evidence ids that were actually provided;
 *   - every URL-like string that is not one of the provided source links is replaced, which
 *     closes the "render this link/image" exfiltration channel.
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
      /** Citations removed because they referenced ids that were not provided (truncated). */
      droppedCitations: string[]
      /** Number of URLs removed from text. The URLs themselves are not kept (possible exfiltration). */
      strippedUrls: number
    }
  | { ok: false; error: AiOutputFailure; issues: string[] }

export const AI_REMOVED_LINK_TEXT = '[link removed]'

// Scheme-qualified URLs (any common scheme, including data:/javascript:), www. hosts, and bare
// host references that carry a path, query or fragment (evil.example/steal, evil.example?d=x),
// since those can smuggle data out. A bare host name alone ("Node.js", "gov.uk") is left as prose.
const URL_RE =
  /\b(?:(?:https?|ftps?|file|data|javascript|vbscript|mailto|blob|wss?|sms|tel|intent):[^\s<>"'`]+|www\.[^\s<>"'`]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{2,5})?(?:\/[^\s<>"'`]*|[?#][^\s<>"'`]+))/gi
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/

function normalizeUrl(u: string): string | null {
  try {
    return new URL(u).href
  } catch {
    return null
  }
}

/** Replace every URL in `text` that is not in `allowed`. */
export function stripAiUntrustedUrls(
  text: string,
  allowedUrls: readonly string[],
): { text: string; stripped: number } {
  const allowed = new Set<string>()
  for (const u of allowedUrls) {
    allowed.add(u)
    const n = normalizeUrl(u)
    if (n) allowed.add(n)
  }
  let stripped = 0
  const out = text.replace(URL_RE, (match) => {
    const trail = TRAILING_PUNCT_RE.exec(match)?.[0] ?? ''
    const core = trail ? match.slice(0, -trail.length) : match
    const normalized = normalizeUrl(core)
    if (allowed.has(core) || (normalized !== null && allowed.has(normalized))) return match
    stripped++
    return AI_REMOVED_LINK_TEXT + trail
  })
  return { text: out, stripped }
}

const MAX_DEPTH = 32

interface SanitizeState {
  ids: ReadonlySet<string>
  allowedUrls: readonly string[]
  dropped: string[]
  stripped: number
}

function sanitize(value: unknown, state: SanitizeState, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error('output nesting too deep')
  if (typeof value === 'string') {
    const r = stripAiUntrustedUrls(value, state.allowedUrls)
    state.stripped += r.stripped
    return r.text
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, state, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      if (key === 'citations' && Array.isArray(v)) {
        const kept: string[] = []
        for (const c of v) {
          if (typeof c === 'string' && state.ids.has(c.trim())) {
            if (!kept.includes(c.trim())) kept.push(c.trim())
          } else {
            state.dropped.push(String(c).slice(0, 64))
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
    allowedUrls: ctx.allowedUrls,
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
