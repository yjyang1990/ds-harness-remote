import type { PluginRouteDispatcher } from './plugin-route-bridge.js'

export interface PluginRouteConnectionLike {
  createSharedFetchHandler?(channel: '/api'): { fetch(request: Request, peer?: unknown): Promise<Response> }
  authenticatedUrl?(baseUrl: string): string
}

/** Resolve lazily: Connection may activate after the Remote plugin. */
export function createPluginRouteDispatcher(
  readConnection: () => PluginRouteConnectionLike | undefined,
  readPort: () => number | undefined,
  peer?: unknown,
): PluginRouteDispatcher {
  let cookie: string | undefined
  return async (route, body, signal) => {
    signal.throwIfAborted()
    const connection = readConnection()
    const handler = connection?.createSharedFetchHandler?.('/api')
    const upload = route === 'api/session/uploadFileBinary'
      ? (body as { payload: { sessionId: string; mediaType?: string; name?: string; data: string } }).payload : undefined
    const setting = route === 'api/dsh-input-prediction/session-setting'
      ? body as { sessionId: string; enabled?: boolean } : undefined
    const readSetting = setting !== undefined && setting.enabled === undefined
    let query = ''
    if (readSetting) {
      query = `?${new URLSearchParams({ sessionId: setting.sessionId })}`
    } else if (upload !== undefined) {
      query = `?${new URLSearchParams({ sessionId: upload.sessionId, ...(upload.mediaType === undefined ? {} : { mediaType: upload.mediaType }),
        ...(upload.name === undefined ? {} : { name: upload.name }) })}`
    }
    const request = readSetting ? { method: 'GET', signal } : {
      method: 'POST',
      headers: { 'content-type': upload === undefined ? 'application/json' : 'application/octet-stream' },
      body: upload === undefined ? JSON.stringify(body ?? {}) : Buffer.from(upload.data, 'base64'),
      signal,
    }
    let response: Response
    if (handler !== undefined) {
      // The authenticated Remote channel has already admitted this peer. Invoke
      // the official local Fetch carrier, including on Desktop without HTTP.
      response = await withSignal(handler.fetch(new Request(`http://127.0.0.1/${route}${query}`, request), peer), signal)
    } else {
      const port = readPort()
      if (connection?.authenticatedUrl === undefined || typeof port !== 'number') {
        return { status: 503, json: { ok: false, error: { code: 'gateway/unavailable', message: 'The local plugin route carrier is unavailable.' } } }
      }
      const origin = `http://127.0.0.1:${port}`
      if (cookie === undefined) {
        const launch = await fetch(connection.authenticatedUrl(`${origin}/`), { redirect: 'manual', signal })
        const setCookie = typeof launch.headers.getSetCookie === 'function' ? launch.headers.getSetCookie() : []
        cookie = setCookie.map(item => item.split(';', 1)[0]).join('; ') || undefined
      }
      response = await fetch(`${origin}/${route}${query}`, {
        ...request,
        headers: { ...request.headers, ...(cookie === undefined ? {} : { cookie }) },
      })
      if (response.status === 401) cookie = undefined
    }
    const text = await response.text()
    let json: unknown = null
    if (text !== '') {
      try { json = JSON.parse(text) } catch { json = text }
    }
    return { status: response.status, json }
  }
}

function withSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
