import { notesHighlightSegments } from '@personal-home/core'

/**
 * Render a ts_headline snippet. Segments are plain text (React escapes them); matches become
 * <mark>. No HTML from the database is ever injected.
 */
export function Highlighted({ snippet, className = '' }: { snippet: string | null; className?: string }) {
  const segments = notesHighlightSegments(snippet)
  return (
    <span className={className}>
      {segments.map((s, i) =>
        s.match ? (
          <mark key={i} className="rounded-sm bg-caution-soft px-0.5 text-ink">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </span>
  )
}
