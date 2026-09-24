/**
 * POST /api/journal/recordings — register a voice recording before uploading its chunks.
 * Idempotent on the device-generated id (a retried registration returns the same recording and
 * the chunks the server already has, which is where a resumed upload continues).
 */
import { createJournalRecording } from '@personal-home/db'
import { fail, guarded, json, readJson, requireOwnerRoute } from '../_lib/http'

export const POST = guarded(async (request: Request) => {
  const auth = await requireOwnerRoute(request, { mutating: true })
  if ('response' in auth) return auth.response
  const body = await readJson(request)
  if (body === 'too_large') return fail('too_large', 413)
  if (body === 'invalid') return fail('invalid', 400)

  const result = await auth.run((tx) =>
    createJournalRecording(tx, body as Parameters<typeof createJournalRecording>[1], new Date()),
  )
  switch (result.status) {
    case 'created':
      return json({ recording: result.recording }, 201)
    case 'exists':
      return json({ recording: result.recording }, 200)
    case 'id_conflict':
      return fail('id_conflict', 409)
    case 'invalid':
      return fail('invalid', 400, { issues: result.issues })
  }
})
