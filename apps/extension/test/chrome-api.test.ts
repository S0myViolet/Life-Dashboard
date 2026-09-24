/**
 * The real Chrome adapter's alarm creation: Chrome 150+ accepts
 * persistAcrossSessions (set explicitly, as the alarms docs advise); older
 * Chrome rejects the unknown property. Observed on Chromium 141 while loading
 * the built extension in a local smoke run, so the adapter falls back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { realChromeApi } from '../src/background/chrome-api.ts'

const g = globalThis as unknown as { chrome?: unknown }

afterEach(() => {
  delete g.chrome
})

function stubChrome(create: ReturnType<typeof vi.fn>) {
  g.chrome = {
    runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', getManifest: () => ({ version: '0.1.0' }) },
    alarms: { create, get: vi.fn() },
  }
}

describe('realChromeApi().alarmCreate', () => {
  it('asks for persistence across sessions when Chrome supports it', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    stubChrome(create)
    await realChromeApi().alarmCreate('ph-tick', 1, 0.5)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('ph-tick', { periodInMinutes: 1, delayInMinutes: 0.5, persistAcrossSessions: true })
  })

  it('falls back without the property on Chrome versions that reject it', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('Error in invocation of alarms.create(optional string name, ...)'))
      .mockResolvedValueOnce(undefined)
    stubChrome(create)
    await realChromeApi().alarmCreate('ph-tick', 1, 0.5)
    expect(create).toHaveBeenLastCalledWith('ph-tick', { periodInMinutes: 1, delayInMinutes: 0.5 })
  })
})
