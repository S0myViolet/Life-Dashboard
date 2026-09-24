import { describe, expect, it } from 'vitest'
import { formatRecordingClock, RECORDER_ERROR_MESSAGES, recorderErrorOf, recorderSupport } from '@/lib/recording/errors'

const domError = (name: string) => Object.assign(new Error(name), { name })

describe('microphone and recorder errors', () => {
  it('classifies getUserMedia failures by DOMException name', () => {
    expect(recorderErrorOf(domError('NotAllowedError'))).toBe('denied')
    expect(recorderErrorOf(domError('SecurityError'))).toBe('denied')
    expect(recorderErrorOf(domError('PermissionDeniedError'))).toBe('denied')
    expect(recorderErrorOf(domError('NotFoundError'))).toBe('no_device')
    expect(recorderErrorOf(domError('NotReadableError'))).toBe('busy')
    expect(recorderErrorOf(domError('NotSupportedError'))).toBe('unsupported')
    expect(recorderErrorOf(new TypeError('x'))).toBe('unsupported')
    expect(recorderErrorOf('weird')).toBe('failed')
    expect(recorderErrorOf(null)).toBe('failed')
  })

  it('always offers typing as the way forward', () => {
    for (const message of Object.values(RECORDER_ERROR_MESSAGES)) expect(message).toMatch(/type your entry/)
    expect(RECORDER_ERROR_MESSAGES.denied).toMatch(/blocked/)
  })

  it('detects missing support before asking for the microphone', () => {
    expect(recorderSupport({ isSecureContext: false, hasGetUserMedia: true, hasMediaRecorder: true })).toBe('insecure')
    expect(recorderSupport({ isSecureContext: true, hasGetUserMedia: false, hasMediaRecorder: true })).toBe('unsupported')
    expect(recorderSupport({ isSecureContext: true, hasGetUserMedia: true, hasMediaRecorder: false })).toBe('unsupported')
    expect(recorderSupport({ isSecureContext: true, hasGetUserMedia: true, hasMediaRecorder: true })).toBeNull()
  })

  it('formats the timer', () => {
    expect(formatRecordingClock(0)).toBe('0:00')
    expect(formatRecordingClock(65.9)).toBe('1:05')
    expect(formatRecordingClock(900)).toBe('15:00')
    expect(formatRecordingClock(-3)).toBe('0:00')
  })
})
