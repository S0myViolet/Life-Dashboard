import { notFound } from 'next/navigation'
import { z } from 'zod'
import { getNote, listNoteLinkOptions } from '@personal-home/db'
import { PageHeader } from '@/components/shell/app-shell'
import { NoteEditor } from '@/components/notes/note-editor'
import { requireOwner, withOwnerTx } from '@/lib/server/session'

export const metadata = { title: 'Note' }

export default async function NotePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ new?: string | string[] }>
}) {
  await requireOwner()
  const { id: raw } = await params
  const parsed = z.uuid().safeParse(raw)
  if (!parsed.success) notFound()
  const id = parsed.data.toLowerCase()
  const isNew = (await searchParams).new === '1'
  const { note, links } = await withOwnerTx(async (tx) => ({
    note: await getNote(tx, id),
    links: await listNoteLinkOptions(tx),
  }))

  return (
    <>
      <PageHeader title={note ? 'Note' : 'New note'} />
      {/* Keyed by id so moving between notes never carries one note's text into another. */}
      <NoteEditor key={id} id={id} initial={note} isNew={isNew} links={links} />
    </>
  )
}
