// SYNTHETIC FIXTURE (not captured from the live service)
//
// Shapes follow docs/research/oauth.md (Microsoft identity platform v2.0 auth
// code flow docs and Microsoft Graph docs). Every token, id and address below
// is made up.
import { syntheticJwt } from './google.ts'

export const MICROSOFT_TEST_CLIENT = {
  clientId: '00000000-1111-2222-3333-444444444444',
  clientSecret: 'synthetic~secret.value_with+chars=',
}

export const MS_PERSONAL_ID = '0123456789abcdef'
export const MS_WORK_ID = '6f1d2c3b-aaaa-bbbb-cccc-123456789abc'
export const MS_EMAIL = 'owner.synthetic@outlook.com'

export const MS_ALL_SCOPES_GRANTED =
  'openid profile email https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read'

/** Calendar permission not granted (e.g. declined or blocked by policy). */
export const MS_NO_CALENDAR_GRANTED =
  'openid profile email https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read'

export function msIdToken(tid: string): string {
  return syntheticJwt({
    aud: MICROSOFT_TEST_CLIENT.clientId,
    iss: `https://login.microsoftonline.com/${tid}/v2.0`,
    tid,
    oid: '00000000-0000-0000-0000-00000000abcd',
    preferred_username: MS_EMAIL,
    exp: 4102444800,
  })
}

export function msExchangeResponse(opts: { tid?: string; scope?: string; refresh?: string } = {}) {
  return {
    token_type: 'Bearer',
    scope: opts.scope ?? MS_ALL_SCOPES_GRANTED,
    expires_in: 3599,
    ext_expires_in: 3599,
    access_token: 'EwB4A8l6BAAUsynthetic-access-1',
    refresh_token: opts.refresh ?? 'M.C507_BAY.0.U.-synthetic-refresh-1',
    id_token: msIdToken(opts.tid ?? '9188040d-6c67-4c5b-b112-36a304b66dad'),
  }
}

export function msRefreshResponse(n: number) {
  return {
    token_type: 'Bearer',
    scope: MS_ALL_SCOPES_GRANTED,
    expires_in: '3599',
    ext_expires_in: 3599,
    access_token: `EwB4A8l6BAAUsynthetic-access-${n}`,
    refresh_token: `M.C507_BAY.0.U.-synthetic-refresh-${n}`,
  }
}

export const msInvalidGrant = {
  error: 'invalid_grant',
  error_description:
    'AADSTS70008: The provided authorization code or refresh token has expired due to inactivity. Trace ID: 00000000-0000-0000-0000-000000000000',
  error_codes: [70008],
  timestamp: '2026-09-24 10:00:00Z',
  trace_id: '00000000-0000-0000-0000-000000000000',
  correlation_id: '00000000-0000-0000-0000-000000000001',
}

export const msInvalidClient = {
  error: 'invalid_client',
  error_description: 'AADSTS7000215: Invalid client secret provided.',
  error_codes: [7000215],
}

export const msMePersonal = {
  '@odata.context':
    'https://graph.microsoft.com/v1.0/$metadata#users(id,displayName,mail,userPrincipalName)/$entity',
  id: MS_PERSONAL_ID,
  displayName: 'Synthetic Owner',
  mail: null,
  userPrincipalName: MS_EMAIL,
}

export const msMeWork = {
  id: MS_WORK_ID,
  displayName: 'Synthetic Owner',
  mail: 'Owner.Synthetic@Example.org',
  userPrincipalName: 'owner.synthetic@example.org',
}

export const graphInvalidToken = {
  error: {
    code: 'InvalidAuthenticationToken',
    message: 'Access token has expired or is not yet valid.',
    innerError: {
      date: '2026-09-24T10:00:00',
      'request-id': 'synthetic',
      'client-request-id': 'synthetic',
    },
  },
}

export const graphAccessDenied = {
  error: {
    code: 'ErrorAccessDenied',
    message: 'Access is denied. Check credentials and try again.',
  },
}

export const graphTooManyRequests = {
  error: { code: 'TooManyRequests', message: 'Please retry after 10 seconds.' },
}

export const graphServiceUnavailable = {
  error: { code: 'serviceNotAvailable', message: 'Service unavailable.' },
}
