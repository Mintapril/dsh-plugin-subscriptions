/**
 * The Agent SDK transport's provider controls, without a network round trip:
 * the environment a CLI process is spawned with, the tool-name mapping the MCP
 * bridge relies on, the fast-mode overlay, the proxy plumbing, and the MCP
 * child's degraded mode (no bridge → catalog still declared, calls deferred).
 *
 * The live behaviour (tool boundary, result hand-back, cache TTL, interrupt) is
 * covered by the transport's own smoke run, which needs the real credential.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import './keep-alive.js'
import {
  CLAUDE_SDK_FAST_REFUSAL_HINTS,
  ClaudeSdkToolNames,
  ClaudeSdkTransport,
  claudeSdkEnv,
  fastCapabilityMatches,
  resolveClaudeSdkEntry,
} from '../src/providers/claude-agent-sdk.js'
import { Config } from '../src/index.js'

/** One constructed transport, closed by the caller. */
function transport(options: Partial<ConstructorParameters<typeof ClaudeSdkTransport>[0]> = {}): ClaudeSdkTransport {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sdk-spec-'))
  return new ClaudeSdkTransport({
    dir,
    configDir: join(dir, 'config'),
    workDir: join(dir, 'cwd'),
    idleTimeoutMs: 1_000,
    idleCloseMs: 60_000,
    ...options,
  })
}

test('claudeSdkEnv: provider controls become the documented CLI variables', () => {
  const env = claudeSdkEnv({
    baseEnv: { ANTHROPIC_API_KEY: 'sk-must-not-survive', ANTHROPIC_AUTH_TOKEN: 'nope', PATH: 'keep' },
    configDir: '/cfg',
    accessToken: 'sk-ant-oat01-test',
    promptCacheTtl: '1h',
    maxTokens: 321,
    proxyEnv: { HTTPS_PROXY: 'http://proxy.local:8080' },
  })
  assert.equal(env.CLAUDE_CODE_PROMPT_CACHE_TTL, '1h')
  assert.equal(env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, '1h')
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '321')
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-test')
  assert.equal(env.CLAUDE_CONFIG_DIR, '/cfg')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(env.HTTPS_PROXY, 'http://proxy.local:8080')
  assert.equal(env.PATH, 'keep')
})

test('claudeSdkEnv: isolation flags, and unset controls stay unset', () => {
  const env = claudeSdkEnv({ baseEnv: {}, configDir: '/cfg', accessToken: 't' })
  assert.equal(env.DISABLE_AUTOUPDATER, '1')
  assert.equal(env.DISABLE_TELEMETRY, '1')
  assert.equal(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, 'false')
  assert.equal(env.DISABLE_AUTOCOMPACT, '1')
  // Organization policy and remote settings must keep flowing to a managed account.
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined)
  assert.equal(env.CLAUDE_CODE_PROMPT_CACHE_TTL, undefined)
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined)
})

test('tool names: sanitized for the CLI and restored for the harness', () => {
  const names = new ClaudeSdkToolNames()
  assert.equal(names.register('echo'), 'echo')
  // The CLI adds `mcp__<server>__` itself, so the catalog carries the bare name.
  assert.equal(names.register('demo.tool one'), 'demo_tool_one')
  assert.equal(names.restore('mcp__dsh__echo'), 'echo')
  assert.equal(names.restore('mcp__dsh__demo_tool_one'), 'demo.tool one')
  assert.equal(names.restore('mcp__dsh__mcp__wincu__t'), 'mcp__wincu__t')
  assert.deepEqual(names.allowed(), ['mcp__dsh__echo', 'mcp__dsh__demo_tool_one'])
  // Registering twice keeps one entry.
  assert.equal(names.register('echo'), 'echo')
  assert.equal(names.allowed().length, 2)
})

test('fast mode: auto leaves Claude Code alone, on/off force the overlay', async () => {
  for (const [mode, expected] of [
    ['on', { fastMode: true }],
    ['off', { fastMode: false }],
    ['auto', {}],
  ] as const) {
    const instance = transport({ fastMode: mode })
    assert.deepEqual(instance.flagSettings(), expected)
    await instance.close()
  }
})

test('proxy: this plugin\'s proxy config becomes proxy variables', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sdk-proxy-'))
  const proxyPath = join(dir, 'proxy.json')
  writeFileSync(proxyPath, JSON.stringify({ enabled: true, url: 'http://127.0.0.1:7890', bypass: ['localhost'] }))
  const proxied = transport({ proxyPath })
  assert.deepEqual(proxied.proxyEnv(), {
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    HTTP_PROXY: 'http://127.0.0.1:7890',
    https_proxy: 'http://127.0.0.1:7890',
    http_proxy: 'http://127.0.0.1:7890',
    NO_PROXY: 'localhost',
    no_proxy: 'localhost',
  })
  await proxied.close()
  const absent = transport({ proxyPath: join(dir, 'absent.json') })
  assert.deepEqual(absent.proxyEnv(), {})
  await absent.close()
  rmSync(dir, { recursive: true, force: true })
})

test('SDK entry: an explicit path wins, and a missing installation refuses the route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sdk-entry-'))
  const explicit = join(dir, 'sdk.mjs')
  writeFileSync(explicit, 'export function query() { return null }' + String.fromCharCode(10))
  assert.equal(resolveClaudeSdkEntry(explicit), explicit)
  // A configured path that does not exist is not rescued by a discovered copy.
  assert.equal(resolveClaudeSdkEntry(join(dir, 'typo.mjs')), undefined)
  rmSync(dir, { recursive: true, force: true })

  const missing = transport({ sdkEntry: join(tmpdir(), 'no-such-sdk.mjs') })
  assert.equal(missing.available(), false)
  await assert.rejects(async () => {
    for await (const _chunk of missing.stream(
      { provider: 'claude', model: 'claude-sonnet-5', messages: [] },
      { model: 'claude-sonnet-5', accessToken: () => Promise.resolve('t') },
    )) {
      assert.fail('an unavailable transport must not produce chunks')
    }
  }, /Claude Agent SDK is not installed/)
  await missing.close()
})

test('MCP child: without a bridge it still declares the catalog and defers calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sdk-mcp-'))
  const toolsFile = join(dir, 'tools.json')
  writeFileSync(toolsFile, JSON.stringify([
    { name: 'echo', description: 'Echo text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  ]))
  const script = join(import.meta.dirname, '..', 'src', 'providers', 'claude-sdk-mcp.js')
  const built = existsSync(script) ? script : join(import.meta.dirname, '..', 'lib', 'providers', 'claude-sdk-mcp.js')
  const pipePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-claude-sdk-spec-${randomUUID()}`
    : join(dir, 'absent.sock')
  const child = spawn(
    process.execPath,
    [built, '--pipe', pipePath, '--token', 'spec', '--tools', toolsFile, '--connect-timeout-ms', '600'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const replies = new Map<number, Record<string, unknown>>()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (line.trim().length === 0) continue
      const message = JSON.parse(line) as { id?: number }
      if (message.id !== undefined) replies.set(message.id, message)
    }
  })
  const ask = async (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
    child.stdin.write(`${JSON.stringify(message)}\n`)
    const id = message.id as number
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const reply = replies.get(id)
      if (reply !== undefined) return reply
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(`no reply for ${String(message.method)}`)
  }

  try {
    const init = await ask({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })
    const capabilities = (init.result as { capabilities?: { tools?: unknown } })?.capabilities
    assert.ok(capabilities?.tools !== undefined, 'initialize must advertise tools')

    const list = await ask({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = (list.result as { tools?: { name?: string }[] })?.tools ?? []
    assert.deepEqual(tools.map(tool => tool.name), ['echo'])

    const call = await ask({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'x' }, _meta: { 'claudecode/toolUseId': 'toolu_spec' } },
    })
    const result = call.result as { content?: { text?: string }[]; isError?: boolean }
    assert.equal(result.isError, false)
    assert.match(result.content?.[0]?.text ?? '', /deferred/i)
  } finally {
    child.stdin.end()
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fast mode: the session choice wins, an explicit plugin policy overrides it', async () => {
  const auto = transport({ fastMode: 'auto' })
  assert.deepEqual(auto.flagSettings(), {}, 'no session choice leaves Claude Code alone')
  assert.deepEqual(auto.flagSettings({ fast: true }), { fastMode: true })
  assert.deepEqual(auto.flagSettings({ fast: false }), { fastMode: false })
  await auto.close()

  const forcedOff = transport({ fastMode: 'off' })
  assert.deepEqual(forcedOff.flagSettings({ fast: true }), { fastMode: false }, 'the plugin policy wins')
  await forcedOff.close()

  const forcedOn = transport({ fastMode: 'on' })
  assert.deepEqual(forcedOn.flagSettings({ fast: false }), { fastMode: true }, 'the plugin policy wins')
  await forcedOn.close()
})

test('fast capability: exact ids and family aliases both match', () => {
  const table = { exact: new Set(['opus', 'claude-opus-5-5']), aliases: new Set(['opus']) }
  // A bare alias is not a model id, so it only widens the family.
  assert.equal(fastCapabilityMatches(table, 'claude-opus-5-5'), true)
  assert.equal(fastCapabilityMatches(table, 'claude-opus-5'), true)
  assert.equal(fastCapabilityMatches(table, 'claude-sonnet-5'), false)
  assert.equal(fastCapabilityMatches(table, 'claude-haiku-4-5-20251001'), false)
  assert.equal(fastCapabilityMatches({ exact: new Set<string>(), aliases: new Set<string>() }, 'claude-opus-5-5'), false)
})

test('fast refusals: every documented reason explains itself', () => {
  for (const reason of ['preference', 'extra_usage_disabled', 'out_of_credits', 'model_not_allowed',
    'disabled_by_env', 'not_first_party', 'sdk_opt_in_required', 'cooldown', 'pending']) {
    assert.ok((CLAUDE_SDK_FAST_REFUSAL_HINTS[reason] ?? '').length > 10, `no hint for ${reason}`)
  }
  // The plan-policy reason must name the pay-as-you-go rule, which is the one
  // subscription-only accounts actually hit.
  assert.match(CLAUDE_SDK_FAST_REFUSAL_HINTS.preference!, /usage credits/)
})

test('config: the SDK transport is the default and its knobs are validated', () => {
  const defaults = Config({})
  assert.equal(defaults.claudeTransport, 'agent-sdk')
  assert.equal(defaults.claudeFastMode, 'auto')
  assert.equal(defaults.claudeIdleCloseMs, undefined)

  const chosen = Config({ claudeTransport: 'api', claudeFastMode: 'on', claudeIdleCloseMs: 60_000, claudeSdkEntry: '/x/sdk.mjs' })
  assert.equal(chosen.claudeTransport, 'api')
  assert.equal(chosen.claudeFastMode, 'on')
  assert.equal(chosen.claudeIdleCloseMs, 60_000)
  assert.equal(chosen.claudeSdkEntry, '/x/sdk.mjs')

  assert.throws(() => Config({ claudeTransport: 'nonsense' as unknown as 'api' }))
  assert.throws(() => Config({ claudeFastMode: 'nonsense' as unknown as 'on' }))
})