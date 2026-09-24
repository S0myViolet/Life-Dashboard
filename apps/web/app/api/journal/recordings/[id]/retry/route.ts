/**
 * POST /api/journal/recordings/:id/retry — transcribe again (after a failure, an interruption,
 * or once AI is set up). Never extends the recording's expiry.
 */
import { getJournalRecording } from '@personal-home/db'
import { transcribeJournalRecording } from '@personal-home/jobs'
import { fail, json, parseRecordingId, requireOwnerRoute } from '../../../_lib/http'
import { getJournalTranscriber } from '../../../_lib/transcriber'

export const maxDuration = 300

type Ctx = { params: Promise<{ id: string }> }

export async function POST(request: Request, ctx: Ctx) {
  const auth = await requireOwnerRoute(request, { mutating: true })
  if ('response' in auth) return auth.response
  const id = parseRecordingId((await ctx.params).id)
  if (!id) return fail('not_found', 404)
  try {
    const result = await transcribeJournalRecording(
      { run: auth.run, transcriber: await getJournalTranscriber() },
      id,
    )
    if (result.status === 'not_found' || result.status === 'deleted') return fail('not_found', 404)
    const recording = await auth.run((tx) => getJournalRecording(tx, id, new Date()))
    return json({ recording, result })
  } catch {
    return fail('transcription_error', 500)
  }
}
