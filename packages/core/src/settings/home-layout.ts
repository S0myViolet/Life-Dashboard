/**
 * Home layout: which modules appear on Home, in what order.
 *
 * Stored in owner_settings.home_layout as [{ module, hidden }] in display order.
 * Rules:
 *   - Every module from HOME_MODULES appears exactly once.
 *   - Required modules (REQUIRED_HOME_MODULES) are always present and visible.
 *   - Unknown/malformed entries are dropped; missing modules are appended in the
 *     default order (visible), so new modules show up without a migration.
 */
import { z } from 'zod'
import {
  HOME_MODULES,
  HomeModuleSchema,
  REQUIRED_HOME_MODULES,
  type HomeModule,
} from '../catalog.ts'

export const HOME_MODULE_LABELS: Record<HomeModule, string> = {
  needs_attention: 'Needs attention',
  todays_plan: 'Your plan for today',
  today: 'Today',
  briefing: 'Latest briefing',
  health_preview: 'Health',
  money_preview: 'Money',
  interests: 'Interests',
}

/** One-line description of each module, used by the layout editor. */
export const HOME_MODULE_DESCRIPTIONS: Record<HomeModule, string> = {
  needs_attention: 'Explicit deadlines, overdue tasks and time-sensitive messages.',
  todays_plan: 'Three priorities and the next suggested action.',
  today: "Today's calendar, tasks and habits, with a link to the week.",
  briefing: 'The latest briefing and project changes.',
  health_preview: 'A small WHOOP sleep, recovery and strain preview.',
  money_preview: 'A small balances and renewals preview.',
  interests: 'Selected cards from your Updates sections.',
}

export const HomeLayoutEntrySchema = z.strictObject({
  module: HomeModuleSchema,
  hidden: z.boolean(),
})
export type HomeLayoutEntry = z.infer<typeof HomeLayoutEntrySchema>
export type HomeLayout = HomeLayoutEntry[]

export function isRequiredHomeModule(module: HomeModule): boolean {
  return REQUIRED_HOME_MODULES.includes(module)
}

/**
 * Strict schema for writes: every module exactly once, required modules visible.
 * Use normalizeHomeLayout() for repairing stored data instead.
 */
export const HomeLayoutSchema = z
  .array(HomeLayoutEntrySchema)
  .length(HOME_MODULES.length)
  .superRefine((entries, ctx) => {
    const seen = new Set<HomeModule>()
    entries.forEach((entry, index) => {
      if (seen.has(entry.module)) {
        ctx.addIssue({
          code: 'custom',
          message: `${entry.module} appears more than once`,
          path: [index, 'module'],
        })
      }
      seen.add(entry.module)
      if (entry.hidden && isRequiredHomeModule(entry.module)) {
        ctx.addIssue({
          code: 'custom',
          message: `${HOME_MODULE_LABELS[entry.module]} cannot be hidden`,
          path: [index, 'hidden'],
        })
      }
    })
  })

export function defaultHomeLayout(): HomeLayout {
  return HOME_MODULES.map((module) => ({ module, hidden: false }))
}

/**
 * Repair any stored value into a valid layout. Never throws.
 * Keeps the first occurrence of each known module and its saved order.
 */
export function normalizeHomeLayout(raw: unknown): HomeLayout {
  const out: HomeLayout = []
  const seen = new Set<HomeModule>()
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue
      const module = HomeModuleSchema.safeParse((item as { module?: unknown }).module)
      if (!module.success || seen.has(module.data)) continue
      seen.add(module.data)
      const hidden = (item as { hidden?: unknown }).hidden === true
      out.push({ module: module.data, hidden: hidden && !isRequiredHomeModule(module.data) })
    }
  }
  for (const module of HOME_MODULES) {
    if (!seen.has(module)) out.push({ module, hidden: false })
  }
  return out
}

/** Modules to render on Home, in order. */
export function visibleHomeModules(layout: HomeLayout): HomeModule[] {
  return normalizeHomeLayout(layout)
    .filter((entry) => !entry.hidden)
    .map((entry) => entry.module)
}

export const HomeLayoutOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('move'),
    module: HomeModuleSchema,
    direction: z.enum(['up', 'down']),
  }),
  z.strictObject({ op: z.literal('hide'), module: HomeModuleSchema }),
  z.strictObject({ op: z.literal('show'), module: HomeModuleSchema }),
  z.strictObject({ op: z.literal('reset') }),
])
export type HomeLayoutOperation = z.infer<typeof HomeLayoutOperationSchema>

export type HomeLayoutResult =
  { ok: true; layout: HomeLayout; changed: boolean } | { ok: false; error: 'required_module' }

function sameLayout(a: HomeLayout, b: HomeLayout): boolean {
  return (
    a.length === b.length &&
    a.every((e, i) => e.module === b[i]?.module && e.hidden === b[i]?.hidden)
  )
}

/** Swap a module with its neighbour. Moving past either end leaves the layout unchanged. */
export function moveHomeModule(
  layout: HomeLayout,
  module: HomeModule,
  direction: 'up' | 'down',
): HomeLayout {
  const next = normalizeHomeLayout(layout)
  const from = next.findIndex((e) => e.module === module)
  const to = direction === 'up' ? from - 1 : from + 1
  if (from < 0 || to < 0 || to >= next.length) return next
  const a = next[from]!
  next[from] = next[to]!
  next[to] = a
  return next
}

export function setHomeModuleHidden(
  layout: HomeLayout,
  module: HomeModule,
  hidden: boolean,
): HomeLayoutResult {
  if (hidden && isRequiredHomeModule(module)) return { ok: false, error: 'required_module' }
  const before = normalizeHomeLayout(layout)
  const next = before.map((e) => (e.module === module ? { ...e, hidden } : e))
  return { ok: true, layout: next, changed: !sameLayout(before, next) }
}

export function applyHomeLayoutOperation(
  layout: HomeLayout,
  operation: HomeLayoutOperation,
): HomeLayoutResult {
  const before = normalizeHomeLayout(layout)
  switch (operation.op) {
    case 'move': {
      const next = moveHomeModule(before, operation.module, operation.direction)
      return { ok: true, layout: next, changed: !sameLayout(before, next) }
    }
    case 'hide':
      return setHomeModuleHidden(before, operation.module, true)
    case 'show':
      return setHomeModuleHidden(before, operation.module, false)
    case 'reset': {
      const next = defaultHomeLayout()
      return { ok: true, layout: next, changed: !sameLayout(before, next) }
    }
  }
}
