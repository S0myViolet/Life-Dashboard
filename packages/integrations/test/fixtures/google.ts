// SYNTHETIC FIXTURE (not captured from the live service)
//
// Shapes follow docs/research/oauth.md (Google OIDC discovery document, Gmail
// and Calendar discovery documents, RFC 6749 token responses). Every token,
// id and address below is made up.

export const GOOGLE_TEST_CLIENT = {
  clientId: 'synthetic-client-id.apps.googleusercontent.com',
  clientSecret: 'synthetic-google-client-secret',
}

export const GOOGLE_SUB = '109876543210987654321'
export const GOOGLE_EMAIL = 'owner.synthetic@gmail.com'

const b64url = (v: unknown) =>
  Buffer.from(JSON.stringify(v)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Unsigned-looking JWT with a synthetic signature segment. */
export function syntheticJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'RS256', kid: 'synthetic', typ: 'JWT' })}.${b64url(payload)}.c3ludGhldGljLXNpZ25hdHVyZQ`
}

export function googleIdToken(now: Date, overrides: Record<string, unknown> = {}): string {
  const iat = Math.floor(now.getTime() / 1000)
  return syntheticJwt({
    iss: 'https://accounts.google.com',
    azp: GOOGLE_TEST_CLIENT.clientId,
    aud: GOOGLE_TEST_CLIENT.clientId,
    sub: GOOGLE_SUB,
    email: GOOGLE_EMAIL,
    email_verified: true,
    iat,
    exp: iat + 3600,
    ...overrides,
  })
}

export const GOOGLE_ALL_SCOPES_GRANTED =
  'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly'

/** Granular consent: the owner unticked Gmail. */
export const GOOGLE_CALENDAR_ONLY_GRANTED =
  'https://www.googleapis.com/auth/calendar.events.readonly openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.calendarlist.readonly'

export function googleExchangeResponse(now: Date, scope = GOOGLE_ALL_SCOPES_GRANTED) {
  return {
    access_token: 'ya29.synthetic-access-token-1',
    expires_in: 3599,
    refresh_token: '1//synthetic-refresh-token-1',
    scope,
    token_type: 'Bearer',
    id_token: googleIdToken(now),
  }
}

export const googleRefreshResponse = {
  access_token: 'ya29.synthetic-access-token-2',
  expires_in: 3599,
  scope: GOOGLE_ALL_SCOPES_GRANTED,
  token_type: 'Bearer',
}

export const googleInvalidGrant = {
  error: 'invalid_grant',
  error_description: 'Token has been expired or revoked.',
}

export const googleInvalidClient = {
  error: 'invalid_client',
  error_description: 'The OAuth client was not found.',
}

export const gmailProfile = {
  emailAddress: GOOGLE_EMAIL,
  messagesTotal: 12345,
  threadsTotal: 6789,
  historyId: '4815162342',
}

export const googleUserinfo = { sub: GOOGLE_SUB, email: GOOGLE_EMAIL, email_verified: true }

export const googleCalendarList = {
  kind: 'calendar#calendarList',
  etag: '"synthetic"',
  nextPageToken: 'synthetic-page',
  items: [{ kind: 'calendar#calendarListEntry', id: 'primary-synthetic', accessRole: 'owner' }],
}

export const googleUnauthenticated = {
  error: {
    code: 401,
    message: 'Request had invalid authentication credentials. Expected OAuth 2 access token.',
    errors: [{ message: 'Invalid Credentials', domain: 'global', reason: 'authError' }],
    status: 'UNAUTHENTICATED',
  },
}

export const googleInsufficientScope = {
  error: {
    code: 403,
    message: 'Request had insufficient authentication scopes.',
    errors: [{ message: 'Insufficient Permission', domain: 'global', reason: 'insufficientPermissions' }],
    status: 'PERMISSION_DENIED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
        domain: 'googleapis.com',
      },
    ],
  },
}

export const googleUserRateLimit = {
  error: {
    code: 403,
    message: 'User-rate limit exceeded.',
    errors: [{ message: 'User-rate limit exceeded.', domain: 'usageLimits', reason: 'userRateLimitExceeded' }],
    status: 'PERMISSION_DENIED',
  },
}

export const googleApiDisabled = {
  error: {
    code: 403,
    message: 'Gmail API has not been used in project 000000000000 before or it is disabled.',
    errors: [{ message: 'Access Not Configured.', domain: 'usageLimits', reason: 'accessNotConfigured' }],
    status: 'PERMISSION_DENIED',
  },
}

export const googleTooManyRequests = {
  error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' },
}

export const googleUnavailable = {
  error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' },
}
