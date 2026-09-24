/**
 * Which transcriber the journal routes use: the AI gateway, which checks the source policy,
 * reserves budget before any call and records actual usage (docs/DECISIONS.md D-23).
 *
 * Without GEMINI_API_KEY (or with AI disabled in the budget settings) the gateway reports
 * `disabled`, which the journal shows honestly: the recording is kept with Retry / Download /
 * Delete and its expiry, and the owner can type instead.
 */
import 'server-only'
import {
  createGatewayJournalTranscriber,
  runAiTranscription,
  type JournalTranscriber,
} from '@personal-home/jobs'
import { integrationEnv } from '@/lib/env'
import { getDb, serviceTransaction } from '@/lib/server/db'

async function ownerTimezone(): Promise<string> {
  const [row] = await serviceTransaction(
    (tx) => tx<{ timezone: string }[]>`select timezone from public.owner_settings limit 1`,
  )
  return row?.timezone ?? 'Europe/London'
}

export async function getJournalTranscriber(): Promise<JournalTranscriber> {
  const timezone = await ownerTimezone()
  const apiKey = integrationEnv('gemini')?.GEMINI_API_KEY ?? null
  return createGatewayJournalTranscriber((request) =>
    runAiTranscription({
      db: getDb(),
      fetch: (input, init) => fetch(input, init),
      now: () => new Date(),
      timezone,
      apiKey,
      ...request,
    }),
  )
}
