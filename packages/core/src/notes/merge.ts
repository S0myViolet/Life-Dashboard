/**
 * Conflict handling for notes and journal entries edited on more than one device (or offline).
 *
 * The rule from the brief: a stale write never silently overwrites. So a field that BOTH sides
 * changed is always a conflict the owner resolves (keep mine / keep theirs / merge). A field
 * only one side changed is taken from that side, which loses nothing, so it merges on its own.
 *
 * `notesMergeText` is a line-based three-way merge used to prefill the "Merge" option; its
 * conflicting hunks carry both versions between labelled marker lines.
 */

export const NOTES_MERGE_MARKERS = {
  mine: '<<<<<<< This device',
  divider: '=======',
  theirs: '>>>>>>> Saved version',
} as const

/** Largest LCS table (cells) we build; beyond this the changed middle is treated as one hunk. */
const MAX_LCS_CELLS = 2_000_000

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * For each line of `a`, the index of the matching line of `b` in a longest common subsequence,
 * or -1. Monotonic by construction.
 */
function lcsMatches(a: readonly string[], b: readonly string[]): Int32Array {
  const match = new Int32Array(a.length).fill(-1)
  // Common prefix and suffix are matched directly; the LCS table covers only the middle.
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
    match[pre] = pre
    pre++
  }
  let suf = 0
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    match[a.length - 1 - suf] = b.length - 1 - suf
    suf++
  }
  const n = a.length - pre - suf
  const m = b.length - pre - suf
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_LCS_CELLS) return match

  // dp[i][j] = LCS length of a[pre+i..] and b[pre+j..] (suffix form, so we can walk forwards).
  const w = m + 1
  const dp = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[pre + i] === b[pre + j]
          ? dp[(i + 1) * w + j + 1]! + 1
          : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!)
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[pre + i] === b[pre + j]) {
      match[pre + i] = pre + j
      i++
      j++
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
      i++
    } else {
      j++
    }
  }
  return match
}

export interface NotesTextMerge {
  text: string
  /** Number of hunks both sides changed differently (each written with both versions). */
  conflicts: number
}

/** Line-based three-way merge of `mine` and `theirs`, both edited from `base`. */
export function notesMergeText(base: string, mine: string, theirs: string): NotesTextMerge {
  if (mine === theirs) return { text: mine, conflicts: 0 }
  if (base === theirs) return { text: mine, conflicts: 0 }
  if (base === mine) return { text: theirs, conflicts: 0 }

  const o = base.split('\n')
  const a = mine.split('\n')
  const b = theirs.split('\n')
  const ma = lcsMatches(o, a)
  const mb = lcsMatches(o, b)

  const out: string[] = []
  let conflicts = 0
  let i = 0
  let j = 0
  let k = 0

  const flush = (oEnd: number, aEnd: number, bEnd: number) => {
    const oc = o.slice(i, oEnd)
    const ac = a.slice(j, aEnd)
    const bc = b.slice(k, bEnd)
    if (arraysEqual(ac, bc)) out.push(...ac)
    else if (arraysEqual(oc, ac)) out.push(...bc)
    else if (arraysEqual(oc, bc)) out.push(...ac)
    else {
      conflicts++
      out.push(NOTES_MERGE_MARKERS.mine, ...ac, NOTES_MERGE_MARKERS.divider, ...bc, NOTES_MERGE_MARKERS.theirs)
    }
  }

  for (let s = 0; s < o.length; s++) {
    const sa = ma[s]!
    const sb = mb[s]!
    // A stable line: present, unchanged, in all three, and after everything already emitted.
    if (sa < j || sb < k) continue
    flush(s, sa, sb)
    out.push(o[s]!)
    i = s + 1
    j = sa + 1
    k = sb + 1
  }
  flush(o.length, a.length, b.length)
  return { text: out.join('\n'), conflicts }
}

export type MergeableValue = string | number | boolean | null

export type NotesRecordMerge<T extends Record<string, MergeableValue>> =
  /** Every field was changed by at most one side (or identically by both): safe to save. */
  | { status: 'clean'; merged: T }
  /**
   * At least one field was changed differently on both sides. `proposal` takes this device's
   * value for those fields, except text fields, which get the three-way text merge.
   */
  | { status: 'conflict'; fields: Array<keyof T & string>; proposal: T }

/**
 * Field-by-field three-way merge. `textFields` get a text merge in the conflict proposal; other
 * conflicting fields propose this device's value.
 */
export function notesMergeRecords<T extends Record<string, MergeableValue>>(
  base: T,
  mine: T,
  theirs: T,
  textFields: ReadonlyArray<keyof T & string> = [],
): NotesRecordMerge<T> {
  const merged = { ...mine }
  const proposal = { ...mine }
  const fields: Array<keyof T & string> = []
  for (const key of Object.keys(mine) as Array<keyof T & string>) {
    const bv = base[key]
    const mv = mine[key]
    const tv = theirs[key]
    if (mv === tv || tv === bv) continue
    if (mv === bv) {
      merged[key] = tv
      proposal[key] = tv
      continue
    }
    fields.push(key)
    if (textFields.includes(key) && typeof mv === 'string' && typeof tv === 'string') {
      proposal[key] = notesMergeText(typeof bv === 'string' ? bv : '', mv, tv).text as T[typeof key]
    }
  }
  // Fields present only on the server side (not expected for fixed shapes, but never drop them).
  for (const key of Object.keys(theirs) as Array<keyof T & string>) {
    if (!(key in mine)) {
      merged[key] = theirs[key]
      proposal[key] = theirs[key]
    }
  }
  return fields.length === 0 ? { status: 'clean', merged } : { status: 'conflict', fields, proposal }
}
