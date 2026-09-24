import { describe, expect, it } from 'vitest'
import {
  EMPTY_NOTE_CONTENT,
  NOTES_HIGHLIGHT_START as S,
  NOTES_HIGHLIGHT_STOP as E,
  NOTES_MERGE_MARKERS,
  NoteSaveInputSchema,
  notesContentEqual,
  notesDisplayTitle,
  notesHighlightSegments,
  notesMergeRecords,
  notesMergeText,
  notesNormalizeContent,
  notesSearchTsQuery,
} from '../src/index.ts'

describe('note content validation', () => {
  it('normalises blank titles to null, strips NUL and keeps the body verbatim', () => {
    const c = notesNormalizeContent({ ...EMPTY_NOTE_CONTENT, title: '   ', body: ' a\u0000b \n' })
    expect(c.title).toBeNull()
    expect(c.body).toBe(' ab \n')
    // Titles are not trimmed (an editor mid-typing "Hello " must not see its space removed).
    expect(notesNormalizeContent({ ...EMPTY_NOTE_CONTENT, title: 'Hello ' }).title).toBe('Hello ')
  })

  it('rejects oversized fields, bad links and negative versions', () => {
    const base = { id: crypto.randomUUID(), baseVersion: 0, content: EMPTY_NOTE_CONTENT }
    expect(NoteSaveInputSchema.safeParse(base).success).toBe(true)
    expect(
      NoteSaveInputSchema.safeParse({ ...base, content: { ...EMPTY_NOTE_CONTENT, title: 'x'.repeat(301) } }).success,
    ).toBe(false)
    expect(
      NoteSaveInputSchema.safeParse({ ...base, content: { ...EMPTY_NOTE_CONTENT, body: 'x'.repeat(200_001) } })
        .success,
    ).toBe(false)
    expect(
      NoteSaveInputSchema.safeParse({ ...base, content: { ...EMPTY_NOTE_CONTENT, linkedDate: '2026-02-30' } }).success,
    ).toBe(false)
    expect(
      NoteSaveInputSchema.safeParse({ ...base, content: { ...EMPTY_NOTE_CONTENT, projectId: 'nope' } }).success,
    ).toBe(false)
    expect(NoteSaveInputSchema.safeParse({ ...base, baseVersion: -1 }).success).toBe(false)
    expect(NoteSaveInputSchema.safeParse({ ...base, id: 'not-a-uuid' }).success).toBe(false)
  })

  it('compares content field by field', () => {
    const a = notesNormalizeContent({ ...EMPTY_NOTE_CONTENT, body: 'x' })
    expect(notesContentEqual(a, { ...a })).toBe(true)
    expect(notesContentEqual(a, { ...a, pinned: true })).toBe(false)
    expect(notesContentEqual(a, { ...a, linkedDate: '2026-09-24' })).toBe(false)
  })

  it('derives a display title from the title or the first non-empty line', () => {
    expect(notesDisplayTitle({ title: 'Plan', body: 'x' })).toBe('Plan')
    expect(notesDisplayTitle({ title: null, body: '\n  \nFirst line\nsecond' })).toBe('First line')
    expect(notesDisplayTitle({ title: null, body: '' })).toBe('Untitled note')
    expect(notesDisplayTitle({ title: 'a'.repeat(100), body: '' }, 10)).toBe('aaaaaaaaa…')
  })
})

describe('notesSearchTsQuery', () => {
  it('turns words into AND-ed prefix terms', () => {
    expect(notesSearchTsQuery('Meet notes')).toBe("'meet':* & 'notes':*")
  })

  it('drops every tsquery operator and quote, so input can never change the query shape', () => {
    expect(notesSearchTsQuery("it's | !bad & (x) <-> 'y':*")).toBe(
      "'it':* & 's':* & 'bad':* & 'x':* & 'y':*",
    )
    expect(notesSearchTsQuery('   ')).toBeNull()
    expect(notesSearchTsQuery('!!! ---')).toBeNull()
  })

  it('keeps unicode letters and digits, dedupes and bounds the query', () => {
    expect(notesSearchTsQuery('Café café 2026')).toBe("'café':* & '2026':*")
    const many = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')
    expect(notesSearchTsQuery(many)!.split(' & ')).toHaveLength(8)
    expect(notesSearchTsQuery('x'.repeat(500))).toBe(`'${'x'.repeat(64)}':*`)
  })
})

describe('notesHighlightSegments', () => {
  it('splits ts_headline output into plain and matched segments', () => {
    expect(notesHighlightSegments(`the ${S}meeting${E} notes and ${S}meet${E}`)).toEqual([
      { text: 'the ', match: false },
      { text: 'meeting', match: true },
      { text: ' notes and ', match: false },
      { text: 'meet', match: true },
    ])
  })

  it('treats markup as text and tolerates unbalanced markers', () => {
    expect(notesHighlightSegments(`<b>${S}x`)).toEqual([
      { text: '<b>', match: false },
      { text: 'x', match: true },
    ])
    expect(notesHighlightSegments('')).toEqual([])
    expect(notesHighlightSegments(null)).toEqual([])
  })
})

describe('notesMergeText (three-way, line based)', () => {
  it('takes the only side that changed', () => {
    expect(notesMergeText('a\nb', 'a\nb\nc', 'a\nb')).toEqual({ text: 'a\nb\nc', conflicts: 0 })
    expect(notesMergeText('a\nb', 'a\nb', 'x\nb')).toEqual({ text: 'x\nb', conflicts: 0 })
  })

  it('merges non-overlapping edits from both sides', () => {
    const base = 'one\ntwo\nthree\nfour'
    const mine = 'one\nTWO\nthree\nfour'
    const theirs = 'one\ntwo\nthree\nFOUR'
    expect(notesMergeText(base, mine, theirs)).toEqual({ text: 'one\nTWO\nthree\nFOUR', conflicts: 0 })
  })

  it('writes both versions of an overlapping edit between labelled markers', () => {
    const r = notesMergeText('a\nb\nc', 'a\nmine\nc', 'a\ntheirs\nc')
    expect(r.conflicts).toBe(1)
    expect(r.text).toBe(
      ['a', NOTES_MERGE_MARKERS.mine, 'mine', NOTES_MERGE_MARKERS.divider, 'theirs', NOTES_MERGE_MARKERS.theirs, 'c'].join(
        '\n',
      ),
    )
  })

  it('never drops text from either side, including both appending at the end', () => {
    const r = notesMergeText('start', 'start\nfrom phone', 'start\nfrom laptop')
    expect(r.conflicts).toBe(1)
    expect(r.text).toContain('from phone')
    expect(r.text).toContain('from laptop')
  })

  it('accepts identical changes on both sides without a conflict', () => {
    expect(notesMergeText('a', 'b', 'b')).toEqual({ text: 'b', conflicts: 0 })
  })

  it('stays correct (if coarse) for texts too large for the LCS table', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`)
    const mine = [...big]
    mine[10] = 'mine'
    const theirs = [...big]
    theirs[2990] = 'theirs'
    const r = notesMergeText(big.join('\n'), mine.join('\n'), theirs.join('\n'))
    expect(r.text).toContain('mine')
    expect(r.text).toContain('theirs')
  })
})

describe('notesMergeRecords (field level)', () => {
  const base = { title: 'T', body: 'b', pinned: false, bookId: null as string | null }

  it('is clean when each field changed on at most one side', () => {
    const mine = { ...base, body: 'b + my edit' }
    const theirs = { ...base, pinned: true }
    expect(notesMergeRecords(base, mine, theirs, ['body'])).toEqual({
      status: 'clean',
      merged: { title: 'T', body: 'b + my edit', pinned: true, bookId: null },
    })
  })

  it('reports a conflict (never a silent overwrite) when both sides changed the same field', () => {
    const mine = { ...base, body: 'b\nmine' }
    const theirs = { ...base, body: 'b\ntheirs', title: 'Server title' }
    const r = notesMergeRecords(base, mine, theirs, ['body'])
    expect(r.status).toBe('conflict')
    if (r.status !== 'conflict') return
    expect(r.fields).toEqual(['body'])
    // The proposal keeps the other side's one-sided change and a text merge for the body.
    expect(r.proposal.title).toBe('Server title')
    expect(r.proposal.body).toContain('mine')
    expect(r.proposal.body).toContain('theirs')
  })
})
