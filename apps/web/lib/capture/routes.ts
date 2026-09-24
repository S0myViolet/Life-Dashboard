/**
 * Handlers behind /api/capture/v1/* (the Chrome helper's versioned API).
 *
 * The helper authenticates with a device bearer token (hash lookup, not revoked)
 * from its recorded chrome-extension:// origin. The token only reaches the
 * owner's selected, active conversations; it cannot select conversations, read
 * captured text or touch anything else. Error bodies never echo request content.
 */
import 'server-only'
import {
  CAPTURE_EXTENSION_ORIGIN_RE,
  CAPTURE_LIMITS,
  CapturePairRequestSchema,
  CaptureSnapshotSchema,
  CaptureStatusReportSchema,
  captureIssueSummary,
} from '@personal-home/core'
import {
  captureIngestSnapshot,
  captureListSelection,
  captureMarkState,
  captureRedeemPairingCode,
} from '@personal-home/db'
import { serviceTransaction } from '@/lib/server/db'
import { captureDashboardOrigin } from './config'
import { authenticateDevice } from './device-auth'
import { declaredTooLarge, errorResponse, jsonResponse, readJsonBody } from './http'

/** Log only the failure kind: never tokens, payloads or database parameters. */
async function guarded(route: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'unknown'
    console.error(`[capture] ${route} failed`, { name: err instanceof Error ? err.name : 'Error', code })
    return errorResponse(500, 'server_error')
  }
}

/** POST /api/capture/v1/pair {code, deviceName} → 201 {token, dashboardOrigin, deviceId} once. */
export function handlePair(request: Request): Promise<Response> {
  return guarded('pair', async () => {
    const origin = request.headers.get('origin')
    if (!origin || !CAPTURE_EXTENSION_ORIGIN_RE.test(origin)) {
      return errorResponse(403, 'extension_origin_required')
    }
    const body = await readJsonBody(request, CAPTURE_LIMITS.maxSmallBodyBytes)
    if (!body.ok) return body.response
    const parsed = CapturePairRequestSchema.safeParse(body.value)
    if (!parsed.success) {
      return errorResponse(400, 'invalid_request', { issues: captureIssueSummary(parsed.error) })
    }
    const result = await serviceTransaction((tx) =>
      captureRedeemPairingCode(tx, { ...parsed.data, extensionOrigin: origin }),
    )
    // One answer for unknown, used, expired and attempt-locked codes: no oracle.
    if (result.status !== 'paired') return errorResponse(401, 'invalid_or_expired_code')
    return jsonResponse(
      {
        token: result.token,
        dashboardOrigin: captureDashboardOrigin(request),
        deviceId: result.deviceId,
      },
      201,
    )
  })
}

/** GET /api/capture/v1/selection → the active selection, and nothing else. */
export function handleSelection(request: Request): Promise<Response> {
  return guarded('selection', () =>
    serviceTransaction(async (tx) => {
      const auth = await authenticateDevice(tx, request, { requireOrigin: false })
      if (!auth.ok) return auth.response
      const conversations = await captureListSelection(tx)
      return jsonResponse({ conversations, syncedAt: new Date().toISOString() })
    }),
  )
}

/** POST /api/capture/v1/snapshots → reconcile one snapshot of a selected, active conversation. */
export function handleSnapshot(request: Request): Promise<Response> {
  return guarded('snapshots', async () => {
    const max = CAPTURE_LIMITS.maxPayloadBytes
    if (declaredTooLarge(request, max)) return errorResponse(413, 'payload_too_large')

    // Authenticate before reading a large body; re-checked inside the write transaction.
    const pre = await serviceTransaction((tx) => authenticateDevice(tx, request, { requireOrigin: true }))
    if (!pre.ok) return pre.response

    const body = await readJsonBody(request, max)
    if (!body.ok) return body.response
    const parsed = CaptureSnapshotSchema.safeParse(body.value)
    if (!parsed.success) {
      return errorResponse(400, 'invalid_snapshot', { issues: captureIssueSummary(parsed.error) })
    }

    const receivedAt = new Date()
    return serviceTransaction(async (tx) => {
      const auth = await authenticateDevice(tx, request, { requireOrigin: true })
      if (!auth.ok) return auth.response
      const result = await captureIngestSnapshot(tx, parsed.data, { receivedAt })
      switch (result.status) {
        case 'not_selected':
          return errorResponse(403, 'not_selected')
        case 'not_active':
          return errorResponse(409, 'not_active', { captureState: result.captureState })
        case 'ok':
          return jsonResponse({
            outcome: result.outcome,
            newMessages: result.newMessages,
            newVersions: result.newVersions,
            captureState: result.captureState,
            duplicate: result.duplicate,
          })
      }
    })
  })
}

/** POST /api/capture/v1/status → a problem seen on a selected conversation's page pauses it. */
export function handleStatus(request: Request): Promise<Response> {
  return guarded('status', async () => {
    if (declaredTooLarge(request, CAPTURE_LIMITS.maxSmallBodyBytes)) {
      return errorResponse(413, 'payload_too_large')
    }
    return serviceTransaction(async (tx) => {
      const auth = await authenticateDevice(tx, request, { requireOrigin: true })
      if (!auth.ok) return auth.response
      // Small (8 KB cap) and read after authentication.
      const body = await readJsonBody(request, CAPTURE_LIMITS.maxSmallBodyBytes)
      if (!body.ok) return body.response
      const parsed = CaptureStatusReportSchema.safeParse(body.value)
      if (!parsed.success) {
        return errorResponse(400, 'invalid_status', { issues: captureIssueSummary(parsed.error) })
      }
      const observedAt = new Date(Math.min(Date.parse(parsed.data.observedAt), Date.now()))
      const result = await captureMarkState(tx, {
        provider: parsed.data.provider,
        externalId: parsed.data.externalId.toLowerCase(),
        problem: parsed.data.state,
        at: observedAt,
      })
      if (result.status === 'not_selected') return errorResponse(403, 'not_selected')
      return jsonResponse({ captureState: result.captureState })
    })
  })
}
