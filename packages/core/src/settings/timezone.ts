/**
 * Owner timezone validation.
 *
 * The timezone is an IANA name. Two validators must agree before it is saved:
 *   1. this schema (format + the runtime's Intl knows the zone), at the boundary;
 *   2. the database trigger (name exists in pg_timezone_names), on write.
 *
 * Browsers and Node report some zones by their CLDR "legacy canonical" name
 * (Chrome reports Asia/Calcutta and Europe/Kiev), while current tzdata builds
 * may only ship the IANA primary name (Asia/Kolkata, Europe/Kyiv) and vice versa.
 * ownerTimezoneCandidates() lists the equivalent spellings so the server can
 * pick the one its database recognises.
 */
import { z } from 'zod'

/**
 * CLDR/ICU legacy identifiers → IANA primary identifiers (same zone, same rules
 * today). Kept small and explicit; unknown names pass through unchanged.
 */
export const TIMEZONE_LEGACY_ALIASES: Readonly<Record<string, string>> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
}

/**
 * Zones that tzdata merged into another zone (now links). Mapped forward only:
 * a Kyiv owner is never stored as Uzhgorod.
 */
export const TIMEZONE_MERGED_INTO: Readonly<Record<string, string>> = {
  'Europe/Uzhgorod': 'Europe/Kyiv',
  'Europe/Zaporozhye': 'Europe/Kyiv',
}

const TIMEZONE_NAME_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/

/** True when the name is shaped like an IANA zone and this runtime's Intl accepts it. */
export function ownerTimezoneIsValid(name: string): boolean {
  if (typeof name !== 'string' || name.length > 64 || !TIMEZONE_NAME_RE.test(name)) return false
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: name })
    return true
  } catch {
    return false
  }
}

export const OwnerTimezoneSchema = z
  .string()
  .trim()
  .min(1, 'Choose a timezone')
  .max(64)
  .refine(ownerTimezoneIsValid, 'Not a recognised IANA timezone')

/** The IANA primary name for a zone (resolves the legacy spellings above). */
export function ownerTimezonePrimaryName(name: string): string {
  return TIMEZONE_LEGACY_ALIASES[name] ?? TIMEZONE_MERGED_INTO[name] ?? name
}

/**
 * Equivalent spellings to try, most preferred first: the IANA primary name,
 * the name as given, then any legacy spellings of the same zone.
 */
export function ownerTimezoneCandidates(name: string): string[] {
  const primary = ownerTimezonePrimaryName(name)
  const legacy = Object.entries(TIMEZONE_LEGACY_ALIASES)
    .filter(([, target]) => target === primary)
    .map(([alias]) => alias)
  return [...new Set([primary, name, ...legacy])]
}

const TIMEZONE_REGIONS = [
  'Africa',
  'America',
  'Antarctica',
  'Arctic',
  'Asia',
  'Atlantic',
  'Australia',
  'Europe',
  'Indian',
  'Pacific',
] as const

/**
 * Turn a raw list of zone names (for example from pg_timezone_names) into
 * picker groups: geographic zones by region plus UTC. Drops POSIX-style and
 * legacy duplicates whose primary name is also present.
 */
export function groupTimezonesForPicker(
  names: readonly string[],
): { region: string; zones: string[] }[] {
  const all = new Set(names)
  const groups = new Map<string, string[]>()
  for (const name of [...all].sort()) {
    const region = name.split('/')[0] ?? ''
    const isRegional = (TIMEZONE_REGIONS as readonly string[]).includes(region) && name.includes('/')
    if (!isRegional && name !== 'UTC') continue
    const primary = TIMEZONE_LEGACY_ALIASES[name] ?? TIMEZONE_MERGED_INTO[name]
    if (primary && all.has(primary)) continue
    const key = name === 'UTC' ? 'UTC' : region
    const list = groups.get(key) ?? []
    list.push(name)
    groups.set(key, list)
  }
  const order = ['UTC', ...TIMEZONE_REGIONS]
  return order
    .filter((region) => groups.has(region))
    .map((region) => ({ region, zones: groups.get(region)! }))
}

/** 'America/Argentina/Buenos_Aires' → 'Argentina / Buenos Aires'. */
export function timezonePickerLabel(name: string): string {
  if (!name.includes('/')) return name
  return name.split('/').slice(1).join(' / ').replaceAll('_', ' ')
}
