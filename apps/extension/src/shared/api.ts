/**
 * Client for the dashboard's versioned capture API (/api/capture/v1/*).
 * Runs in the service worker, which may call the dashboard without CORS once
 * the owner granted host access to it at pairing. Every response body is
 * validated before it is trusted. The token is sent only to the paired origin.
 */
import {
  CapturePairResponseSchema,
  CaptureSelectionResponseSchema,
  CaptureSnapshotResponseSchema,
  CaptureStatusResponseSchema,
  type CapturePairResponse,
  type CaptureSelectionResponse,
  type CaptureSnapshot,
  type CaptureSnapshotResponse,
  type CaptureStatusReport,
  type CaptureStatusResponse,
} from '@personal-home/core'
import type { z } from 'zod'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false
      /** null: network failure, timeout or an unreadable response. */
      status: number | null
      error: string
      retryAfter: string | null
    }

const TIMEOUT_MS = 25_000 // below the service worker's 30 s fetch limit

/**
 * The dashboard origin the owner typed: https, or http only for localhost
 * development. Returns the normalized origin or null.
 */
export function normalizeDashboardOrigin(input: string): string | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.username || url.password) return null
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
  return url.origin
}

/** Match pattern for chrome.permissions (optional host permission). */
export function originPermissionPattern(origin: string): string {
  const url = new URL(origin)
  // Match patterns have no port component; access to a host covers all its ports.
  return `${url.protocol}//${url.hostname}/*`
}

export class CaptureApi {
  constructor(
    private readonly origin: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  private async call<S extends z.ZodType>(
    path: string,
    schema: S,
    init: { method: 'GET' | 'POST'; token?: string; body?: unknown },
  ): Promise<ApiResult<z.infer<S>>> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (init.token) headers.Authorization = `Bearer ${init.token}`
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let res: Response
    try {
      res = await this.fetchImpl(`${this.origin}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      })
    } catch {
      return { ok: false, status: null, error: 'network_error', retryAfter: null }
    } finally {
      clearTimeout(timer)
    }
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      json = null
    }
    if (!res.ok) {
      const error =
        json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string'
          ? ((json as { error: string }).error.slice(0, 64) as string)
          : `http_${res.status}`
      return { ok: false, status: res.status, error, retryAfter: res.headers.get('retry-after') }
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) return { ok: false, status: null, error: 'unexpected_response', retryAfter: null }
    return { ok: true, status: res.status, data: parsed.data }
  }

  pair(code: string, deviceName: string): Promise<ApiResult<CapturePairResponse>> {
    return this.call('/api/capture/v1/pair', CapturePairResponseSchema, {
      method: 'POST',
      body: { code, deviceName },
    })
  }

  selection(token: string): Promise<ApiResult<CaptureSelectionResponse>> {
    return this.call('/api/capture/v1/selection', CaptureSelectionResponseSchema, { method: 'GET', token })
  }

  snapshot(token: string, body: CaptureSnapshot): Promise<ApiResult<CaptureSnapshotResponse>> {
    return this.call('/api/capture/v1/snapshots', CaptureSnapshotResponseSchema, { method: 'POST', token, body })
  }

  status(token: string, body: CaptureStatusReport): Promise<ApiResult<CaptureStatusResponse>> {
    return this.call('/api/capture/v1/status', CaptureStatusResponseSchema, { method: 'POST', token, body })
  }
}
