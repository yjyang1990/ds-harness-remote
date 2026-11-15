import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it, vi } from 'vitest'
import { createPluginRouteDispatcher } from '../src/plugin-route-dispatcher.js'
import { PluginRouteBridge } from '../src/plugin-route-bridge.js'
import { createRpcRequest } from '@dsh-remote/protocol'
import { RpcRouter } from '../src/rpc-router.js'
import { runScenarios } from '../../../scripts/test-scenarios.mjs'

describe('Host plugin route carrier', () => {
  it('dispatches registered Fetch routes through the official Connection without an HTTP server', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(owner => { new HostConnectionService(owner, [], {} as never) }).await()
      const connection = ctx.get('connection') as HostConnectionService
      const readPort = vi.fn(() => undefined)
      const fetch = vi.fn(async (request: Request) => {
        expect(request.method).toBe('POST')
        expect(await request.json()).toEqual({ endpoint: 'state', payload: null })
        return Response.json({ ok: true, value: { revision: 1 } })
      })
      const unregister = connection.fetch.register({ path: '/api/bot', methods: ['POST'], requestBody: 'buffered', fetch })
      const bridge = new PluginRouteBridge(createPluginRouteDispatcher(() => connection, readPort, connection.createPeer({ principal: { kind: 'owner' } })))
      await expect(bridge.call({ route: 'api/bot', body: { endpoint: 'state', payload: null } }))
        .resolves.toEqual({ status: 200, json: { ok: true, value: { revision: 1 } } })
      await unregister()
      await expect(bridge.call({ route: 'api/bot', body: { endpoint: 'state' } }))
        .resolves.toEqual({ status: 404, json: 'not found' })
      expect(fetch).toHaveBeenCalledOnce()
      expect(readPort).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('carries prediction states and a missing plugin through real RPC and the official Fetch dispatcher', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(owner => { new HostConnectionService(owner, [], {} as never) }).await()
      const connection = ctx.get('connection') as HostConnectionService
      const states = [
        { status: 'none', reason: 'no-completion' },
        { status: 'pending', completionSeq: 7 },
        { status: 'ready', completionSeq: 7, prediction: 'Next step' },
      ]
      let state = states[0]
      const fetch = vi.fn(async (request: Request) => {
        expect(request.method).toBe('POST')
        expect(await request.json()).toEqual({ sessionId: 'session-1' })
        return Response.json(state)
      })
      const unregister = connection.fetch.register({ path: '/api/dsh-input-prediction', methods: ['POST'], requestBody: 'buffered', fetch })
      const bridge = new PluginRouteBridge(createPluginRouteDispatcher(() => connection, () => undefined, connection.createPeer({ principal: { kind: 'owner' } })))
      const router = new RpcRouter(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, bridge)
      const call = () => router.handle(createRpcRequest('plugin.route.call', { route: 'api/dsh-input-prediction', body: { sessionId: 'session-1' } }))
      await runScenarios(states.map(next => ({ name: next.status, run: async () => {
        state = next
        await expect(call()).resolves.toMatchObject({ type: 'rpc.response', payload: { result: { status: 200, json: next } } })
      } })))
      expect(fetch).toHaveBeenCalledTimes(3)
      await unregister()
      await expect(call()).resolves.toMatchObject({ type: 'rpc.response', payload: { result: { status: 404, json: 'not found' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('never forwards official Harness RPCs to the shared Connection interceptor', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(owner => { new HostConnectionService(owner, [], {} as never) }).await()
      const connection = ctx.get('connection') as HostConnectionService
      const rpc = vi.fn(async () => ({ ok: true as const, value: 'local mutation' }))
      connection.rpc.intercept('/api', () => true, rpc)
      const bridge = new PluginRouteBridge(createPluginRouteDispatcher(() => connection, () => undefined, connection.createPeer({ principal: { kind: 'owner' } })))
      await runScenarios(['schedule/create', 'settings/update', 'terminal/write'].map(endpoint => ({
        name: endpoint,
        run: async () => {
          const payload = endpoint === 'settings/update'
            ? { args: { ns: 'ds-harness-remote', value: { terminal: { enabled: true } } } }
            : { args: {} }
          await expect(bridge.call({
            route: `api/${endpoint}`,
            body: { type: 'client-request', rpcId: 'forbidden-route', method: endpoint, payload },
          })).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
          expect(rpc).not.toHaveBeenCalled()
        },
      })))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses unavailable carriers and propagates cancellation to the local Fetch route', async () => {
    const dispatch = createPluginRouteDispatcher(() => undefined, () => undefined)
    await expect(dispatch('api/bot', {}, new AbortController().signal)).resolves.toMatchObject({ status: 503 })
    const controller = new AbortController()
    controller.abort()
    const cancelled = createPluginRouteDispatcher(() => ({
      createSharedFetchHandler: () => ({ fetch: async request => {
        request.signal.throwIfAborted()
        throw new Error('Unexpected live request')
      } }),
    }), () => undefined)
    await expect(cancelled('api/bot', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })

    const active = new AbortController()
    let finish!: (response: Response) => void
    let routeSignal: AbortSignal | undefined
    const pending = createPluginRouteDispatcher(() => ({
      createSharedFetchHandler: () => ({ fetch: request => {
        routeSignal = request.signal
        return new Promise<Response>(resolve => { finish = resolve })
      } }),
    }), () => undefined)
    const response = pending('api/bot', {}, active.signal)
    active.abort()
    try {
      await expect(response).rejects.toMatchObject({ name: 'AbortError' })
      expect(routeSignal?.aborted).toBe(true)
    } finally {
      finish(Response.json({ ok: true }))
    }
  })
})
