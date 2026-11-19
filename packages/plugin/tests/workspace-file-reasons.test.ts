import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessRemoteBridge } from '../src/harness-remote-bridge.js'
import type { LocalTypertGateway } from '../src/typert-gateway-contract.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function gateway(dispatch: LocalTypertGateway['dispatch']): LocalTypertGateway {
  return {
    invoke: async () => undefined,
    dispatch,
    open: async () => (async function* () { return })(),
    failure: () => ({ code: 'internal', message: 'Request failed.', details: {} }),
    supportsCarrier: true,
  }
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-reason-'))
  directories.push(base)
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'inside.txt'), 'inside')
  await writeFile(join(root, 'sub', 'nested.txt'), 'nested')
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'))
  await symlink(outside, join(root, 'dirlink'), process.platform === 'win32' ? 'junction' : 'dir')
  const big = await open(join(root, 'big.bin'), 'w')
  await big.truncate(5 * 1024 * 1024)
  await big.close()
  const alias = join(base, 'alias')
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  return { root, alias, outside }
}

function bridgeFor(root: string, dispatch: LocalTypertGateway['dispatch']) {
  return new HarnessRemoteBridge(
    gateway(dispatch),
    vi.fn(async () => undefined),
    undefined,
    undefined,
    undefined,
    undefined,
    async sessionId => sessionId === 's1' ? root : undefined,
  )
}

describe('workspace file denial reasons', () => {
  it('classifies each containment rule without exposing paths or file contents', async () => {
    const { root, outside } = await fixture()
    const dispatch = vi.fn(async () => ({ ok: true as const, value: { text: 'inside' } }))
    const bridge = bridgeFor(root, dispatch)
    const call = (endpoint: string, args: Record<string, unknown>) => bridge.call({ endpoint, payload: { args } })

    await expect(call('workspaceFiles/read', { workspaceFileScopeId: 's1', path: 'inside.txt' }))
      .resolves.toMatchObject({ ok: true })

    const scenarios = [
      { name: 'missing scope', endpoint: 'workspaceFiles/read', args: { path: 'inside.txt' }, code: 'WORKSPACE_UNAVAILABLE', reason: 'scope-missing' },
      { name: 'unknown session', endpoint: 'workspaceFiles/read', args: { workspaceFileScopeId: 'missing', path: 'inside.txt' }, code: 'WORKSPACE_UNAVAILABLE', reason: 'authority-unavailable' },
      { name: 'parent traversal', endpoint: 'workspaceFiles/read', args: { workspaceFileScopeId: 's1', path: '../outside/secret.txt' }, code: 'WORKSPACE_PATH_DENIED', reason: 'outside-root' },
      { name: 'absolute outside', endpoint: 'workspaceFiles/stat', args: { workspaceFileScopeId: 's1', path: join(outside, 'secret.txt') }, code: 'WORKSPACE_PATH_DENIED', reason: 'outside-root' },
      { name: 'symlink target', endpoint: 'workspaceFiles/read', args: { workspaceFileScopeId: 's1', path: 'link.txt' }, code: 'WORKSPACE_PATH_DENIED', reason: 'symlink' },
      { name: 'symlink ancestor', endpoint: 'workspaceFiles/read', args: { workspaceFileScopeId: 's1', path: 'dirlink/secret.txt' }, code: 'WORKSPACE_PATH_DENIED', reason: 'symlink' },
      { name: 'directory as file', endpoint: 'workspaceFiles/read', args: { workspaceFileScopeId: 's1', path: 'sub' }, code: 'WORKSPACE_PATH_DENIED', reason: 'not-regular-file' },
      { name: 'missing file', endpoint: 'workspaceFiles/read', args: { workspaceFileScopeId: 's1', path: 'sub/missing.txt' }, code: 'WORKSPACE_PATH_DENIED', reason: 'not-found' },
      { name: 'oversized readAll', endpoint: 'workspaceFiles/readAll', args: { workspaceFileScopeId: 's1', path: 'big.bin' }, code: 'WORKSPACE_TOO_LARGE', reason: 'too-large' },
    ]

    for (const scenario of scenarios) {
      const before = dispatch.mock.calls.length
      await expect(call(scenario.endpoint, scenario.args)).rejects.toMatchObject({
        code: scenario.code,
        details: { reason: scenario.reason },
      })
      expect(dispatch.mock.calls.length, scenario.name).toBe(before)
    }
  })

  it('uses the canonical root when the session path is reached through a symlink', async () => {
    const { alias, outside } = await fixture()
    const dispatch = vi.fn(async () => ({ ok: true as const, value: { text: 'inside' } }))
    const bridge = bridgeFor(alias, dispatch)
    await expect(bridge.call({ endpoint: 'workspaceFiles/read', payload: { args: { workspaceFileScopeId: 's1', path: 'sub/nested.txt' } } }))
      .resolves.toMatchObject({ ok: true })
    await expect(bridge.call({ endpoint: 'workspaceFiles/read', payload: { args: { workspaceFileScopeId: 's1', path: join(outside, 'secret.txt') } } }))
      .rejects.toMatchObject({ code: 'WORKSPACE_PATH_DENIED', details: { reason: 'outside-root' } })
  })

  it('reads only genuine external images from the configured session and root', async () => {
    const { root, outside } = await fixture()
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    const image = join(outside, 'image.png')
    const alias = join(dirname(outside), 'external-alias')
    const sibling = join(dirname(outside), 'outside-other.png')
    await writeFile(image, imageBytes)
    await writeFile(join(outside, 'fake.png'), 'not an image')
    await writeFile(sibling, imageBytes)
    await mkdir(join(outside, 'directory.png'))
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(sibling, join(outside, 'link.png'))
    const dispatch = vi.fn(async (endpoint: string, payload: unknown) => {
      const args = (payload as { args: { path: string; options?: { range?: { offset: number; length: number } } } }).args
      if (endpoint === 'workspaceFiles/stat') {
        const info = await stat(args.path)
        return { ok: true as const, value: { absolutePath: args.path, bytes: info.size } }
      }
      const data = await readFile(args.path)
      const range = args.options?.range
      return { ok: true as const, value: { data: range === undefined ? data : data.subarray(range.offset, range.offset + range.length) } }
    })
    const bridge = new HarnessRemoteBridge(
      gateway(dispatch), vi.fn(async () => undefined), undefined, '0.2.2-rc.3', undefined, undefined,
      async sessionId => sessionId === 's1' || sessionId === 's2' ? root : undefined,
      undefined, undefined, { sessionId: 's1', path: alias },
    )
    const call = (endpoint: string, path: string, sessionId = 's1', options?: object) =>
      bridge.call({ endpoint, payload: { args: { workspaceFileScopeId: sessionId, path, ...(options ? { options } : {}) } } })

    await expect(call('workspaceFiles/stat', join(alias, 'image.png'))).resolves.toMatchObject({ ok: true, value: { bytes: imageBytes.length } })
    await expect(call('workspaceFiles/readBytes', await realpath(image), 's1', {})).resolves.toMatchObject({ ok: true, value: { data: imageBytes.toString('base64') } })
    expect(dispatch).toHaveBeenLastCalledWith('workspaceFiles/readBytes', { args: { workspaceFileScopeId: 's1', path: await realpath(image), options: {} } }, expect.any(AbortSignal))
    await call('workspaceFiles/readBytes', await realpath(image), 's1', { range: { offset: 0, length: 8 } })
    expect(dispatch).toHaveBeenLastCalledWith('workspaceFiles/readBytes', { args: { workspaceFileScopeId: 's1', path: await realpath(image), options: { range: { offset: 0, length: 8 } } } }, expect.any(AbortSignal))

    const large = join(outside, 'large.png')
    const file = await open(large, 'w')
    try {
      await file.write(imageBytes.subarray(0, 8), 0, 8, 0)
      await file.truncate(4 * 1024 * 1024 + 1)
    } finally { await file.close() }
    await expect(call('workspaceFiles/readBytes', join(alias, 'large.png'), 's1', {})).rejects.toMatchObject({ code: 'WORKSPACE_TOO_LARGE', details: { reason: 'too-large' } })
    await expect(call('workspaceFiles/readBytes', join(alias, 'large.png'), 's1', { range: { offset: 0, length: 8 } }))
      .resolves.toMatchObject({ ok: true, value: { data: imageBytes.subarray(0, 8).toString('base64') } })

    for (const [endpoint, path, session, options] of [
      ['workspaceFiles/stat', image, 's2', undefined],
      ['workspaceFiles/stat', sibling, 's1', undefined],
      ['workspaceFiles/stat', join(outside, 'secret.txt'), 's1', undefined],
      ['workspaceFiles/stat', join(outside, 'fake.png'), 's1', undefined],
      ['workspaceFiles/stat', join(outside, 'directory.png'), 's1', undefined],
      ['workspaceFiles/stat', join(outside, 'link.png'), 's1', undefined],
      ['workspaceFiles/read', image, 's1', undefined],
      ['workspaceFiles/readBytes', 'image.png', 's1', { baseFile: image }],
    ] as const) {
      await expect(call(endpoint, path, session, options)).rejects.toMatchObject({ code: 'WORKSPACE_PATH_DENIED' })
    }
  })

  it('keeps baseFile traversal inside the same containment rules', async () => {
    const { root } = await fixture()
    const dispatch = vi.fn(async () => ({ ok: true as const, value: { text: 'inside' } }))
    const bridge = bridgeFor(root, dispatch)
    await expect(bridge.call({
      endpoint: 'workspaceFiles/readBytes',
      payload: { args: { workspaceFileScopeId: 's1', path: '../outside/secret.txt', options: { baseFile: 'inside.txt' } } },
    })).rejects.toMatchObject({ code: 'WORKSPACE_PATH_DENIED', details: { reason: 'outside-root' } })
    expect(dispatch).not.toHaveBeenCalled()
  })
})
