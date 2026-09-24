# Research notes: Third-party providers for later milestones: Lunch Flow, WHOOP v2, Spotify Web API (2026 changes), football-data.org v4, TradingView widgets, RSS feeds

_Collected 2026-09-24 via web research (single pass, not yet re-verified). Sources are linked per fact. The build container itself cannot reach these hosts._

## Corrections and surprises

- Environment limitation: WebFetch was blocked by the egress proxy for almost every official doc domain (lunchflow.app, developer.whoop.com, developer.spotify.com, football-data.org, tradingview.com, openai.com, deepmind.google, blog.google, uefa.com, liverpoolfc.com), and the 200-call WebSearch budget ran out before the RSS checks were finished. Most facts therefore come from search-result summaries of official pages, or from GitHub (vendor repos and third-party mirrors), and are marked secondary-source. The only official material read directly was Lunch Flow's own GitHub repos.
- Lunch Flow base URL conflict: the official MCP server and the changelog use https://lunchflow.app/api/v1, but Lunch Flow's own actual-flow client defaults to https://api.lunchflow.com. Make the base URL configurable.
- The £4.99/month with 4 connections price could not be verified. The site only says 'less than a coffee per month' and 'Monthly plans start at 4 connections, yearly at 2 (for a limited time)'. HSBC UK personal coverage was also not confirmed; only Revolut has a coverage page.
- Lunch Flow syncs daily, not in real time, and publishes no rate limits.
- Spotify changed more after February 2026 than the brief assumes: March 2026 reverted the removal of external_ids and postponed endpoint-access changes for existing Dev Mode apps; May 2026 added account_id; June 2026 introduced 6-month refresh-token expiry (effective 2026-07-20 for existing apps, invalid_grant on expiry); July 2026 raised Client IDs from 1 to 25 per developer, made quota shared per developer account, and added 429 reason QUOTA_EXCEEDED.
- The Get Artist's Albums limit cut (now default 5, max 10) is credited by a third party to July 2026, not the February 2026 changelog. The confirmed February change is Search: max 50 -> 10, default 20 -> 5.
- Spotify Dev Mode now requires the app owner to have Premium and caps each app at 5 users. The Developer Policy forbids ingesting Spotify Content into any ML/AI model, so Spotify data must not go to an LLM summary feature.
- WHOOP v2 IDs are mixed: sleep and workout IDs are UUID strings, but cycle IDs are still int64. v2 recovery webhooks carry the sleep UUID. workout.sport_id stopped existing after 2025-09-01; use sport_name. Collection limit max is 25.
- WHOOP app approval has multi-month backlogs in 2026. The 10-member cap for unapproved apps is fine for a single-user dashboard.
- TradingView moved Market Overview to a new Web Component format in 2026, replacing the legacy Market Overview and Stock Market widgets. The legacy script embed still exists. Widget data for exchange symbols is delayed, and FOREXCOM:SPXUSD is a CFD, not the cash index.
- Anthropic has no official RSS feed. A community-generated feed on GitHub is current as of 2026-09-24.

## Facts

### Lunch Flow Personal API base URL is https://lunchflow.app/api/v1 and auth is an API key sent in the x-api-key header **(load-bearing)**

Official lunchflow/mcp src/index.ts: base URL constant "https://lunchflow.app/api/v1", header "X-API-Key": config.apiKey. Lunch Flow changelog (search snippet): curl https://lunchflow.app/api/v1/accounts -H "x-api-key: YOUR_API_KEY". The key comes from an 'API destination' in the Lunch Flow dashboard (lunchflow.app/destinations). HTTP header names are case-insensitive.

Source: https://raw.githubusercontent.com/lunchflow/mcp/main/src/index.ts · confidence: verified-official-doc

### Lunch Flow's own actual-flow client uses a different default base URL (https://api.lunchflow.com) and an include_pending query param **(load-bearing)**

lunchflow/actual-flow src/config-manager.ts default baseUrl 'https://api.lunchflow.com'; src/lunch-flow-client.ts uses GET /accounts and GET /accounts/{accountId}/transactions with header x-api-key and query include_pending=true. It has a 60s timeout and 3 retries with backoff. Make the base URL configurable. Prefer https://lunchflow.app/api/v1, which the MCP server and the changelog both use.

Source: https://raw.githubusercontent.com/lunchflow/actual-flow/main/src/lunch-flow-client.ts · confidence: verified-official-doc

### Lunch Flow endpoints: list accounts, account transactions, account balance (all GET, read-only) **(load-bearing)**

From the ts-rest contract: GET /accounts -> {accounts: Account[]}; GET /accounts/:accountId/transactions -> {transactions: Transaction[]}; GET /accounts/:accountId/balance -> {balance: Balance}. accountId is numeric. Errors: 401 Unauthorized, 403 InvalidApiKey, 404 AccountNotFound (per-account routes), 500. Account fields: id, name, institution_name, institution_logo, provider enum ['gocardless','quiltt','finverse','pluggy','lunchmoney','simplefin','stripe','akahu'] (this list may be stale), currency, status optional enum ['ACTIVE','DISCONNECTED','ERROR']. Transaction fields: id, account_id, date, amount (z.number()), currency?, description, merchant_name?, category?, pending?. Balance: available, current, currency. The contract has no query params.

Source: https://raw.githubusercontent.com/lunchflow/mcp/main/src/contracts/api-destination-contract.ts · confidence: verified-official-doc

### Lunch Flow Personal API also has a holdings endpoint for brokerage accounts

Search snippets of the Personal API overview list 'get account holdings'. The Rust crate's get_holdings() returns HoldingsNotSupported for non-brokerage accounts. The exact path (probably /accounts/{id}/holdings) is not confirmed.

Source: https://www.lunchflow.app/docs/api/personal-api-overview · confidence: unverified

### Lunch Flow pricing: 7-day free trial, 'less than a coffee per month'; 'Monthly plans start at 4 connections, yearly at 2 (for a limited time)'. The exact £4.99/month figure could not be verified

The lunchflow.app homepage text came through search snippets only; WebFetch to lunchflow.app was blocked. No source confirmed £4.99. One third-party snippet quoted $2.92/month (annual) with 2 connections, which is unreliable. Check the price at checkout before relying on it.

Source: https://www.lunchflow.app/ · confidence: secondary-source

### Lunch Flow coverage: 25,000+ institutions in 40+ countries through aggregators (MX, GoCardless, Finicity, SnapTrade, Finverse, Pluggy, etc.). Revolut has a coverage page; HSBC UK personal is not confirmed **(load-bearing)**

The coverage page for Revolut is https://www.lunchflow.app/coverage/revolut. No HSBC UK coverage page came up in searches. Check with the search tool at https://www.lunchflow.app/coverage before committing. UK banks are routed via GoCardless (Bank Account Data).

Source: https://www.lunchflow.app/coverage/revolut · confidence: secondary-source

### Lunch Flow syncs transactions and balances once a day, not in real time

lunchflow.app integration pages (search snippet): 'transactions and balances sync every day'. No Personal API rate limits are documented, and a public feedback item asks for rate-limit docs and Retry-After headers (feedback.lunchflow.app/p/document-rate-limit-handling-and-implement-retry-after-headers). Poll at most a few times a day.

Source: https://www.lunchflow.app/features/actual-budget-integration · confidence: secondary-source

### WHOOP OAuth 2.0 URLs and scopes **(load-bearing)**

Authorize: https://api.prod.whoop.com/oauth/oauth2/auth ; Token: https://api.prod.whoop.com/oauth/oauth2/token . Scopes (space-delimited): read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement offline. The 'offline' scope is required to get a refresh token. The state param must be 8 characters long.

Source: https://developer.whoop.com/docs/developing/oauth/ · confidence: secondary-source

### WHOOP token refresh request and rotation **(load-bearing)**

POST https://api.prod.whoop.com/oauth/oauth2/token with grant_type=refresh_token, client_id, client_secret, scope=offline, refresh_token. The response has access_token, refresh_token, expires_in, scope, token_type 'bearer'. Using the refresh token invalidates existing access tokens, and a new refresh_token is returned, so persist it every time.

Source: https://developer.whoop.com/docs/tutorials/refresh-token-javascript/ · confidence: secondary-source

### WHOOP v2 REST endpoints (base https://api.prod.whoop.com/developer, Authorization: Bearer <token>) **(load-bearing)**

GET /v2/recovery (read:recovery); GET /v2/cycle, /v2/cycle/{cycleId}, /v2/cycle/{cycleId}/recovery, /v2/cycle/{cycleId}/sleep (read:cycles); GET /v2/activity/sleep, /v2/activity/sleep/{sleepId} (read:sleep); GET /v2/activity/workout, /v2/activity/workout/{workoutId} (read:workout); GET /v2/user/profile/basic (read:profile: user_id, email, first_name, last_name); GET /v2/user/measurement/body (read:body_measurement: height_meter, weight_kilogram, max_heart_rate); DELETE /v2/user/access (revoke). Full paths are /developer/v2/recovery etc. Sleep and workout IDs are UUID strings; cycle IDs are still int64. Cycle 'end' is absent while the user is in the current cycle.

Source: https://github.com/api-evangelist/whoop-co/tree/main/openapi · confidence: secondary-source

### WHOOP collection pagination uses the nextToken query param and a next_token response field; limit max 25 **(load-bearing)**

Query params: limit (int, default 10, max 25), start (ISO 8601 date-time, inclusive), end (ISO 8601, exclusive, defaults to now), nextToken. Response: { records: [...], next_token: "..." }. Pass next_token back as ?nextToken= until it is absent. Recovery is sorted by the related sleep's start time, descending.

Source: https://developer.whoop.com/docs/developing/pagination/ · confidence: secondary-source

### WHOOP score_state enum: SCORED | PENDING_SCORE | UNSCORABLE **(load-bearing)**

Only read .score when score_state === 'SCORED'. PENDING_SCORE means check back later. UNSCORABLE means no score will ever be produced. Recovery score fields: user_calibrating, recovery_score, resting_heart_rate, hrv_rmssd_milli, spo2_percentage, skin_temp_celsius. Sleep score fields: stage_summary, sleep_needed, respiratory_rate, sleep_performance_percentage, sleep_consistency_percentage, sleep_efficiency_percentage. Cycle score fields: strain, kilojoule, average_heart_rate, max_heart_rate.

Source: https://developer.whoop.com/docs/developing/user-data/recovery/ · confidence: secondary-source

### WHOOP rate limits: 100 requests/minute and 10,000 requests/day

Headers: X-RateLimit-Limit (e.g. "100, 100;window=60, 10000;window=86400"), X-RateLimit-Remaining, X-RateLimit-Reset (seconds until reset).

Source: https://developer.whoop.com/docs/developing/rate-limiting/ · confidence: secondary-source

### WHOOP v1 deprecation: migration required by October 1, 2025; v1 API and v1 webhooks removed

Quote relayed in a third-party README: 'WHOOP v2 API is now available and migration is required by October 1, 2025. The current v1 API and webhooks will be removed after this date.' The official changelog and migration guide (via search) say v1 is no longer supported and v1 webhooks are no longer published. v2 recovery webhooks use the UUID of the associated sleep, not the cycle ID. An Activity ID Mapping endpoint looks up v2 UUIDs for old v1 IDs.

Source: https://developer.whoop.com/docs/developing/v1-v2-migration/ · confidence: secondary-source

### WHOOP workout sport_id is deprecated; use sport_name

The v2 workout schema describes sport_id as 'Will not exist past 09/01/2025'. Use sport_name (e.g. 'running').

Source: https://raw.githubusercontent.com/api-evangelist/whoop-co/main/openapi/whoop-co-workout-api-openapi.yml · confidence: secondary-source

### WHOOP apps that are not approved are limited to 10 WHOOP members; approval is needed to go beyond that

'Apps can be used for development immediately with a limit of 10 WHOOP members.' Approval requires testing with at least 1 member, correct app name, contact email and privacy policy URL, and following the WHOOP brand guidelines. A personal dashboard (1 user) fits inside the limit. WHOOP Community threads in 2026 report approval requests going months without a response.

Source: https://developer.whoop.com/docs/developing/app-approval/ · confidence: secondary-source

### Spotify Development Mode rules (announced 2026-02-06): the app owner must have Spotify Premium, each app is capped at 5 authorized users, and endpoint access is reduced **(load-bearing)**

Blog 'Update on Developer Access and Platform Security'. It applied to new Dev Mode Client IDs from 2026-02-11 and to existing ones from 2026-03-09. The endpoint-access changes for existing integrations were later postponed; the Premium requirement, the user cap and the Client ID limit went ahead as planned. The original limit was 1 Dev Mode Client ID per developer, raised to 25 on 2026-07-23. Extended Quota Mode apps are unaffected.

Source: https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security · confidence: secondary-source

### Spotify February 2026 changelog: removed endpoints **(load-bearing)**

Removed: GET /artists/{id}/top-tracks; GET /browse/new-releases; GET /browse/categories; the batch 'Get Several' endpoints GET /albums, /artists, /audiobooks, /chapters, /episodes, /shows, /tracks; GET /users/{user_id}; GET /users/{user_id}/playlists; POST /users/{user_id}/playlists. Library save/remove/check moved to a single endpoint, PUT/DELETE/GET /me/library. Playlist items are at /playlists/{id}/items. Also described as 'moving away from the Client Credentials flow for metadata endpoints'.

Source: https://developer.spotify.com/documentation/web-api/references/changes/february-2026 · confidence: secondary-source

### Spotify February 2026 changelog: removed and renamed fields, and the new Search limit **(load-bearing)**

Removed fields: available_markets, external_ids, linked_from, popularity, followers, album_group, label, publisher, country, email, explicit_content, product. Renamed: SimplifiedPlaylist.tracks and FullPlaylist.tracks -> items; PlaylistItem.track -> item. GET /search limit: max 50 -> 10, default 20 -> 5. March 2026 changelog reverted the removal of external_ids on tracks and albums.

Source: https://github.com/ramsayleung/rspotify/issues/550 · confidence: secondary-source

### Get Artist's Albums limit is now default 5, range 1-10, but it is unclear whether this changed in February or July 2026

A search snippet of the current reference page for GET /artists/{id}/albums shows default 5, max 10. A third-party PR (HA-Spotify-Browser #22) credits the 50->10 cut for get_artist_albums and search to 'Spotify's own July 2026 API changes'. I could not confirm that the February 2026 changelog lists this change.

Source: https://developer.spotify.com/documentation/web-api/reference/get-an-artists-albums · confidence: unverified

### Spotify Get User's Top Items: GET /me/top/{type}, scope user-top-read, limit max 50 **(load-bearing)**

type is artists|tracks. time_range is short_term (~4 weeks), medium_term (~6 months, the default) or long_term (~1 year, plus new data). limit: default 20, min 1, max 50. offset is also supported. Whether this endpoint stays available to new Dev Mode apps under the reduced endpoint set is not confirmed; see the migration guide.

Source: https://developer.spotify.com/documentation/web-api/reference/get-users-top-artists-and-tracks · confidence: secondary-source

### Spotify Get Recently Played Tracks: GET /me/player/recently-played, max limit 50 **(load-bearing)**

Scope user-read-recently-played. limit: default 20, min 1, max 50. after and before are Unix ms cursors and cannot be used together. Podcast episodes are not returned. Reported as still available after the February 2026 changes.

Source: https://developer.spotify.com/documentation/web-api/reference/get-recently-played · confidence: secondary-source

### Spotify refresh tokens now expire 6 months after the user's original authorization **(load-bearing)**

Blog 2026-06-18 'Introducing refresh token expiration'. Applies to Authorization Code (and PKCE) refresh tokens. Already in effect for new apps; existing apps from 2026-07-20. Refreshing the access token does not reset the timer. An expired token returns invalid_grant: discard the stored token and send the user through sign-in again, without retrying.

Source: https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration · confidence: secondary-source

### Spotify July 2026 quota changes

2026-07-23: Dev Mode Client ID limit raised from 1 to 25 per developer. Quota is now counted per developer account, shared across all Dev Mode Client IDs. When the quota is exceeded, the 429 response includes a JSON body with "reason": "QUOTA_EXCEEDED", which tells it apart from ordinary rate limits. May 2026 added account_id (a stable, pseudonymous ID) to GET /me; use it instead of id for account linking.

Source: https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates · confidence: secondary-source

### Spotify Developer Policy forbids training ML/AI models on Spotify content or ingesting it into them **(load-bearing)**

Policy text: 'Do not use the Spotify Platform or any Spotify Content to train a machine learning or AI model or otherwise ingest Spotify Content into a machine learning or AI model.' The same wording is in the Developer Terms. The 'Building with AI' page only covers using LLMs as coding tools. Do not send Spotify listening data to an LLM (e.g. for AI summaries); only display it directly.

Source: https://developer.spotify.com/policy · confidence: secondary-source

### football-data.org v4 base URL and auth header **(load-bearing)**

Base https://api.football-data.org/v4 ; header X-Auth-Token: <token>. Example: curl 'https://api.football-data.org/v4/teams/583/matches?dateFrom=2021-07-01&dateTo=2022-01-01' -H 'X-Auth-Token: UR_TOKEN'. Keep the token server-side.

Source: https://docs.football-data.org/general/v4/team.html · confidence: secondary-source

### football-data.org free tier: 12 competitions, 10 requests/minute, delayed scores and schedules **(load-bearing)**

Free tier competitions: PL, ELC, CL, EC, WC, PD, BL1, SA, FL1, DED, PPL, BSA. Data covers fixtures, results and league tables only, with no lineups or match stats. Scores and schedules are delayed; live scores need the paid Livescores add-on (about €12/month, per third-party sources). Unauthenticated clients get 100 requests per 24h and can only use the areas and competitions list. Going over the limit returns HTTP 429. Rate headers: X-Requests-Available-Minute, X-RequestCounter-Reset. Third-party sources say the free tier covers the current season only.

Source: https://docs.football-data.org/general/v4/policies.html · confidence: secondary-source

### football-data.org v4 endpoints for team matches, competition matches and standings **(load-bearing)**

GET /v4/teams/{id}/matches (filters: dateFrom, dateTo [dateTo is exclusive], status SCHEDULED|FINISHED|..., LIVE = IN_PLAY+PAUSED, season, competitions, venue, limit). GET /v4/competitions/{code}/matches (matchday, status, dateFrom, dateTo, stage, season). GET /v4/competitions/{code}/standings (season, matchday, date), e.g. /v4/competitions/PL/standings?season=2010&matchday=3. Competition codes: PL = Premier League, CL = Champions League.

Source: https://docs.football-data.org/general/v4/match.html · confidence: secondary-source

### football-data.org team id for Liverpool FC is 64 (tla LIV) **(load-bearing)**

Seen in example standings output: "team": { "id": 64, "name": "Liverpool FC" }. Endpoint: https://api.football-data.org/v4/teams/64/matches

Source: https://github.com/NearHuscarl/FootballDataAPI · confidence: secondary-source

### TradingView Market Overview widget (iframe/script format) embed shape **(load-bearing)**

<div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div><div class="tradingview-widget-copyright">...</div><script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js" async>{ "colorTheme":"dark", "dateRange":"12M", "showChart":true, "locale":"en", "width":"100%", "height":"100%", "isTransparent":false, "showSymbolLogo":true, "tabs":[{"title":"Indices","symbols":[{"s":"FOREXCOM:SPXUSD","d":"S&P 500 Index"},{"s":"FOREXCOM:NSXUSD","d":"US 100 Cash CFD"}],"originalTitle":"Indices"}] }</script></div>. The JSON goes inside the script tag. The iframe is served from www.tradingview-widget.com, so CSP needs script-src s3.tradingview.com and frame-src www.tradingview-widget.com. The key list beyond tabs/s/d/colorTheme/dateRange/showChart/locale/isTransparent was partly filled in from memory.

Source: https://www.tradingview.com/widget-docs/widgets/watchlists/market-overview/ · confidence: secondary-source

### In 2026 TradingView released a Web Component version of Market Overview that replaces the legacy Market Overview and Stock Market widgets

Web Components use a custom element with a tv- prefix and a single ES module script (e.g. Ticker Tape: <script type="module" src="https://www.tradingview-widget.com/w/en/tv-ticker-tape.js"> with <tv-ticker-tape>). The new Market Overview has a custom-symbols mode and a market-movers mode. Iframe and Web Component widgets can share a page. The exact Market Overview tag name was not confirmed.

Source: https://www.tradingview.com/widget-docs/whats-new/ · confidence: secondary-source

### FOREXCOM:SPXUSD is FOREX.com's US S&P 500 CFD, not the cash index; SP:SPX does not work in free widgets

Symbol format is EXCHANGE:TICKER. TradingView lists FOREXCOM:SPXUSD as a 'US SP 500 CFD'. Per a third-party report, SP:SPX and NASDAQ:NDX silently fall back to the widget's default symbol in free embeds, while OANDA:SPX500USD shows 'This symbol is only available at TradingView'. Label these as CFDs (e.g. 'US 500 (CFD)') in the UI.

Source: https://www.tradingview.com/symbols/FOREXCOM-SPXUSD/ · confidence: secondary-source

### Widget data is delayed for exchange symbols; forex and crypto are real-time; a paid TradingView plan does not change widget data

Data FAQ: exchanges require per-site fees, so TradingView may only stream delayed data in widgets; forex and crypto are real-time. 'Paid upgraded plans do not affect the data in the widgets.'

Source: https://www.tradingview.com/widget-docs/faq/data/ · confidence: secondary-source

### TradingView attribution must stay, and widget data must not be extracted or used for non-display purposes **(load-bearing)**

Widgets are free with default TradingView branding; attribution 'should remain as was originally designed and intended'. Links to data sources, the logo and legal links cannot be overridden, and removing branding requires contacting TradingView. The ToS prohibit automated data collection (scripts, screen scraping, data mining, robots, extraction tools) and any non-display use (automated trading, price referencing, algorithmic decisions, machine processes that do not display data to a human). TradingView has no data API. The Chrome extension and dashboard must not read prices out of widget iframes.

Source: https://www.tradingview.com/policies/ · confidence: secondary-source

### BBC News Business RSS: https://feeds.bbci.co.uk/news/business/rss.xml ; BBC Sport Football RSS: https://feeds.bbci.co.uk/sport/football/rss.xml

Also available: https://feeds.bbci.co.uk/sport/rss.xml and https://feeds.bbci.co.uk/news/technology/rss.xml. Direct fetch of feeds.bbci.co.uk was blocked in this environment.

Source: https://github.com/gadhagod/bbc-feeds · confidence: secondary-source

### BBC Sport Liverpool team feed: https://feeds.bbci.co.uk/sport/football/teams/liverpool/rss.xml

The team-feed pattern /sport/football/teams/{slug}/rss.xml was only referenced by an aggregator snippet ('home of Liverpool on BBC Sport online'). Fetch it at build time before relying on it; if it fails, filter the football feed for 'Liverpool'.

Source: https://rss.feedspot.com/liverpool_rss_feeds/ · confidence: unverified

### OpenAI official news RSS: https://openai.com/news/rss.xml

Used as 'the official OpenAI RSS feed' in Olshansk/rss-feeds PR #62, which parsed 182 research items from it and filters Research by category. The legacy https://openai.com/blog/rss.xml is still listed in that README. openai.com/feed.xml is outdated.

Source: https://github.com/Olshansk/rss-feeds/pull/62 · confidence: secondary-source

### Google DeepMind blog RSS: https://deepmind.google/blog/rss.xml ; Google Keyword AI RSS: https://blog.google/technology/ai/rss/

The Olshansk README marks deepmind.google/blog/rss.xml as 'Official RSS'. The legacy https://deepmind.com/blog/feed/basic is outdated. A search result titled 'AI' points at https://blog.google/technology/ai/rss (the all-Keyword feed is https://blog.google/rss/). Direct fetch was blocked.

Source: https://raw.githubusercontent.com/Olshansk/rss-feeds/main/README.md · confidence: secondary-source

### Anthropic has no official RSS feed for /news; a maintained community feed exists

Olshansk/rss-feeds marks Anthropic News, Engineering and Research as having no official RSS. Community feed: https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml. Fetched it: valid RSS 2.0, lastBuildDate 2026-09-24 12:48 UTC. Engineering: feed_anthropic_engineering.xml; Research: feed_anthropic_research.xml.

Source: https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml · confidence: verified-official-doc

### Liverpool FC official site, Premier League and UEFA RSS availability

Could not verify: liverpoolfc.com and uefa.com were blocked and the search budget ran out. My belief is that current liverpoolfc.com and premierleague.com have no public RSS, and that uefa.com has historically had https://www.uefa.com/rssfeed/news/rss.xml. Treat all three as unknown and probe them at runtime.

Source: https://www.uefa.com/rssfeed/news/rss.xml · confidence: unverified
