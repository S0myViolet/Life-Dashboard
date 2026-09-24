import { describe, expect, it } from 'vitest'
import {
  CAPTURE_LIMITS,
  CapturePairRequestSchema,
  CaptureSnapshotSchema,
  CaptureStatusReportSchema,
  ProjectInputSchema,
  captureGenerateDeviceToken,
  captureGeneratePairingCode,
  captureHashDeviceToken,
  captureIsDeviceTokenFormat,
  captureIssueSummary,
  captureNormalizePairingCode,
  captureNormalizeText,
  type CaptureSnapshot,
} from '../src/index.ts'

const ID = '0b6a1f5e-9a3c-4c1e-8f2d-3a4b5c6d7e8f'

function snapshot(overrides: Partial<CaptureSnapshot> = {}): CaptureSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    provider: 'chatgpt',
    conversation: { externalId: ID, url: `https://chatgpt.com/c/${ID}`, title: 'Plan' },
    messages: [
      { key: 'm-1', role: 'user', text: 'Hello', orderHint: 1 },
      { key: 'm-2', role: 'assistant', text: 'Hi there', orderHint: 2 },
    ],
    capturedAt: '2026-09-24T10:00:00.000Z',
    coverage: {
      mode: 'passive',
      observedFirstMessage: true,
      observedLastMessage: true,
      renderedCount: 2,
      accumulatedCount: 2,
      streamingInProgress: false,
      pageState: 'ok',
    },
    extensionVersion: '0.1.0',
    ...overrides,
  }
}

describe('CaptureSnapshotSchema', () => {
  it('accepts a well-formed v1 snapshot', () => {
    expect(CaptureSnapshotSchema.safeParse(snapshot()).success).toBe(true)
  })

  it('requires the external id to match the URL and the URL to match the provider', () => {
    const mismatch = CaptureSnapshotSchema.safeParse(
      snapshot({
        conversation: { externalId: '11111111-2222-4333-8444-555555555555', url: `https://chatgpt.com/c/${ID}` },
      }),
    )
    expect(mismatch.success).toBe(false)
    expect(captureIssueSummary(mismatch.error!)).toEqual([
      { path: 'conversation.externalId', code: 'external_id_mismatch' },
    ])

    const wrongProvider = CaptureSnapshotSchema.safeParse(
      snapshot({ provider: 'claude' }),
    )
    expect(captureIssueSummary(wrongProvider.error!)).toEqual([
      { path: 'conversation.url', code: 'url_not_allowed' },
    ])

    const share = CaptureSnapshotSchema.safeParse(
      snapshot({ conversation: { externalId: ID, url: `https://chatgpt.com/share/${ID}` } }),
    )
    expect(share.success).toBe(false)
  })

  it('rejects unknown keys, bad versions and duplicate message keys', () => {
    expect(CaptureSnapshotSchema.safeParse({ ...snapshot(), cookies: 'x' }).success).toBe(false)
    expect(CaptureSnapshotSchema.safeParse({ ...snapshot(), schemaVersion: 2 }).success).toBe(false)
    const dup = CaptureSnapshotSchema.safeParse(
      snapshot({
        messages: [
          { key: 'same', role: 'user', text: 'a' },
          { key: 'same', role: 'assistant', text: 'b' },
        ],
      }),
    )
    expect(captureIssueSummary(dup.error!)).toEqual([{ path: 'messages.1.key', code: 'duplicate_key' }])
    expect(
      CaptureSnapshotSchema.safeParse(snapshot({ messages: [{ key: 'bad key!', role: 'user', text: 'a' }] }))
        .success,
    ).toBe(false)
    expect(
      CaptureSnapshotSchema.safeParse(snapshot({ messages: [{ role: 'system' as never, text: 'a' }] })).success,
    ).toBe(false)
  })

  it('enforces message count and text length limits', () => {
    const many = Array.from({ length: CAPTURE_LIMITS.maxMessages + 1 }, (_, i) => ({
      key: `k${i}`,
      role: 'user' as const,
      text: 'x',
    }))
    expect(CaptureSnapshotSchema.safeParse(snapshot({ messages: many })).success).toBe(false)
    expect(
      CaptureSnapshotSchema.safeParse(
        snapshot({ messages: [{ role: 'user', text: 'x'.repeat(CAPTURE_LIMITS.maxMessageChars + 1) }] }),
      ).success,
    ).toBe(false)
    expect(
      CaptureSnapshotSchema.safeParse(
        snapshot({ messages: [{ role: 'user', text: 'x'.repeat(CAPTURE_LIMITS.maxMessageChars) }] }),
      ).success,
    ).toBe(true)
  })

  it('issue summaries never contain submitted text', () => {
    const secret = 'my private message text'
    const bad = CaptureSnapshotSchema.safeParse(
      snapshot({ messages: [{ key: secret, role: 'user', text: secret }] }),
    )
    expect(JSON.stringify(captureIssueSummary(bad.error!))).not.toContain('private')
  })
})

describe('CaptureStatusReportSchema', () => {
  it('accepts only problem states', () => {
    const base = {
      schemaVersion: 1,
      provider: 'claude',
      externalId: ID,
      state: 'signed_out',
      mode: 'passive',
      observedAt: '2026-09-24T10:00:00Z',
      extensionVersion: '0.1.0',
    }
    expect(CaptureStatusReportSchema.safeParse(base).success).toBe(true)
    expect(CaptureStatusReportSchema.safeParse({ ...base, state: 'ok' }).success).toBe(false)
    expect(CaptureStatusReportSchema.safeParse({ ...base, state: 'active' }).success).toBe(false)
  })
})

describe('pairing codes and tokens', () => {
  it('generates readable 60-bit codes that normalize back', () => {
    const codes = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const code = captureGeneratePairingCode()
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
      expect(captureNormalizePairingCode(code)).toBe(code.replace(/-/g, ''))
      codes.add(code)
    }
    expect(codes.size).toBe(200)
  })

  it('normalizes typing variations and rejects non-codes', () => {
    expect(captureNormalizePairingCode(' abcd efgh jkmn ')).toBe('ABCDEFGHJKMN')
    expect(captureNormalizePairingCode('ABCD-EFGH-JKMO')).toBe('ABCDEFGHJKM0')
    expect(captureNormalizePairingCode('abcd-efgh-jkmi')).toBe('ABCDEFGHJKM1')
    expect(captureNormalizePairingCode('ABCD-EFGH-JKMU')).toBeNull()
    expect(captureNormalizePairingCode('ABCD-EFGH')).toBeNull()
    expect(captureNormalizePairingCode('x'.repeat(100))).toBeNull()
  })

  it('device tokens are 256-bit, prefixed, and hashed as sha256 hex', async () => {
    const token = captureGenerateDeviceToken()
    expect(captureIsDeviceTokenFormat(token)).toBe(true)
    expect(captureIsDeviceTokenFormat(`${token}x`)).toBe(false)
    expect(await captureHashDeviceToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('validates device names', () => {
    expect(CapturePairRequestSchema.safeParse({ code: 'x', deviceName: ' Laptop Chrome ' }).data?.deviceName).toBe(
      'Laptop Chrome',
    )
    expect(CapturePairRequestSchema.safeParse({ code: 'x', deviceName: 'a\nb' }).success).toBe(false)
    expect(CapturePairRequestSchema.safeParse({ code: 'x', deviceName: '' }).success).toBe(false)
  })
})

describe('captureNormalizeText', () => {
  it('makes equivalent renders identical', () => {
    const a = 'Line one  \r\nLine two\u200B\n\n\n\nEnd '
    const b = 'Line one\nLine two\n\nEnd'
    expect(captureNormalizeText(a)).toBe(b)
    expect(captureNormalizeText('e\u0301')).toBe('\u00E9')
  })
})

describe('ProjectInputSchema', () => {
  it('trims, requires a name and a kind, drops an empty goal', () => {
    expect(ProjectInputSchema.parse({ name: '  Thesis ', kind: 'work', goal: '  ' })).toEqual({
      name: 'Thesis',
      kind: 'work',
      goal: undefined,
    })
    expect(ProjectInputSchema.safeParse({ name: '', kind: 'work' }).success).toBe(false)
    expect(ProjectInputSchema.safeParse({ name: 'x', kind: 'team' }).success).toBe(false)
  })
})
