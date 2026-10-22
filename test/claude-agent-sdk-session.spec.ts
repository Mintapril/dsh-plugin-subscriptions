/**
 * The Agent SDK session's hand-off with the CLI, against a stand-in CLI that
 * behaves like the real one where it matters:
 *
 * - it runs on its own, so tool calls reach the bridge whether or not the
 *   harness is reading the stream;
 * - it runs harness (MCP) tools one at a time, because tools without a
 *   `readOnlyHint` are not concurrency-safe for Claude Code, so the second
 *   call only arrives after the first one is answered;
 * - while it waits on a tool it emits `tool_progress` heartbeats.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './keep-alive.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ClaudeSdkTransport } from '../src/providers/claude-agent-sdk.js'
import type { ClaudeSdkRoute } from '../src/providers/claude-agent-sdk.js'

type Frame = Record<string, unknown>

/** Heartbeat period of the stand-in; the real CLI uses 30s. */
const HEARTBEAT_MS = 100

/** A stand-in for one CLI process. */
class FakeCli {
  /** Every user message the harness pushed into the CLI, in order. */
  readonly prompts: Frame[] = []
  /** Every tool result the CLI received over the bridge, in call order. */
  readonly received: { id: string; text: string; isError: boolean }[] = []
  private readonly out: Frame[] = []
  private readonly readers: ((step: IteratorResult<Frame>) => void)[] = []
  private readonly promptWaiters: (() => void)[] = []
  private readonly replies = new Map<number, (result: unknown) => void>()
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly connected: Promise<void>
  private socket: net.Socket | undefined
  private buffer = ''
  private nextRequest = 1
  private closed = false

  constructor(params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) {
    const args = (params.options.mcpServers as { dsh: { args: string[] } }).dsh.args
    const pipe = args[args.indexOf('--pipe') + 1]!
    const token = args[args.indexOf('--token') + 1]!
    this.connected = new Promise((resolve, reject) => {
      const socket = net.connect(pipe, () => {
        socket.write(`${JSON.stringify({ t: 'hello', token })}\n`)
        resolve()
      })
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => this.fromBridge(chunk))
      socket.on('error', reject)
      this.socket = socket
    })
    void (async () => {
      for await (const message of params.prompt) {
        this.prompts.push(message as Frame)
        for (const wake of this.promptWaiters.splice(0)) wake()
      }
    })()
  }

  /** The query handle the session reads. */
  handle(): unknown {
    const next = (): Promise<IteratorResult<Frame>> => {
      const frame = this.out.shift()
      if (frame !== undefined) return Promise.resolve({ done: false, value: frame })
      if (this.closed) return Promise.resolve({ done: true, value: undefined })
      return new Promise(resolve => this.readers.push(resolve))
    }
    const handle = {
      next,
      return: async () => {
        this.close()
        return { done: true, value: undefined }
      },
      throw: async (error: unknown) => {
        throw error
      },
      [Symbol.asyncIterator]: () => handle,
      interrupt: async () => undefined,
      setModel: async () => undefined,
      applyFlagSettings: async () => undefined,
      close: () => this.close(),
    }
    return handle
  }

  /** Wait until the harness has pushed at least `count` user messages. */
  async waitPrompts(count: number): Promise<void> {
    while (this.prompts.length < count) await new Promise<void>(resolve => this.promptWaiters.push(resolve))
  }

  /** One assistant message that stops at the tool boundary. */
  toolTurn(ids: readonly string[]): void {
    this.event({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } })
    for (const [index, id] of ids.entries()) {
      this.event({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'mcp__dsh__read' } })
      this.event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{}' } })
      this.event({ type: 'content_block_stop', index })
    }
    this.event({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
    this.event({ type: 'message_stop' })
  }

  /** One finished text answer, with its result frame. */
  textTurn(text: string): void {
    this.event({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } })
    this.event({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
    this.event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    this.event({ type: 'content_block_stop', index: 0 })
    this.event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
    this.event({ type: 'message_stop' })
    this.emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })
  }

  /** One answer preceded by `ms` of steadily streamed thinking. */
  async thinkThenAnswer(ms: number, text: string): Promise<void> {
    this.event({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } })
    this.event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })
    const until = Date.now() + ms
    while (Date.now() < until && !this.closed) {
      this.event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm ' } })
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    this.event({ type: 'content_block_stop', index: 0 })
    this.event({ type: 'content_block_start', index: 1, content_block: { type: 'text' } })
    this.event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } })
    this.event({ type: 'content_block_stop', index: 1 })
    this.event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
    this.event({ type: 'message_stop' })
    this.emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })
  }

  /**
   * Call one harness tool over the bridge and wait for its result, emitting
   * heartbeats meanwhile, the way the CLI does for a running tool.
   */
  async callTool(id: string): Promise<void> {
    await this.connected
    const stop = this.heartbeats(id)
    try {
      const reqId = this.nextRequest++
      const reply = new Promise<unknown>(resolve => this.replies.set(reqId, resolve))
      this.socket?.write(`${JSON.stringify({ t: 'tools/call', reqId, toolUseId: id, name: 'read', args: {} })}\n`)
      const result = await reply as { content?: { text?: string }[]; isError?: boolean }
      this.received.push({
        id,
        text: (result.content ?? []).map(part => part.text ?? '').join(''),
        isError: result.isError === true,
      })
    } finally {
      stop()
    }
  }

  /** Emit heartbeats until the returned function is called. */
  heartbeats(id: string): () => void {
    const started = Date.now()
    const timer = setInterval(() => {
      this.emit({
        type: 'tool_progress',
        tool_use_id: id,
        tool_name: 'mcp__dsh__read',
        parent_tool_use_id: null,
        elapsed_time_seconds: Math.floor((Date.now() - started) / 1000),
        heartbeat: true,
      })
    }, HEARTBEAT_MS)
    this.timers.add(timer)
    return () => {
      clearInterval(timer)
      this.timers.delete(timer)
    }
  }

  /** Whether the session closed this CLI. */
  get isClosed(): boolean {
    return this.closed
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers.clear()
    this.socket?.destroy()
    for (const reader of this.readers.splice(0)) reader({ done: true, value: undefined })
  }

  private event(event: Frame): void {
    this.emit({ type: 'stream_event', event, parent_tool_use_id: null })
  }

  private emit(frame: Frame): void {
    if (this.closed) return
    const reader = this.readers.shift()
    if (reader !== undefined) reader({ done: false, value: frame })
    else this.out.push(frame)
  }

  private fromBridge(chunk: string): void {
    this.buffer += chunk
    let at: number
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + 1)
      if (line.trim().length === 0) continue
      const message = JSON.parse(line) as { t?: string; reqId?: number; result?: unknown }
      if (message.t !== 'result' || message.reqId === undefined) continue
      this.replies.get(message.reqId)?.(message.result)
      this.replies.delete(message.reqId)
    }
  }
}

/**
 * A transport whose SDK is the stand-in; `script` plays the CLI's side.
 * @returns the transport, the CLIs it started, and a cleanup function.
 */
function harness(
  script: (cli: FakeCli) => Promise<void>,
  { idleTimeoutMs = 5_000, idleCloseMs = 60_000 }: { idleTimeoutMs?: number; idleCloseMs?: number } = {},
): {
  sdk: ClaudeSdkTransport
  clis: FakeCli[]
  failures: unknown[]
  dispose: () => Promise<void>
} {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sdk-session-'))
  const entry = join(dir, 'fake-sdk.mjs')
  writeFileSync(entry, 'export function query(params) { return globalThis.__dshFakeClaudeQuery(params) }\n')
  const clis: FakeCli[] = []
  const failures: unknown[] = []
  ;(globalThis as { __dshFakeClaudeQuery?: unknown }).__dshFakeClaudeQuery = (params: ConstructorParameters<typeof FakeCli>[0]) => {
    const cli = new FakeCli(params)
    clis.push(cli)
    script(cli).catch((error: unknown) => failures.push(error))
    return cli.handle()
  }
  const sdk = new ClaudeSdkTransport({
    sdkEntry: entry,
    dir,
    configDir: join(dir, 'config'),
    workDir: join(dir, 'cwd'),
    idleTimeoutMs,
    idleCloseMs,
    onWarn: () => {},
  })
  return {
    sdk,
    clis,
    failures,
    dispose: async () => {
      await sdk.close()
      for (const cli of clis) cli.close()
      delete (globalThis as { __dshFakeClaudeQuery?: unknown }).__dshFakeClaudeQuery
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const route: ClaudeSdkRoute = { model: 'claude-opus-5-5', accessToken: async () => 'token' }

const user = (text: string): Frame => ({ role: 'user', content: [{ type: 'text', text }] })
const asked = (...ids: string[]): Frame => ({
  role: 'assistant',
  content: ids.map(id => ({ type: 'tool-call', id, name: 'read', arguments: '{}' })),
})
const said = (text: string): Frame => ({ role: 'assistant', content: [{ type: 'text', text }] })
const output = (id: string, text: string): Frame => ({ role: 'tool', toolCallId: id, content: [{ type: 'text', text }] })

/** One harness request for the same session. */
function request(messages: Frame[]): GenerateOptions {
  return {
    model: 'claude-opus-5-5',
    sessionId: 'session-1',
    messages,
    tools: [{ name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: {} } }],
  } as unknown as GenerateOptions
}

async function collect(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const finishOf = (chunks: StreamChunk[]): string | undefined =>
  (chunks.find(chunk => chunk.type === 'finish') as { reason?: { kind?: string } } | undefined)?.reason?.kind

const callIdsOf = (chunks: StreamChunk[]): string[] =>
  chunks.flatMap(chunk => (chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [String(chunk.block.id)] : []))

const textOf = (chunks: StreamChunk[]): string =>
  chunks.map(chunk => (chunk.type === 'text-delta' ? chunk.text : '')).join('')

/** The text of one pushed user message. */
const promptText = (prompt: Frame): string =>
  ((prompt.message as { content?: { type?: string; text?: string }[] }).content ?? [])
    .map(block => block.text ?? '')
    .join('')

test('serial tool calls: every result reaches the CLI as each call arrives', { timeout: 15_000 }, async () => {
  const { sdk, clis, failures, dispose } = harness(async (cli) => {
    await cli.waitPrompts(1)
    cli.toolTurn(['t1', 't2', 't3'])
    // Not concurrency-safe: the next call only goes out once the last is answered.
    for (const id of ['t1', 't2', 't3']) await cli.callTool(id)
    cli.textTurn('done')
  })
  try {
    const first = await collect(sdk.stream(request([user('fetch three pages')]), route))
    assert.equal(finishOf(first), 'tool-calls')
    assert.deepEqual(callIdsOf(first), ['t1', 't2', 't3'])

    const started = Date.now()
    const second = await collect(sdk.stream(request([
      user('fetch three pages'),
      asked('t1', 't2', 't3'),
      output('t1', 'page one'),
      output('t2', 'page two'),
      output('t3', 'page three'),
    ]), route))
    assert.equal(finishOf(second), 'stop')
    assert.equal(textOf(second), 'done')
    assert.deepEqual(clis[0]?.received, [
      { id: 't1', text: 'page one', isError: false },
      { id: 't2', text: 'page two', isError: false },
      { id: 't3', text: 'page three', isError: false },
    ])
    assert.ok(Date.now() - started < 5_000, `the results were handed over in ${Date.now() - started}ms`)
    assert.equal(clis.length, 1, 'the same CLI process continued the turn')
    assert.deepEqual(failures, [])
  } finally {
    await dispose()
  }
})

test('serial tool calls: a call the harness returned nothing for is answered, not left hanging', { timeout: 15_000 }, async () => {
  const { sdk, clis, failures, dispose } = harness(async (cli) => {
    await cli.waitPrompts(1)
    cli.toolTurn(['t1', 't2'])
    for (const id of ['t1', 't2']) await cli.callTool(id)
    cli.textTurn('done')
  })
  try {
    await collect(sdk.stream(request([user('two calls')]), route))
    const second = await collect(sdk.stream(request([
      user('two calls'),
      asked('t1', 't2'),
      output('t1', 'only the first'),
    ]), route))
    assert.equal(finishOf(second), 'stop')
    assert.equal(clis[0]?.received[0]?.text, 'only the first')
    assert.equal(clis[0]?.received[1]?.id, 't2')
    assert.equal(clis[0]?.received[1]?.isError, true)
    assert.deepEqual(failures, [])
  } finally {
    await dispose()
  }
})

test('heartbeats alone do not keep a stalled turn alive', { timeout: 10_000 }, async () => {
  const { sdk, dispose } = harness(async (cli) => {
    await cli.waitPrompts(1)
    // The CLI waits on something that never comes; only heartbeats flow.
    cli.heartbeats('stuck')
  }, { idleTimeoutMs: 1_000 })
  try {
    const started = Date.now()
    await assert.rejects(collect(sdk.stream(request([user('hello')]), route)), { code: 'TIMEOUT' })
    assert.ok(Date.now() - started < 5_000, `timed out after ${Date.now() - started}ms`)
  } finally {
    await dispose()
  }
})

test('a turn that keeps streaming is not reaped as idle, however long it runs', { timeout: 10_000 }, async () => {
  const { sdk, clis, failures, dispose } = harness(async (cli) => {
    await cli.waitPrompts(1)
    await cli.thinkThenAnswer(1_500, 'thought it through')
  }, { idleCloseMs: 500 })
  // The idle sweep runs on a 15s+ timer; drive it directly so the turn sees
  // what a real long turn sees once it outlives the reap window.
  const sweep = (): void => (sdk as unknown as { sweep(): void }).sweep()
  const sweeping = setInterval(sweep, 100)
  try {
    const chunks = await collect(sdk.stream(request([user('think hard')]), route))
    assert.equal(finishOf(chunks), 'stop')
    assert.equal(textOf(chunks), 'thought it through')
    assert.equal(clis[0]?.isClosed, false, 'the CLI survived its own turn')
    // Once the turn is over and the window passes, the idle CLI is reaped.
    await new Promise(resolve => setTimeout(resolve, 700))
    sweep()
    assert.equal(clis[0]?.isClosed, true, 'an idle CLI is still reaped')
    assert.deepEqual(failures, [])
  } finally {
    clearInterval(sweeping)
    await dispose()
  }
})

test('appended steps forward each harness message to the CLI exactly once', { timeout: 15_000 }, async () => {
  const { sdk, clis, failures, dispose } = harness(async (cli) => {
    await cli.waitPrompts(1)
    cli.toolTurn(['t1'])
    await cli.callTool('t1')
    cli.toolTurn(['t2'])
    await cli.callTool('t2')
    cli.textTurn('done')
    await cli.waitPrompts(3)
    cli.textTurn('you are welcome')
  })
  try {
    const step1 = [user('start')]
    await collect(sdk.stream(request(step1), route))

    const step2 = [...step1, asked('t1'), output('t1', 'one')]
    assert.equal(finishOf(await collect(sdk.stream(request(step2), route))), 'tool-calls')

    // A harness note (like the per-step time sample) joins after the result.
    const step3 = [...step2, asked('t2'), output('t2', 'two'), user('note: step 3')]
    const started = Date.now()
    const third = await collect(sdk.stream(request(step3), route))
    assert.equal(textOf(third), 'done')
    assert.ok(Date.now() - started < 5_000, `step 3 took ${Date.now() - started}ms`)

    const step4 = [...step3, said('done'), user('thanks')]
    assert.equal(textOf(await collect(sdk.stream(request(step4), route))), 'you are welcome')

    const cli = clis[0]
    assert.equal(clis.length, 1, 'every step appended to the same CLI process')
    assert.deepEqual(cli?.received.map(entry => entry.id), ['t1', 't2'])
    assert.deepEqual(cli?.prompts.slice(1).map(promptText), ['note: step 3', 'thanks'])
    assert.match(promptText(cli!.prompts[0]!), /<prior-conversation>/)
    assert.deepEqual(failures, [])
  } finally {
    await dispose()
  }
})
