/**
 * GET /api/journal/recordings/:id/audio — the owner's "Download" for a kept recording.
 * Owner only (RLS), never cached, served as an attachment.
 */
import { journalRecordingFileExtension } from '@personal-home/core'
import { readJournalRecordingAudio } from '@personal-home/db'
import { fail, parseRecordingId, requireOwnerRoute } from '../../../_lib/http'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(request: Request, ctx: Ctx) {
  const auth = await requireOwnerRoute(request, { mutating: false })
  if ('response' in auth) return auth.response
  const id = parseRecordingId((await ctx.params).id)
  if (!id) return fail('not_found', 404)
  const found = await auth.run((tx) => readJournalRecordingAudio(tx, id, new Date()))
  if (!found) return fail('not_found', 404)
  const { recording, audio } = found
  const filename = `journal-${recording.localDate}-${id.slice(0, 8)}.${journalRecordingFileExtension(recording.mimeType)}`
  return new Response(audio as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      'Content-Type': recording.mimeType,
      'Content-Length': String(audio.byteLength),
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
