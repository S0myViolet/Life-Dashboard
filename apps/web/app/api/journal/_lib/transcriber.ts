/**
 * Which transcriber the journal routes use.
 *
 * Until the AI gateway (branch m0/ai) is merged, this is `notConfiguredJournalTranscriber`: every
 * recording is kept (Retry / Download / Delete, visible expiry) and marked "Transcription is not
 * set up yet", which is the honest state. To wire the gateway (integrator):
 *
 *   import { runAiTranscription } from '@personal-home/jobs'
 *   return createGatewayJournalTranscriber((req) =>
 *     runAiTranscription({ db: getDb(), fetch, now: () => new Date(), timezone, apiKey: integrationEnv('gemini')?.GEMINI_API_KEY, ...req }))
 *
 * (`timezone` = owner_settings.timezone; the gateway reserves budget before any call.)
 */
import 'server-only'
import { notConfiguredJournalTranscriber, type JournalTranscriber } from '@personal-home/jobs'

export async function getJournalTranscriber(): Promise<JournalTranscriber> {
  return notConfiguredJournalTranscriber
}
