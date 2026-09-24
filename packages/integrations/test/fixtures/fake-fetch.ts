/**
 * A scriptable fetch for tests. Records every request (method, URL, headers,
 * body) and answers from a handler. Honours AbortSignal like real fetch.
 */
export interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string
  redirect: RequestRedirect | undefined
}

export type FakeHandler = (req: RecordedRequest) => Response | Promise<Response>

export interface FakeFetch {
  fetch: typeof fetch
  calls: RecordedRequest[]
}

export function createFakeFetch(handler: FakeHandler): FakeFetch {
  const calls: RecordedRequest[] = []
  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => (headers[k] = v))
    const body =
      init.body === undefined || init.body === null
        ? ''
        : init.body instanceof URLSearchParams
          ? init.body.toString()
          : String(init.body)
    const req: RecordedRequest = {
      method: init.method ?? 'GET',
      url: String(input instanceof Request ? input.url : input),
      headers,
      body,
      redirect: init.redirect,
    }
    calls.push(req)
    const signal = init.signal
    if (signal?.aborted) throw signal.reason
    const answer = Promise.resolve(handler(req))
    if (!signal) return answer
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      answer.then(
        (r) => {
          signal.removeEventListener('abort', onAbort)
          resolve(r)
        },
        (e) => {
          signal.removeEventListener('abort', onAbort)
          reject(e)
        },
      )
    })
  }
  return { fetch: fetchImpl as typeof fetch, calls }
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

export function textResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers })
}

/** Never answers (until the request is aborted). */
export function hang(): Promise<Response> {
  return new Promise<Response>(() => {})
}

export function formBody(req: RecordedRequest): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(req.body))
}
