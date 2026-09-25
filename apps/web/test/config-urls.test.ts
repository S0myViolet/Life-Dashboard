import { describe, expect, it } from 'vitest'
import { normalizeAppUrl, normalizeSupabaseUrl } from '@/lib/config-urls'
import { coreEnvProblems } from '@/lib/env'

describe('normalizeSupabaseUrl', () => {
  it('accepts the project URL, with or without a trailing slash or the REST suffix', () => {
    for (const v of [
      'https://abcdefghijklmnopqrst.supabase.co',
      'https://abcdefghijklmnopqrst.supabase.co/',
      'https://abcdefghijklmnopqrst.supabase.co/rest/v1',
      ' https://abcdefghijklmnopqrst.supabase.co/rest/v1/ ',
    ]) {
      expect(normalizeSupabaseUrl(v)).toBe('https://abcdefghijklmnopqrst.supabase.co')
    }
  })

  it('rejects other paths, plain http, query strings and junk', () => {
    for (const v of [
      'https://abc.supabase.co/auth/v1',
      'http://abc.supabase.co',
      'https://abc.supabase.co?x=1',
      'abc.supabase.co',
      '',
      undefined,
    ]) {
      expect(normalizeSupabaseUrl(v)).toBeNull()
    }
    expect(normalizeSupabaseUrl('http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321')
  })
})

describe('normalizeAppUrl', () => {
  it('accepts an origin and trims a trailing slash', () => {
    expect(normalizeAppUrl('https://life-dashboard-web.vercel.app/')).toBe(
      'https://life-dashboard-web.vercel.app',
    )
    expect(normalizeAppUrl('http://localhost:3000')).toBe('http://localhost:3000')
  })

  it('rejects placeholders, paths and plain http', () => {
    for (const v of [
      'https://example.com',
      'https://www.example.org',
      'https://app.vercel.app/home',
      'http://app.vercel.app',
      'not a url',
    ]) {
      expect(normalizeAppUrl(v)).toBeNull()
    }
  })
})

describe('coreEnvProblems', () => {
  const good = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co/rest/v1/',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_value_for_tests',
    SUPABASE_SECRET_KEY: 'synthetic-secret-value-for-tests-only',
    DATABASE_URL:
      'postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres',
    OWNER_EMAIL: 'owner@example.com',
    APP_URL: 'https://life-dashboard-web.vercel.app',
    TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32))),
  } as unknown as NodeJS.ProcessEnv

  it('passes a complete configuration (the REST suffix is tolerated)', () => {
    expect(coreEnvProblems(good)).toEqual([])
  })

  it('names each problem with a hint and never echoes a value', () => {
    const problems = coreEnvProblems({
      ...good,
      DATABASE_URL: '6543',
      APP_URL: 'https://example.com',
      OWNER_EMAIL: '',
    })
    expect(problems.map((p) => p.name).sort()).toEqual(['APP_URL', 'DATABASE_URL', 'OWNER_EMAIL'])
    expect(problems.find((p) => p.name === 'OWNER_EMAIL')?.hint).toBe('not set')
    expect(problems.find((p) => p.name === 'DATABASE_URL')?.hint).toMatch(/Transaction pooler/)
    expect(JSON.stringify(problems)).not.toContain('6543')
  })
})
