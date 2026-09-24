/**
 * Shared plumbing for the journal recording routes: owner check (401, never a redirect), a
 * same-origin check for state-changing requests (defence in depth on top of SameSite cookies),
 * no-store JSON responses, id parsing and a streaming body reader with a hard byte cap.
 */
import 'server-only'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { Tx } from '@personal-home/db'
import { ownerTransaction } from '@/lib/server/db'
import { getOwner, type OwnerSession } from '@/lib/server/session'

export const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' } as const

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

export function fail(error: string, status: number, extra: Record<string, unknown> = {}): NextResponse {
  return json({ error, ...extra }, status)
}

/** Browsers send Origin (and Sec-Fetch-Site) on these requests; anything cross-site is refused. */
export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = request.headers.get('origin')
  if (!origin) return true
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return false
  }
  const expected = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  return expected !== null && host === expected
}

export type OwnerRun = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>

/**
 * Authenticate the owner for a route handler. Returns a response to send back (401/403) or the
 * session plus an owner-transaction runner (RLS enforced).
 */
export async function requireOwnerRoute(
  request: Request,
  o: { mutating: boolean },
): Promise<{ response: NextResponse } | { session: OwnerSession; run: OwnerRun }> {
  if (o.mutating && !isSameOrigin(request)) return { response: fail('forbidden', 403) }
  const session = await getOwner().catch(() => null)
  if (!session) return { response: fail('unauthorized', 401) }
  const run: OwnerRun = (fn) => ownerTransaction(session.claims, fn)
  return { session, run }
}

const UuidSchema = z.uuid()

export function parseRecordingId(raw: string): string | null {
  const parsed = UuidSchema.safeParse(raw)
  return parsed.success ? parsed.data.toLowerCase() : null
}

/**
 * Read a request body without trusting Content-Length, stopping as soon as it exceeds `max`.
 */
export async function readBodyWithLimit(request: Request, max: number): Promise<Uint8Array | 'too_large'> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) return 'too_large'
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return 'too_large'
    }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

/** Small JSON bodies only (recording registration). */
export async function readJson(request: Request, max = 4096): Promise<unknown | 'too_large' | 'invalid'> {
  const bytes = await readBodyWithLimit(request, max)
  if (bytes === 'too_large') return 'too_large'
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return 'invalid'
  }
}
