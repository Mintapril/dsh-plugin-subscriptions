/**
 * The Settings model list's Refresh button, at its server half: what the
 * `providerSettings` RPC's `force` flag does to Claude's discovered catalog.
 *
 * Claude's catalog is cached in memory and on disk, and the ordinary model-list
 * read serves that cache on purpose (the startup/hourly job owns automatic
 * refreshes). A user pressing Refresh is the one caller that must ask the
 * provider again — otherwise the button cannot reveal a newly available model.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import './keep-alive.js'
import { ClaudeAdapter } from '../src/providers/claude.js'
import { AccountTokenManager } from '../src/providers/accounts.js'
import type { ClaudeSession } from '../src/auth/store.js'

const session: ClaudeSession = { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scopes: 'scope' }

function tokens(): AccountTokenManager<ClaudeSession> {
  return new AccountTokenManager<ClaudeSession>({
    provider: 'claude',
    displayName: 'Test',
    makeOptions: () => ({ preemptMs: 0, refresh: s => Promise.resolve(s), isPermanent: () => false }),
    io: {
      list: () => Promise.resolve([{ key: 'acct', session }]),
      get: () => Promise.resolve(session),
      save: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
  })
}

/** One adapter whose `/v1/models` answer the test controls. */
async function harness(wire: { current: { id: string; display_name?: string }[] }) {
  const original = globalThis.fetch
  let requests = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.includes('/v1/models')) throw new Error(`unexpected request: ${url}`)
    requests += 1
    return new Response(JSON.stringify({ data: wire.current }), { status: 200 })
  }) as typeof globalThis.fetch
  const adapter = new ClaudeAdapter({
    models: [{ id: 'built-in-1', name: 'Built-in 1' }],
    streamIdleTimeoutMs: 1_000,
    tokens: tokens(),
    discovery: true,
    onWarn: () => {},
    resolveCliVersion: async () => '2.1.999',
  })
  return {
    adapter,
    get requests(): number { return requests },
    restore: () => { globalThis.fetch = original },
  }
}

const ids = (models: readonly { id: string }[]): string[] => models.map(model => model.id)

test('refresh re-reads the provider catalog; an ordinary list read keeps the cache', async () => {
  const wire = { current: [{ id: 'claude-a', display_name: 'Claude A' }] }
  const h = await harness(wire)
  try {
    assert.deepEqual(ids(await h.adapter.listModels('claude')), ['claude-a'])
    assert.equal(h.requests, 1)

    // The account gains a model. Nothing changed from the plugin's point of
    // view yet: the list is served from the discovery cache.
    wire.current = [{ id: 'claude-a', display_name: 'Claude A' }, { id: 'claude-b', display_name: 'Claude B' }]
    assert.deepEqual(ids(await h.adapter.listModels('claude')), ['claude-a'])
    assert.equal(h.requests, 1)

    // Refresh (the RPC drops every account catalog first) asks again.
    h.adapter.clearAccountCatalog()
    assert.deepEqual(ids(await h.adapter.listModels('claude')), ['claude-a', 'claude-b'])
    assert.equal(h.requests, 2)
  } finally {
    h.restore()
  }
})

test('a failing refresh falls back to the built-in catalog and recovers on the next one', async () => {
  const wire = { current: [{ id: 'claude-a' }] }
  const h = await harness(wire)
  const original = globalThis.fetch
  try {
    assert.deepEqual(ids(await h.adapter.listModels('claude')), ['claude-a'])
    globalThis.fetch = (async () => new Response('boom', { status: 503 })) as typeof globalThis.fetch
    h.adapter.clearAccountCatalog()
    // Fail-closed on metadata only: the route stays usable with the built-in list.
    assert.deepEqual(ids(await h.adapter.listModels('claude')), ['built-in-1'])
    globalThis.fetch = original
    h.adapter.clearAccountCatalog()
    assert.deepEqual(ids(await h.adapter.listModels('claude')), ['claude-a'], 'the failure did not poison the cache')
  } finally {
    h.restore()
  }
})