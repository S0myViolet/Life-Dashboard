/**
 * GET    /api/journal/recordings/:id — status, including which chunks the server has (resume point).
 * DELETE /api/journal/recordings/:id — the owner's "Delete" (chunks cascade).
 */
import { deleteJournalRecording, getJournalRecording } from '@personal-home/db'
import { fail, json, parseRecordingId, requireOwnerRoute } from '../../_lib/http'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(request: Request, ctx: Ctx) {
  const auth = await requireOwnerRoute(request, { mutating: false })
  if ('response' in auth) return auth.response
  const id = parseRecordingId((await ctx.params).id)
  if (!id) return fail('not_found', 404)
  const recording = await auth.run((tx) => getJournalRecording(tx, id, new Date()))
  return recording ? json({ recording }) : fail('not_found', 404)
}

export async function DELETE(request: Request, ctx: Ctx) {
  const auth = await requireOwnerRoute(request, { mutating: true })
  if ('response' in auth) return auth.response
  const id = parseRecordingId((await ctx.params).id)
  if (!id) return fail('not_found', 404)
  const deleted = await auth.run((tx) => deleteJournalRecording(tx, id))
  return deleted ? new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } }) : fail('not_found', 404)
}
