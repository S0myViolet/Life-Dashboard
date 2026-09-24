/**
 * PUT /api/journal/recordings/:id/chunks/:seq — store one ≤1 MB chunk (application/octet-stream).
 *
 * Idempotent: repeating a chunk with identical bytes returns `duplicate`; different bytes for a
 * stored chunk are refused (409 mismatch), never replaced. Sizes must match the recording's fixed
 * chunk plan. The body is read with a hard cap, whatever Content-Length claims.
 */
import { JOURNAL_CHUNK_MAX_BYTES, JOURNAL_RECORDING_MAX_CHUNKS } from '@personal-home/core'
import { putJournalRecordingChunk } from '@personal-home/db'
import { fail, guarded, json, parseRecordingId, readBodyWithLimit, requireOwnerRoute } from '../../../../_lib/http'

type Ctx = { params: Promise<{ id: string; seq: string }> }

export const PUT = guarded(async (request: Request, ctx: Ctx) => {
  const auth = await requireOwnerRoute(request, { mutating: true })
  if ('response' in auth) return auth.response
  const params = await ctx.params
  const id = parseRecordingId(params.id)
  if (!id) return fail('not_found', 404)
  if (!/^\d{1,2}$/.test(params.seq)) return fail('invalid_seq', 400)
  const seq = Number(params.seq)
  if (seq >= JOURNAL_RECORDING_MAX_CHUNKS) return fail('invalid_seq', 400)

  const data = await readBodyWithLimit(request, JOURNAL_CHUNK_MAX_BYTES)
  if (data === 'too_large') return fail('too_large', 413)
  if (data.byteLength === 0) return fail('invalid_size', 400)

  const result = await auth.run((tx) => putJournalRecordingChunk(tx, { recordingId: id, seq, data }, new Date()))
  switch (result.status) {
    case 'stored':
    case 'duplicate':
      return json(result)
    case 'not_found':
      return fail('not_found', 404)
    case 'invalid_seq':
    case 'invalid_size':
      return fail(result.status, 400, { expectedSize: result.expectedSize })
    case 'mismatch':
    case 'not_uploading':
      return fail(result.status, 409)
  }
})
