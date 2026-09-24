import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isConnectionError, type ConnectionFailure } from '@personal-home/core'
import {
  httpExtractProviderError,
  httpParseRetryAfter,
  httpRedactSecrets,
  httpRequestJson,
  httpRequestNoContent,
  type HttpRequestOptions,
} from '../src/index.ts'
import { createFakeFetch, hang, jsonResponse, textResponse, type FakeHandler } from './fixtures/fake-fetch.ts'

const now = new Date('2026-09-24T10:00:00Z')
const Schema = z.object({ ok: z.literal(true), n: z.number() })

function opts(handler: FakeHandler, extra: Partial<HttpRequestOptions> = {}) {
  const fake = createFakeFetch(handler)
  const o: HttpRequestOptions = {
    fetch: fake.fetch,
    provider: 'Example',
    operation: 'profile',
    url: 'https://api.example.test/v1/me?secret_param=abc',
    now: () => now,
    ...extra,
  }
  return { o, fake }
}

async function failureOf(p: Promise<unknown>): Promise<ConnectionFailure> {
  try {
    await p
  } catch (err) {
    if (isConnectionError(err)) return err.failure
    throw err
  }
  throw new Error('expected a ConnectionError')
}

describe('httpParseRetryAfter', () => {
  it('parses delay-seconds', () => {
    expect(httpParseRetryAfter('120', now)).toBe(120_000)
    expect(httpParseRetryAfter(' 0 ', now)).toBe(0)
  })

  it('parses HTTP-dates relative to now and never goes negative', () => {
    expect(httpParseRetryAfter('Thu, 24 Sep 2026 10:05:00 GMT', now)).toBe(300_000)
    expect(httpParseRetryAfter('Thu, 24 Sep 2026 09:00:00 GMT', now)).toBe(0)
    // RFC 850 obsolete format is still an HTTP-date.
    expect(httpParseRetryAfter('Thursday, 24-Sep-26 10:01:00 GMT', now)).toBe(60_000)
  })

  it('rejects junk', () => {
    for (const v of [null, undefined, '', '-5', '1.5', 'soon', '10s', '2026-09-24T10:05:00Z']) {
      expect(httpParseRetryAfter(v as string | null, now)).toBeNull()
    }
  })
})

describe('httpExtractProviderError', () => {
  it('reads OAuth, Google and Graph error shapes, but only validated codes', () => {
    expect(httpExtractProviderError({ error: 'invalid_grant', error_description: 'secret stuff' })).toEqual({
      code: 'invalid_grant',
      reasons: [],
    })
    expect(
      httpExtractProviderError({
        error: {
          code: 403,
          status: 'PERMISSION_DENIED',
          errors: [{ reason: 'userRateLimitExceeded' }],
          details: [{ reason: 'RATE_LIMIT_EXCEEDED' }, { reason: 'has spaces and <html>' }],
        },
      }),
    ).toEqual({ code: 'PERMISSION_DENIED', reasons: ['userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED'] })
    expect(httpExtractProviderError({ error: { code: 'InvalidAuthenticationToken', message: 'm' } })).toEqual({
      code: 'InvalidAuthenticationToken',
      reasons: [],
    })
    expect(httpExtractProviderError({ error: 'contains a space' }).code).toBeNull()
    expect(httpExtractProviderError('nope')).toEqual({ code: null, reasons: [] })
  })
})

describe('httpRequestJson', () => {
  it('returns validated JSON and sends safe defaults', async () => {
    const { o, fake } = opts(() => jsonResponse({ ok: true, n: 1, extra: 'ignored' }), {
      headers: { authorization: 'Bearer t' },
    })
    const res = await httpRequestJson(o, Schema)
    expect(res.data).toEqual({ ok: true, n: 1 })
    expect(fake.calls[0]!.headers.accept).toBe('application/json')
    expect(fake.calls[0]!.headers.authorization).toBe('Bearer t')
    expect(fake.calls[0]!.redirect).toBe('error')
  })

  it('malformed JSON and unexpected shapes are transient malformed_response', async () => {
    const a = opts(() => textResponse('<html>oops</html>', 200))
    expect(await failureOf(httpRequestJson(a.o, Schema))).toMatchObject({
      kind: 'transient',
      code: 'transient.malformed_response',
    })
    const b = opts(() => jsonResponse({ ok: 'yes' }))
    const f = await failureOf(httpRequestJson(b.o, Schema))
    expect(f.code).toBe('transient.malformed_response')
    expect(f.message).toBe('Example profile returned an unexpected response shape')
  })

  it('classifies 401, 403, 404, 429 and 5xx by default, with Retry-After', async () => {
    const cases: [number, Record<string, string>, string, number | undefined][] = [
      [401, {}, 'auth.unauthorized', undefined],
      [403, {}, 'auth.forbidden', undefined],
      [404, {}, 'provider.http_404', undefined],
      [429, { 'retry-after': '30' }, 'rate_limited.http_429', 30_000],
      [429, { 'retry-after': 'Thu, 24 Sep 2026 10:02:00 GMT' }, 'rate_limited.http_429', 120_000],
      [503, { 'retry-after': '5' }, 'transient.http_503', 5_000],
      [500, {}, 'transient.http_500', undefined],
    ]
    for (const [status, headers, code, retry] of cases) {
      const { o } = opts(() => jsonResponse({ error: { code: 'X' } }, status, headers))
      const f = await failureOf(httpRequestJson(o, Schema))
      expect(f.code).toBe(code)
      expect(f.httpStatus).toBe(status)
      expect(f.retryAfterMs).toBe(retry)
    }
  })

  it('never puts response bodies, URL queries or known secrets into messages', async () => {
    const { o } = opts(
      () =>
        jsonResponse(
          { error: { code: 'BadThing', message: 'token ya29.leaked for victim@example.com' } },
          400,
        ),
      { secrets: ['super-secret-value'], operation: 'profile super-secret-value' },
    )
    const f = await failureOf(httpRequestJson(o, Schema))
    expect(f.message).toBe('Example profile [redacted] failed: HTTP 400 (BadThing)')
    expect(f.message).not.toMatch(/ya29|victim|secret_param/)
  })

  it('lets a provider hook reclassify errors', async () => {
    const { o } = opts(() => jsonResponse({ error: 'invalid_grant' }, 400), {
      classify: (info) =>
        info.code === 'invalid_grant'
          ? { kind: 'auth', code: 'auth.invalid_grant', message: 'custom' }
          : undefined,
    })
    expect((await failureOf(httpRequestJson(o, Schema))).code).toBe('auth.invalid_grant')
  })

  it('maps network errors, timeouts and caller aborts', async () => {
    const net = opts(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
    })
    expect(await failureOf(httpRequestJson(net.o, Schema))).toMatchObject({
      code: 'transient.network',
      message: 'Example profile network error (ECONNRESET)',
    })

    const slow = opts(() => hang(), { timeoutMs: 20 })
    expect(await failureOf(httpRequestJson(slow.o, Schema))).toMatchObject({
      code: 'transient.timeout',
      kind: 'transient',
    })

    const controller = new AbortController()
    const cancelled = opts(() => hang(), { signal: controller.signal, timeoutMs: 5_000 })
    const p = httpRequestJson(cancelled.o, Schema)
    controller.abort()
    expect((await failureOf(p)).code).toBe('transient.aborted')
  })

  it('refuses oversized responses', async () => {
    const big = opts(() => textResponse('x'.repeat(5000)), { maxBytes: 1000 })
    expect((await failureOf(httpRequestJson(big.o, Schema))).code).toBe('transient.response_too_large')
    const declared = opts(() => textResponse('{}', 200, { 'content-length': '999999999' }), { maxBytes: 1000 })
    expect((await failureOf(httpRequestJson(declared.o, Schema))).code).toBe('transient.response_too_large')
  })
})

describe('httpRequestNoContent', () => {
  it('succeeds on 2xx with any body and throws on errors', async () => {
    const ok = opts(() => textResponse('', 200))
    expect(await httpRequestNoContent(ok.o)).toEqual({ status: 200 })
    const bad = opts(() => jsonResponse({ error: 'invalid_token' }, 400))
    expect((await failureOf(httpRequestNoContent(bad.o))).code).toBe('provider.http_400')
  })
})

describe('httpRedactSecrets', () => {
  it('replaces exact secret values and ignores tiny ones', () => {
    expect(httpRedactSecrets('a abcd b abcd', ['abcd', 'x', ''])).toBe('a [redacted] b [redacted]')
  })
})
