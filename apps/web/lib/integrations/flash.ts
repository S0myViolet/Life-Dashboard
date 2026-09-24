/**
 * One-line result messages for the Connections page, from closed query flags
 * set by the OAuth callback and server actions. Unknown values are ignored,
 * so nothing from a URL is ever echoed into the page.
 */
import {
  CONNECTION_PROVIDER_INFO,
  isOAuthConnectProvider,
  ProviderSchema,
  type Provider,
} from '@personal-home/core'
import { isOAuthResultError, type OAuthResultError } from './oauth-flow-codes'

export interface ConnectionsFlash {
  tone: 'positive' | 'caution' | 'danger'
  message: string
  /** Optional follow-up link (provider consent pages). */
  link?: { href: string; label: string }
}

/** Where the owner removes Personal Home's access by hand. */
export const PROVIDER_ACCESS_PAGES: Partial<Record<Provider, { href: string; label: string }>> = {
  google: { href: 'https://myaccount.google.com/permissions', label: 'Google account permissions' },
  // UNVERIFIED from the build container (learn.microsoft.com is blocked): long-standing consent pages.
  microsoft: {
    href: 'https://account.live.com/consent/Manage',
    label: 'Microsoft account app permissions',
  },
}

type SearchParams = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

function errorMessage(code: OAuthResultError, name: string): ConnectionsFlash {
  const danger = (message: string): ConnectionsFlash => ({ tone: 'danger', message })
  const caution = (message: string): ConnectionsFlash => ({ tone: 'caution', message })
  switch (code) {
    case 'needs_setup':
      return caution(
        `${name} is not set up on the server yet. Add the settings listed below, then try again.`,
      )
    case 'unknown_account':
      return caution('That account is no longer connected.')
    case 'invalid_request':
      return danger('The sign-in response was incomplete. Nothing was connected; please try again.')
    case 'state_mismatch':
      return danger(
        'This sign-in was not started from this browser, or was started twice. Nothing was connected; please try again.',
      )
    case 'state_expired':
      return danger(
        'The sign-in link expired or was already used. Nothing was connected; please try again.',
      )
    case 'denied':
      return caution(`You cancelled at ${name}. Nothing was connected.`)
    case 'provider_error':
      return danger(`${name} returned an error. Nothing was connected; please try again.`)
    case 'client_rejected':
      return danger(`${name} rejected this app's client ID or secret. Check the server settings.`)
    case 'exchange_failed':
      return danger(
        `${name} did not accept the sign-in code. Nothing was connected; please try again.`,
      )
    case 'no_refresh_token':
      return danger(
        `${name} did not grant background (offline) access, so nothing was connected. Try again and allow it.`,
      )
    case 'identity_failed':
      return danger('Could not confirm which account this is. Nothing was connected.')
    case 'rate_limited':
      return caution(`${name} is limiting requests right now. Try again in a few minutes.`)
    case 'provider_unavailable':
      return caution(`Could not reach ${name}. Try again shortly.`)
    case 'internal_error':
      return danger('Something went wrong on the server. Nothing was connected; please try again.')
  }
}

export function connectionsFlash(sp: SearchParams): ConnectionsFlash | null {
  const providerParse = ProviderSchema.safeParse(one(sp.provider) ?? one(sp.disconnected))
  const provider = providerParse.success ? providerParse.data : null
  const name = provider ? CONNECTION_PROVIDER_INFO[provider].displayName : 'The provider'

  const disconnected = one(sp.disconnected)
  if (disconnected && provider) {
    const page = PROVIDER_ACCESS_PAGES[provider]
    switch (one(sp.revoke)) {
      case 'revoked':
        return {
          tone: 'positive',
          message: `Disconnected. Access was revoked at ${name} and stored tokens were deleted.`,
        }
      case 'already_invalid':
        return {
          tone: 'positive',
          message: `Disconnected. ${name} had already ended access; stored tokens were deleted.`,
        }
      case 'not_supported':
        return {
          tone: 'caution',
          message: `Disconnected and stored tokens deleted. ${name} has no way for apps to revoke access, so remove Personal Home from your account's app permissions to finish.`,
          ...(page ? { link: page } : {}),
        }
      case 'failed':
        return {
          tone: 'caution',
          message: `Disconnected and stored tokens deleted, but revoking access at ${name} failed. Remove Personal Home from your account's app permissions.`,
          ...(page ? { link: page } : {}),
        }
      default:
        return null
    }
  }

  const result = one(sp.result)
  if (
    provider &&
    isOAuthConnectProvider(provider) &&
    (result === 'connected' || result === 'reconnected')
  ) {
    if (one(sp.check) === 'failed')
      return {
        tone: 'caution',
        message: `${name} account ${result}, but the first access check failed. See the account below.`,
      }
    return { tone: 'positive', message: `${name} account ${result}.` }
  }

  const error = one(sp.error)
  if (isOAuthResultError(error)) return errorMessage(error, name)
  return null
}
