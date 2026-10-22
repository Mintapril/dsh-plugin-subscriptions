/**
 * The Speed control's visibility list, end to end through the RPC: a logged-in
 * Claude account, a real (fake-module) Agent SDK, and the `speed` endpoint the
 * composer toggle reads.
 *
 * This covers a wiring bug that no adapter-level test could see: the transport
 * was constructed without `accessToken`, so the one-time fast-capability probe
 * returned an empty table for every model and the toggle never appeared — even
 * though the CLI answers `supportsFastMode: true` for `opus`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { accountKeyOf, saveAccountSession } from '../src/auth/store.js'
import type { ClaudeSession } from '../src/auth/store.js'
import * as plugin from '../src/index.js'
import { createFakeConnection } from './fake-connection.js'

/** A stand-in `sdk.mjs` whose model table answers without spawning a CLI. */
const FAKE_SDK = `
export function query() {
  return {
    next: async () => ({ done: false, value: { type: 'system', subtype: 'init' } }),
    supportedModels: async () => [
      { value: 'opus', resolvedModel: 'claude-opus-5-5', supportsFastMode: true },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', supportsFastMode: false },
    ],
    close: () => {},
  }
}
`

const session: ClaudeSession = {
  accessToken: 'sk-ant-oat01-test',
  refreshToken: 'refresh',
  expiresAt: Date.now() + 3_600_000,
  scopes: 'scope',
  emailAddress: 'me@example.com',
}

test('the Speed control learns which Claude models are fast-capable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-fast-rpc-'))
  const previousHome = process.env.DSH_HOME
  const previousFetch = globalThis.fetch
  process.env.DSH_HOME = home
  const sdkEntry = join(home, 'fake-sdk.mjs')
  writeFileSync(sdkEntry, FAKE_SDK)
  // The catalog lookup and the CLI-version lookup both ride the global fetch.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/v1/models')) {
      return new Response(JSON.stringify({
        data: [
          { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1_000_000 },
          { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
        ],
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ version: '2.1.287' }), { status: 200 })
  }) as typeof globalThis.fetch
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  ctx.provide('tools', { register: () => () => {} })
  const runtime = ctx.plugin(plugin, {
    providers: ['claude'],
    pool: { enabled: false },
    claudeTransport: 'agent-sdk',
    claudeSdkEntry: sdkEntry,
  })
  try {
    await saveAccountSession('claude', accountKeyOf('claude', session), session)
    await new Promise(resolve => setTimeout(resolve, 50))
    if (!connection.registered()) await runtime
    assert.ok(connection.registered())
    const call = (endpoint: string, payload: unknown) => connection.handler(endpoint, payload, new AbortController().signal)

    // The toggle's own read: exactly the fast-capable ids, nothing else.
    const state = await call('speed', { sessionId: 'session-1', model: 'claude-opus-5-5' })
    assert.ok(state.ok)
    assert.deepEqual((state.value as { fastModels: string[] }).fastModels, ['claude-opus-5-5'])
    assert.equal((state.value as { tier: string }).tier, 'standard', 'a session starts standard')

    // The same probe feeds the per-model subagent-speed control.
    const settings = await call('providerSettings', { provider: 'claude' })
    assert.ok(settings.ok)
    const rows = (settings.value as { models: { id: string; fastTier?: boolean }[] }).models
    assert.deepEqual(rows.map(row => [row.id, row.fastTier]), [
      ['claude-opus-5-5', true],
      ['claude-sonnet-5-5', false],
    ])
  } finally {
    await runtime.dispose()
    globalThis.fetch = previousFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})