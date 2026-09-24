import { describe, expect, it } from 'vitest'
import { captureParseConversationUrl } from '../src/index.ts'

const ID = '0b6a1f5e-9a3c-4c1e-8f2d-3a4b5c6d7e8f'
const PROJECT = '11111111-2222-4333-8444-555555555555'

describe('captureParseConversationUrl', () => {
  it('accepts ChatGPT conversation URLs, including custom GPTs and projects', () => {
    expect(captureParseConversationUrl(`https://chatgpt.com/c/${ID}`)).toEqual({
      provider: 'chatgpt',
      externalId: ID,
      canonicalUrl: `https://chatgpt.com/c/${ID}`,
    })
    expect(captureParseConversationUrl(`https://chatgpt.com/g/g-2DQzU5UZl/c/${ID}`)?.canonicalUrl).toBe(
      `https://chatgpt.com/g/g-2DQzU5UZl/c/${ID}`,
    )
    const project = `https://chatgpt.com/g/g-p-689ae2f1363881919fc41124c7dbc2fd-my-project/c/${ID}`
    expect(captureParseConversationUrl(project)?.externalId).toBe(ID)
    expect(captureParseConversationUrl(`https://chatgpt.com/g/g-p-689ae2f1363881919fc41124c7dbc2fd/c/${ID}`)).not.toBeNull()
  })

  it('accepts Claude chat URLs, including the project-nested form', () => {
    expect(captureParseConversationUrl(`https://claude.ai/chat/${ID}`)).toEqual({
      provider: 'claude',
      externalId: ID,
      canonicalUrl: `https://claude.ai/chat/${ID}`,
    })
    expect(captureParseConversationUrl(`https://claude.ai/project/${PROJECT}/chat/${ID}`)).toEqual({
      provider: 'claude',
      externalId: ID,
      canonicalUrl: `https://claude.ai/project/${PROJECT}/chat/${ID}`,
    })
  })

  it('canonicalizes: lowercase ids, no query, fragment or trailing slash', () => {
    const r = captureParseConversationUrl(`https://chatgpt.com/c/${ID.toUpperCase()}/?model=x#top`)
    expect(r).toEqual({ provider: 'chatgpt', externalId: ID, canonicalUrl: `https://chatgpt.com/c/${ID}` })
    expect(captureParseConversationUrl(`  https://claude.ai/chat/${ID}  `)?.canonicalUrl).toBe(
      `https://claude.ai/chat/${ID}`,
    )
  })

  it.each([
    ['plain http', `http://chatgpt.com/c/${ID}`],
    ['legacy host', `https://chat.openai.com/c/${ID}`],
    ['subdomain', `https://www.chatgpt.com/c/${ID}`],
    ['look-alike host', `https://chatgpt.com.evil.example/c/${ID}`],
    ['trailing-dot host', `https://chatgpt.com./c/${ID}`],
    ['explicit port', `https://chatgpt.com:8443/c/${ID}`],
    ['credentials', `https://user:pw@claude.ai/chat/${ID}`],
    ['share link', `https://chatgpt.com/share/${ID}`],
    ['temporary chat', `https://chatgpt.com/c/${ID}?temporary-chat=true`],
    ['extra segment', `https://chatgpt.com/c/${ID}/extra`],
    ['not a uuid', 'https://chatgpt.com/c/not-a-uuid'],
    ['claude project home', `https://claude.ai/project/${PROJECT}`],
    ['claude share', `https://claude.ai/share/${ID}`],
    ['provider path on the wrong host', `https://claude.ai/c/${ID}`],
    ['javascript url', 'javascript:alert(1)'],
    ['empty', ''],
    ['huge', `https://chatgpt.com/c/${ID}?${'a'.repeat(3000)}`],
  ])('rejects %s', (_label, url) => {
    expect(captureParseConversationUrl(url)).toBeNull()
  })
})
