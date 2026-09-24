/**
 * POST /api/journal/recordings/:id/complete — verify every chunk arrived, mark the recording
 * uploaded and transcribe it. Safe to repeat: a second call reports the current state and does
 * not transcribe twice (an in-flight attempt holds the recording).
 *
 * The transcript lands as an editable draft on the entry; a failure (AI not configured, budget,
 * provider refusal, empty result) keeps the recording for retry until it expires.
 */
import { completeJournalRecordingUpload, getJournalRecording } from '@personal-home/db'
import { transcribeJournalRecording } from '@personal-home/jobs'
import { fail, guarded, json, parseRecordingId, requireOwnerRoute } from '../../../_lib/http'
import { getJournalTranscriber } from '../../../_lib/transcriber'

// Transcription can take a while (Vercel Hobby allows up to 300 s).
export const maxDuration = 300

type Ctx = { params: Promise<{ id: string }> }

export const POST = guarded(async (request: Request, ctx: Ctx) => {
  const auth = await requireOwnerRoute(request, { mutating: true })
  if ('response' in auth) return auth.response
  const id = parseRecordingId((await ctx.params).id)
  if (!id) return fail('not_found', 404)

  const done = await auth.run((tx) => completeJournalRecordingUpload(tx, id, new Date()))
  if (done.status === 'not_found') return fail('not_found', 404)
  if (done.status === 'incomplete') {
    return fail('incomplete', 409, { missing: done.missing, recording: done.recording })
  }
  // Only a freshly uploaded recording is transcribed here; failed ones wait for the owner's Retry.
  if (done.recording.status !== 'uploaded') return json({ recording: done.recording, result: null })

  try {
    const result = await transcribeJournalRecording(
      { run: auth.run, transcriber: await getJournalTranscriber() },
      id,
    )
    const recording = await auth.run((tx) => getJournalRecording(tx, id, new Date()))
    return json({ recording, result })
  } catch {
    // The upload is safe; the recording shows as uploaded/interrupted with a Retry.
    const recording = await auth.run((tx) => getJournalRecording(tx, id, new Date())).catch(() => null)
    return json({ recording, result: null, error: 'transcription_error' })
  }
})
