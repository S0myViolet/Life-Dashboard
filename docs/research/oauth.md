# Research notes: Google and Microsoft OAuth for read-only mail/calendar in a private personal web app (Gmail/Google Calendar incremental sync, Microsoft identity platform v2.0 and Graph delta queries)

_Collected 2026-09-24 via web research (single pass, not yet re-verified). Sources are linked per fact. The build container itself cannot reach these hosts._

## Corrections and surprises

- WebFetch was blocked by the egress proxy for developers.google.com, support.google.com and learn.microsoft.com. Google API facts were verified against the official discovery documents (www.googleapis.com/discovery, gmail.googleapis.com/$discovery) and Google's OIDC discovery document. Microsoft facts were verified against the official source repositories of the Learn docs (raw.githubusercontent.com/microsoftgraph/microsoft-graph-docs-contrib and MicrosoftDocs/entra-docs). Google OAuth-guide and policy facts (access_type, prompt, 7-day Testing expiry, personal-use exception, unverified-app screen) come only from search-engine snippets of the official pages, so they are marked secondary-source.
- Graph v1.0 documents only /me/calendarView/delta (the default calendar). Per-calendar delta (/me/calendars/{id}/calendarView/delta) and unbounded /me/events/delta are documented only in beta. For multiple Outlook calendars, either use the beta endpoints or run a v1.0 calendarView delta only on the default calendar.
- Graph calendarView delta does not support $select, $filter, $orderby, $search or $expand. The start and end range is fixed for a sync round, so a rolling window needs a fresh initial sync whenever the window moves.
- Outlook delta tokens (message, mailFolder, event) have no fixed lifetime; it depends on the size of an internal cache (not 7 days). The docs name two resync signals: 410 Gone with a Location header (tenant maintenance or migration) and a '40X-series' error with code syncStateNotFound on expiry. Handle both instead of assuming 410 only.
- The least-privileged permission for message delta is Mail.ReadBasic, but Mail.Read is needed for message bodies and previews.
- Google Calendar events.list with syncToken forbids timeMin, timeMax, q, orderBy, updatedMin, iCalUID and the extended-property filters, and forbids showDeleted=false (deleted events are always returned). singleEvents is allowed but must match the initial sync. So a windowed initial fetch (timeMin/timeMax) cannot produce a usable incremental sync. The initial full sync must be unbounded.
- Gmail 'q' and format=full cannot be used with the gmail.metadata scope. For search or bodies, use gmail.readonly, which is a Restricted scope.
- Testing publishing status gives 7-day refresh tokens whenever non-basic scopes such as Gmail or Calendar are requested. For a long-lived personal dashboard, switch to 'In production' and rely on the personal-use exception (fewer than 100 users known to you). Users will still see the 'Google hasn't verified this app' screen and must click Advanced, then 'Go to {app} (unsafe)'.
- Google now documents optional DPoP-bound refresh tokens (DPoP Adoption Guide). They are optional, but if adopted every later token-endpoint call needs a DPoP proof and must handle the DPoP-Nonce header.
- Microsoft SPA-registered redirect URIs cap refresh tokens at 24 hours, and tokens refreshed from them keep that expiry. Register the Next.js server callback as platform 'Web' (confidential client with client_secret) to get the 90-day replace-on-use refresh tokens. Client secrets expire after at most 24 months.

## Facts

### Google OAuth endpoints (from Google's OIDC discovery document) **(load-bearing)**

authorization_endpoint: https://accounts.google.com/o/oauth2/v2/auth ; token_endpoint: https://oauth2.googleapis.com/token ; revocation_endpoint: https://oauth2.googleapis.com/revoke ; userinfo_endpoint: https://openidconnect.googleapis.com/v1/userinfo ; scopes_supported: openid, email, profile

Source: https://accounts.google.com/.well-known/openid-configuration · confidence: verified-official-doc

### Gmail read-only scope strings **(load-bearing)**

https://www.googleapis.com/auth/gmail.readonly = "View your email messages and settings"; https://www.googleapis.com/auth/gmail.metadata = "View your email message metadata such as labels and headers, but not the email body". Both are accepted by users.history.list, users.messages.list, users.messages.get.

Source: https://gmail.googleapis.com/$discovery/rest?version=v1 · confidence: verified-official-doc

### Google Calendar read-only scope strings exist exactly as named **(load-bearing)**

https://www.googleapis.com/auth/calendar.calendarlist.readonly (calendarList read-only); https://www.googleapis.com/auth/calendar.events.readonly (events read-only); also https://www.googleapis.com/auth/calendar.readonly (all read-only), calendar.events.owned.readonly, calendar.calendars.readonly, calendar.settings.readonly. calendarList.list accepts: calendar, calendar.calendarlist, calendar.calendarlist.readonly, calendar.readonly. events.list accepts: calendar, calendar.app.created, calendar.events, calendar.events.freebusy, calendar.events.owned, calendar.events.owned.readonly, calendar.events.public.readonly, calendar.events.readonly, calendar.readonly.

Source: https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest · confidence: verified-official-doc

### Recommended Google scope string for this app **(load-bearing)**

scope="openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly" (space-delimited). All scope names verified from discovery docs; combination is a design choice.

Source: https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest · confidence: verified-official-doc

### Scope sensitivity classification: gmail.readonly and gmail.metadata are Restricted; Calendar read scopes are Sensitive

Restricted scopes require restricted-scope verification and (if data is stored/transmitted on servers) a security assessment unless an exception applies. Could not open the scopes table directly; classification is from search snippets plus long-standing Google docs.

Source: https://developers.google.com/workspace/gmail/api/auth/scopes · confidence: secondary-source

### Google authorization request parameters for offline access **(load-bearing)**

GET https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=...&response_type=code&scope=...&access_type=offline&include_granted_scopes=true&prompt=consent&state=... ; access_type values: online|offline (offline returns refresh_token on the first code exchange); prompt is a space-delimited, case-sensitive list: none | consent | select_account; prompt=consent forces the consent screen every time and is the documented way to get a new refresh token again; include_granted_scopes=true enables incremental authorization.

Source: https://developers.google.com/identity/protocols/oauth2/web-server · confidence: secondary-source

### Google token refresh and revoke request format **(load-bearing)**

Refresh: POST https://oauth2.googleapis.com/token, Content-Type: application/x-www-form-urlencoded, body client_id, client_secret, grant_type=refresh_token, refresh_token. Revoke: POST https://oauth2.googleapis.com/revoke with token=<access or refresh token>, Content-Type: application/x-www-form-urlencoded; 200 on success, 400 on error; revoking an access token also revokes its refresh token; the revoke endpoint has no CORS support (call it server-side).

Source: https://developers.google.com/identity/protocols/oauth2/web-server · confidence: secondary-source

### Granular consent: users may grant only some of the requested scopes **(load-bearing)**

Check the 'scope' field of the token response and turn off the features whose scopes were denied (for example, Gmail denied but Calendar granted).

Source: https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions · confidence: secondary-source

### Refresh tokens expire after 7 days when the app is in Testing **(load-bearing)**

"A Google Cloud Platform project with an OAuth consent screen configured for an external user type and a publishing status of 'Testing' is issued a refresh token expiring in 7 days, unless the only OAuth scopes requested are a subset of name, email address, and user profile (through the userinfo.email, userinfo.profile, openid scopes, or their OpenID Connect equivalents)." Because Gmail/Calendar scopes are requested, the tokens expire in 7 days. Fix: set publishing status to 'In production'. Other limits: 100 refresh tokens per Google Account per OAuth client ID (the oldest is silently invalidated); a token unused for 6 months expires.

Source: https://developers.google.com/identity/protocols/oauth2 · confidence: secondary-source

### Personal-use exception to verification (fewer than 100 users) and the unverified-app screen **(load-bearing)**

Verification is not needed for personal use: an app not shared with anyone else, or used by fewer than 100 people all known personally to you. Those users click through the unverified-app warning. An unverified app that requests sensitive or restricted scopes shows the unverified-app screen before the consent screen and is capped at 100 new users. The screen reads "Google hasn't verified this app"; to continue, click 'Advanced' then 'Go to {app name} (unsafe)'. Apps in development, testing or staging are also exempt from verification but still show the screen and the 100-user cap.

Source: https://support.google.com/cloud/answer/13464323?hl=en · confidence: secondary-source

### Gmail users.history.list: endpoint, parameters and 404 means full sync **(load-bearing)**

GET https://gmail.googleapis.com/gmail/v1/users/{userId}/history?startHistoryId=...&historyTypes=messageAdded&historyTypes=messageDeleted&historyTypes=labelAdded&historyTypes=labelRemoved&labelId=...&maxResults(default 100, max 500)&pageToken=... Verbatim: "Supplying an invalid or out of date startHistoryId typically returns an HTTP 404 error code. A historyId is typically valid for at least a week, but in some rare circumstances may be valid for only a few hours. If you receive an HTTP 404 error response, your application should perform a full sync. If you receive no nextPageToken in the response, there are no updates to retrieve and you can store the returned historyId for a future request."

Source: https://gmail.googleapis.com/$discovery/rest?version=v1 · confidence: verified-official-doc

### Baseline historyId from users.getProfile

GET https://gmail.googleapis.com/gmail/v1/users/me/profile returns historyId ("The ID of the mailbox's current history record."). ListHistoryResponse.historyId has the same meaning.

Source: https://gmail.googleapis.com/$discovery/rest?version=v1 · confidence: verified-official-doc

### Gmail users.messages.list parameters **(load-bearing)**

GET https://gmail.googleapis.com/gmail/v1/users/{userId}/messages ; q: "Only return messages matching the specified query. Supports the same query format as the Gmail search box... Parameter cannot be used when accessing the api using the gmail.metadata scope." labelIds (repeatable): "Only return messages with labels that match all of the specified label IDs." includeSpamTrash: "Include messages from SPAM and TRASH in the results." (default false); maxResults default 100, max 500; pageToken. The response lists only id and threadId, so use messages.get for details. messages.get format: full | metadata | minimal | raw (format=full is not allowed with gmail.metadata); metadataHeaders works with format=metadata.

Source: https://gmail.googleapis.com/$discovery/rest?version=v1 · confidence: verified-official-doc

### Google Calendar events.list syncToken rules and 410 GONE **(load-bearing)**

GET https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events. syncToken (verbatim): "All events deleted since the previous list request will always be in the result set and it is not allowed to set showDeleted to False. There are several query parameters that cannot be specified together with nextSyncToken ... iCalUID, orderBy, privateExtendedProperty, q, sharedExtendedProperty, timeMin, timeMax, updatedMin. All other query parameters should be the same as for the initial synchronization to avoid undefined behavior. If the syncToken expires, the server will respond with a 410 GONE response code and the client should clear its storage and perform a full synchronization without any syncToken." The nextSyncToken arrives only on the last page. maxResults default 250, max 2500.

Source: https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest · confidence: verified-official-doc

### Calendar showDeleted and singleEvents behavior (singleEvents is allowed with syncToken) **(load-bearing)**

showDeleted: "Cancelled instances of recurring events (but not the underlying recurring event) will still be included if showDeleted and singleEvents are both False. If showDeleted and singleEvents are both True, only single instances of deleted events (but not the underlying recurring events) are returned." singleEvents is not on the syncToken-forbidden list, but it must match the initial full sync. Because timeMin and timeMax are forbidden with syncToken, a windowed initial sync (timeMin/timeMax) cannot be continued incrementally. The initial sync must leave out timeMin and timeMax if you want a syncToken-based incremental sync.

Source: https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest · confidence: verified-official-doc

### Calendar calendarList.list sync rules

GET https://www.googleapis.com/calendar/v3/users/me/calendarList ; with syncToken, deleted and hidden entries are always returned (showDeleted/showHidden cannot be False); minAccessRole and showOwnOrganizationOnly cannot be used with syncToken; 410 GONE means full resync; maxResults default 100, max 250.

Source: https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest · confidence: verified-official-doc

### Microsoft identity platform v2.0 /common endpoints **(load-bearing)**

authorize: https://login.microsoftonline.com/common/oauth2/v2.0/authorize ; token: https://login.microsoftonline.com/common/oauth2/v2.0/token ; logout: https://login.microsoftonline.com/common/oauth2/v2.0/logout ; userinfo: https://graph.microsoft.com/oidc/userinfo ; jwks: https://login.microsoftonline.com/common/discovery/v2.0/keys ; issuer template https://login.microsoftonline.com/{tenantid}/v2.0 (validate per tenant, because with /common the tid varies). Tenant path values: common | organizations | consumers | <tenant id>.

Source: https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration · confidence: verified-official-doc

### Confidential-client auth code and refresh requests (v2.0) **(load-bearing)**

Authorize: GET .../oauth2/v2.0/authorize?client_id=...&response_type=code&redirect_uri=...&response_mode=query&scope=...&state=...&code_challenge=...&code_challenge_method=S256 (prompt: login|none|consent|select_account). Redeem: POST /{tenant}/oauth2/v2.0/token, Content-Type: application/x-www-form-urlencoded, body client_id, scope, code, redirect_uri, grant_type=authorization_code, code_verifier, client_secret ("The client secret must be URL-encoded before being sent"). Refresh: grant_type=refresh_token, refresh_token, client_id, client_secret, scope. Response fields: access_token, token_type=Bearer, expires_in (e.g. 3599), scope, refresh_token ("Only provided if offline_access scope was requested"), id_token.

Source: https://raw.githubusercontent.com/MicrosoftDocs/entra-docs/main/docs/identity-platform/v2-oauth2-auth-code-flow.md · confidence: verified-official-doc

### Microsoft scopes: offline_access openid profile email plus Graph Mail.Read Calendars.Read User.Read **(load-bearing)**

scope="openid profile email offline_access User.Read Mail.Read Calendars.Read". If the resource prefix is left off, the scope means Microsoft Graph (User.Read equals https://graph.microsoft.com/User.Read). The app must request offline_access explicitly to get refresh tokens; the consent screen shows it as "Maintain access to data you have given it access to". You cannot combine .default with dynamic scopes in one request.

Source: https://raw.githubusercontent.com/MicrosoftDocs/entra-docs/main/docs/identity-platform/scopes-oidc.md · confidence: verified-official-doc

### Graph permissions for the delta APIs

message: delta least privileged delegated = Mail.ReadBasic (higher: Mail.Read, Mail.ReadWrite), for both work/school and personal Microsoft accounts. Mail.Read is needed for bodies. event: delta (calendarView) least privileged delegated = Calendars.Read (work/school and personal).

Source: https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-docs-contrib/main/api-reference/v1.0/includes/permissions/message-delta-permissions.md · confidence: verified-official-doc

### Microsoft refresh token lifetime **(load-bearing)**

"The default lifetime for the refresh tokens are as follows: 24 hours for single-page applications. 24 hours for apps that use email one-time passcode authentication flow. 90 days for all other scenarios." "Refresh tokens replace themselves with a fresh token upon every use." "Refresh tokens sent to a redirect URI registered as spa expire after 24 hours. Additional refresh tokens acquired using the initial refresh token carry over that expiration time." So register the redirect URI as platform 'Web' (confidential client) and store the rotated refresh token after every refresh. The docs do not use the word 'sliding'; treating the 90 days as effectively sliding comes from the replace-on-use behavior. Revocation triggers include password change/reset, admin or user revocation, and sign-out.

Source: https://raw.githubusercontent.com/MicrosoftDocs/entra-docs/main/docs/identity-platform/refresh-tokens.md · confidence: verified-official-doc

### Client secret maximum lifetime

"Client secret lifetime is limited to two years (24 months) or less." Microsoft recommends less than 12 months. The secret value is "never displayed again after you leave this page". Supported account type for /common with personal accounts: 'Any Entra ID Tenant + Personal Microsoft accounts'.

Source: https://raw.githubusercontent.com/MicrosoftDocs/entra-docs/main/docs/identity-platform/how-to-add-credentials.md · confidence: verified-official-doc

### Graph message delta (per folder) **(load-bearing)**

GET https://graph.microsoft.com/v1.0/me/mailFolders/{id}/messages/delta (a well-known name can replace {id}, e.g. /me/mailFolders/inbox/messages/delta). Optional ?changeType=created|updated|deleted. Supported: $select, $top, $expand. Limited: $filter only receivedDateTime+ge or receivedDateTime+gt; $orderby only receivedDateTime+desc. Not supported: $search. "Delta query is a per-folder operation. To track the changes of the messages in a folder hierarchy, you need to track each folder individually." Deleted or moved-out items come back as "@removed": {"reason": "deleted"}. Headers: Authorization: Bearer {token}; Prefer: odata.maxpagesize={x}. The delta may return entries outside your $filter, so handle them.

Source: https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-docs-contrib/main/api-reference/v1.0/api/message-delta.md · confidence: verified-official-doc

### Graph mailFolder delta **(load-bearing)**

GET https://graph.microsoft.com/v1.0/me/mailFolders/delta (also /users/{id}/mailFolders/delta); params $deltatoken, $skiptoken, $select; "If you use any query parameter (other than $deltatoken and $skiptoken), you must specify it in the initial delta request." Example header: Prefer: odata.maxpagesize=2.

Source: https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-docs-contrib/main/api-reference/v1.0/api/mailfolder-delta.md · confidence: verified-official-doc

### Graph calendarView delta and its limits (v1.0) **(load-bearing)**

GET https://graph.microsoft.com/v1.0/me/calendarView/delta?startDateTime={ISO8601}&endDateTime={ISO8601} (also /users/{id}/calendarView/delta). startDateTime and endDateTime are required on the initial request. The range is fixed for the sync round; a different range needs a new initial request. Not supported: $select, $filter, $orderby, $search, $expand. Headers: Prefer: odata.maxpagesize={x}; Prefer: outlook.timezone="..." (UTC if absent). Results can include single instances, occurrences and exceptions of recurring series. @removed (reason deleted) can include events inside or outside the range. Event delta without a fixed range (/me/events/delta, /me/calendars/{id}/events/delta) and /me/calendars/{id}/calendarView/delta are documented only in beta.

Source: https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-docs-contrib/main/api-reference/v1.0/api/event-delta.md · confidence: verified-official-doc

### @odata.nextLink vs @odata.deltaLink and paging rules **(load-bearing)**

Each delta response has either @odata.nextLink (contains $skiptoken; more pages in this round) or @odata.deltaLink (contains $deltatoken; round finished, save it for the next sync). Request the whole nextLink or deltaLink URL as-is: "Don't try to extract the $skiptoken or $skip value and use it in a different request."

Source: https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-docs-contrib/main/concepts/delta-query-overview.md · confidence: verified-official-doc

### Delta token expiry and resync handling (410 Gone, syncStateNotFound) **(load-bearing)**

"Delta query can return a response code of 410 Gone and a Location header containing a request URL with an empty $deltatoken (same as the initial query)... an indication that the application must restart with a full synchronization." "In case the token expires, the service should respond with a 40X-series error with error codes such as syncStateNotFound." Outlook entities (message, mailFolder, event): "the upper limit isn't fixed; it's dependent on the size of the internal delta token cache" (directory objects are 7 days). Handling: on 410, or on any 4xx whose error.code is syncStateNotFound (compare case-insensitively), drop the stored deltaLink and restart from the base delta URL.

Source: https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-docs-contrib/main/concepts/delta-query-overview.md · confidence: verified-official-doc

### Graph throttling: 429 with Retry-After, and Outlook per-mailbox limits **(load-bearing)**

Throttled requests get HTTP 429 Too Many Requests with a Retry-After: <seconds> header and error.code "TooManyRequests". "Wait the number of seconds specified in the Retry-After header"; if there is no Retry-After, use exponential backoff. 503 can also carry Retry-After. Outlook limits per app ID and mailbox pair: 10,000 API requests per 10 minutes; 4 concurrent requests; 150 MB upload per 5 minutes (v1.0 and beta). Global limit: 130,000 requests per 10 seconds per app across all tenants.

Source: https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-docs-contrib/main/concepts/throttling.md · confidence: verified-official-doc

### Maximum value for Prefer: odata.maxpagesize on message and calendarView delta

The delta docs mark the header optional and give no maximum or default page size (the examples use 2). The server may return fewer items. Do not assume a specific maximum.

Source: https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-docs-contrib/main/concepts/delta-query-messages.md · confidence: unverified
