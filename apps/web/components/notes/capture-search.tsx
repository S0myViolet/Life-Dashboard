'use client'

import { useState, useTransition, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import type { JournalSearchHit, NoteSearchHit } from '@personal-home/db'
import { searchCaptureAction } from '@/app/(app)/capture/actions'
import { Button } from '@/components/ui/button'
import { SearchResults } from './search-results'

/**
 * Search box for notes and journal. Runs as a POST so the words searched for stay out of URLs
 * and logs. Shows `children` (the normal lists) when no search is active.
 */
export function CaptureSearch({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ query: string; notes: NoteSearchHit[]; journal: JournalSearchHit[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    setError(null)
    if (!q) {
      setResults(null)
      return
    }
    startTransition(async () => {
      try {
        const r = await searchCaptureAction(q)
        if (r.status === 'ok') setResults({ query: q, notes: r.notes, journal: r.journal })
        else if (r.status === 'unauthorized') setError('You are signed out. Sign in again to search.')
        else setError('Search is not available right now.')
      } catch {
        setError('Search needs a connection. Your notes and drafts are still here.')
      }
    })
  }

  return (
    <>
      <form role="search" onSubmit={submit} className="mb-5 flex gap-2">
        <label htmlFor="capture-search" className="sr-only">
          Search notes and journal
        </label>
        <input
          id="capture-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={200}
          placeholder="Search notes and journal"
          className="min-h-11 min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-3 text-sm text-ink"
        />
        <Button type="submit" disabled={pending}>
          <Search aria-hidden className="size-4" />
          {pending ? 'Searching…' : 'Search'}
        </Button>
      </form>
      {error ? (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {results ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-ink-muted">Results for “{results.query}”</p>
            <Button
              variant="ghost"
              onClick={() => {
                setResults(null)
                setQuery('')
              }}
            >
              <X aria-hidden className="size-4" />
              Clear search
            </Button>
          </div>
          <SearchResults query={results.query} notes={results.notes} journal={results.journal} />
        </div>
      ) : (
        children
      )}
    </>
  )
}
