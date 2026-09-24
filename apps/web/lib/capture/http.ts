/**
 * JSON helpers for the Chrome helper's Route Handlers (/api/capture/v1/*).
 * Responses are never cached and never echo request content.
 */
import 'server-only'

const BASE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } })
}

/**
 * The client address, for per-source rate limiting of pairing attempts (hashed
 * before it is stored). On Vercel the platform sets x-forwarded-for / x-real-ip
 * and overwrites client-supplied values; behind another proxy make sure it does
 * the same, or every client shares one source ('unknown' when absent).
 */
export function captureRequestSource(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const source = forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown'
  return source.slice(0, 100)
}

/** Error body: a fixed code plus optional safe fields (state names, schema paths). */
export function errorResponse(
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return jsonResponse({ error, ...extra }, status, headers)
}

export type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; response: Response }

/**
 * Read and parse a JSON body without trusting Content-Length: the stream is
 * read with a hard byte cap, so an oversized body is refused with 413 before it
 * is fully buffered.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyResult> {
  const type = request.headers.get('content-type') ?? ''
  if (!/^application\/json(\s*;|$)/i.test(type)) {
    return { ok: false, response: errorResponse(415, 'unsupported_media_type') }
  }
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return { ok: false, response: errorResponse(400, 'invalid_length') }
    if (Number(declared) > maxBytes) return { ok: false, response: errorResponse(413, 'payload_too_large') }
  }
  if (!request.body) return { ok: false, response: errorResponse(400, 'invalid_json') }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return { ok: false, response: errorResponse(413, 'payload_too_large') }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.byteLength
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, response: errorResponse(400, 'invalid_json') }
  }
}

/** Declared Content-Length above the limit (cheap pre-check before authenticating). */
export function declaredTooLarge(request: Request, maxBytes: number): boolean {
  const declared = request.headers.get('content-length')
  return declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes
}
