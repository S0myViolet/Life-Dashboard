/**
 * Half-open intervals [start, end) on epoch milliseconds. Lists are kept sorted and disjoint.
 */

export interface PlannerSpan {
  start: number
  end: number
}

export const MINUTE_MS = 60_000

/** Round `t` up to the next multiple of `granularityMs` (unchanged when already on the grid). */
export function plannerAlignUp(t: number, granularityMs: number): number {
  return Math.ceil(t / granularityMs) * granularityMs
}

/** Round `t` down to a multiple of `granularityMs`. */
export function plannerAlignDown(t: number, granularityMs: number): number {
  return Math.floor(t / granularityMs) * granularityMs
}

/** True when [a.start, a.end) and [b.start, b.end) share any time. */
export function plannerSpansOverlap(a: PlannerSpan, b: PlannerSpan): boolean {
  return a.start < b.end && b.start < a.end
}

/** Sort and merge overlapping or touching spans; drops empty ones. */
export function plannerMergeSpans(spans: readonly PlannerSpan[]): PlannerSpan[] {
  const sorted = spans
    .filter((s) => s.end > s.start)
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const out: PlannerSpan[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push(s)
  }
  return out
}

/** `free` minus `cut` (both lists; result sorted and disjoint). */
export function plannerSubtractSpans(
  free: readonly PlannerSpan[],
  cut: readonly PlannerSpan[],
): PlannerSpan[] {
  const cuts = plannerMergeSpans(cut)
  const out: PlannerSpan[] = []
  for (const f of plannerMergeSpans(free)) {
    let pieces: PlannerSpan[] = [{ start: f.start, end: f.end }]
    for (const c of cuts) {
      if (c.end <= f.start) continue
      if (c.start >= f.end) break
      const next: PlannerSpan[] = []
      for (const p of pieces) {
        if (!plannerSpansOverlap(p, c)) {
          next.push(p)
          continue
        }
        if (c.start > p.start) next.push({ start: p.start, end: c.start })
        if (c.end < p.end) next.push({ start: c.end, end: p.end })
      }
      pieces = next
    }
    out.push(...pieces)
  }
  return out.filter((s) => s.end > s.start)
}

/** Total length of disjoint spans, in whole minutes (floored). */
export function plannerSpanMinutes(spans: readonly PlannerSpan[]): number {
  let ms = 0
  for (const s of spans) ms += s.end - s.start
  return Math.floor(ms / MINUTE_MS)
}
