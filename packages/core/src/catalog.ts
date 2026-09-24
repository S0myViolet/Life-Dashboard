/**
 * Shared vocabulary for every layer (database checks, jobs, UI, extension).
 * Changing a value here is a contract change: update migrations and adapters with it.
 */
import { z } from 'zod'

/** Every external service the dashboard can talk to. One row per account in `connections`. */
export const PROVIDERS = [
  'google', // Gmail + Google Calendar, one connection per Google account
  'microsoft', // Outlook mail + calendar, one connection per Microsoft account
  'chatgpt', // collected by the Chrome helper
  'claude', // collected by the Chrome helper
  'lunchflow', // Revolut UK / HSBC UK via Lunch Flow Personal API
  'whoop',
  'spotify',
  'football_data',
  'rss',
] as const
export const ProviderSchema = z.enum(PROVIDERS)
export type Provider = z.infer<typeof ProviderSchema>

/**
 * Connection lifecycle. `needs_setup` means server credentials/config are missing
 * (for example GOOGLE_CLIENT_ID is unset), which is different from the owner not
 * having connected an account yet (`not_connected`).
 */
export const CONNECTION_STATUSES = [
  'needs_setup',
  'not_connected',
  'connected',
  'syncing',
  'paused',
  'needs_reconnect',
  'error',
  'unsupported',
] as const
export const ConnectionStatusSchema = z.enum(CONNECTION_STATUSES)
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>

/**
 * What a section can honestly say about its data. These are deliberately distinct:
 * an empty result from a healthy sync is not the same as an unreachable source.
 */
export const DATA_STATES = [
  'fresh', // synced recently, has data
  'stale', // has saved data, last successful sync older than expected
  'empty', // synced successfully, provider returned nothing
  'no_new_activity', // synced successfully, nothing changed since last time
  'partial', // some pages/folders/accounts synced, others did not
  'pending', // provider has not finished producing data (e.g. WHOOP unscored)
  'unavailable', // not connected, blocked or failing; saved data may still be shown
  'demo', // labelled fixture data, never shown in real-account mode
] as const
export const DataStateSchema = z.enum(DATA_STATES)
export type DataState = z.infer<typeof DataStateSchema>

/** Background job kinds processed by the dispatcher. */
export const JOB_KINDS = [
  'briefing.morning',
  'briefing.evening',
  'plan.daily_draft',
  'sync.google',
  'sync.microsoft',
  'sync.lunchflow',
  'sync.whoop',
  'sync.spotify',
  'sync.football',
  'sync.rss',
  'capture.summarize',
  'ai.reconcile',
  'push.deliver',
  'retention.purge',
] as const
export const JobKindSchema = z.enum(JOB_KINDS)
export type JobKind = z.infer<typeof JobKindSchema>

/** The seven default Updates sections. Order is the default display order. */
export const INTEREST_SECTIONS = [
  'financial_news',
  'markets',
  'ai_updates',
  'liverpool',
  'premier_league',
  'champions_league',
  'music',
] as const
export const InterestSectionSchema = z.enum(INTEREST_SECTIONS)
export type InterestSection = z.infer<typeof InterestSectionSchema>

export const INTEREST_SECTION_LABELS: Record<InterestSection, string> = {
  financial_news: 'Financial news',
  markets: 'Markets',
  ai_updates: 'AI updates',
  liverpool: 'Liverpool',
  premier_league: 'Premier League',
  champions_league: 'Champions League',
  music: 'Music',
}

/** Home screen modules the owner can reorder or hide. */
export const HOME_MODULES = [
  'needs_attention',
  'todays_plan',
  'today',
  'briefing',
  'health_preview',
  'money_preview',
  'interests',
] as const
export const HomeModuleSchema = z.enum(HOME_MODULES)
export type HomeModule = z.infer<typeof HomeModuleSchema>

/** Modules that must stay visible: hiding them would defeat the purpose of Home. */
export const REQUIRED_HOME_MODULES: readonly HomeModule[] = ['needs_attention', 'todays_plan']
