'use client'

import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** The id is generated here, so a note written offline syncs later without creating duplicates. */
export function NewNoteButton({ variant = 'primary' }: { variant?: 'primary' | 'secondary' }) {
  const router = useRouter()
  return (
    <Button variant={variant} onClick={() => router.push(`/capture/notes/${crypto.randomUUID()}?new=1`)}>
      <Plus aria-hidden className="size-4" />
      New note
    </Button>
  )
}
