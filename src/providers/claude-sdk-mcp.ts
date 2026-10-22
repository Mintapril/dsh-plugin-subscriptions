/**
 * MCP stdio server that stands in for the harness's tool set inside one Claude
 * Agent SDK session.
 *
 * It declares the harness tools (their real JSON Schemas, handed back by the
 * harness over the bridge pipe) so the model can call them natively, and it
 * forwards every call to the harness instead of executing anything itself: the
 * harness executes the tool under its own permission rules and answers with the
 * real result, which this process returns to the CLI.
 *
 * Degraded mode: when the bridge pipe cannot be reached, the catalog is read
 * from the fallback file and every call is answered with a "deferred" result,
 * which tells the model that the harness delivers the output in a subsequent
 * user message. Nothing is ever executed here either way.
 *
 * Usage:
 *   node claude-sdk-mcp.js --pipe <path> --token <secret> --tools <file>
 *                          [--connect-timeout-ms <n>] [--list-timeout-ms <n>]
 */

import { readFileSync } from 'node:fs'
import net from 'node:net'

/** One declared tool, as the CLI consumes it. */
interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Reply the harness sends for one request. */
interface HostReply {
  t: 'tools' | 'result'
  reqId?: number
  tools?: McpTool[]
  result?: unknown
}

const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string): string | undefined => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const pipePath = flag('--pipe')
const token = flag('--token')
const toolsFile = flag('--tools')
const connectTimeoutMs = Number(flag('--connect-timeout-ms', '20000'))
const listTimeoutMs = Number(flag('--list-timeout-ms', '15000'))

/** Tools the model may call when the harness is unreachable; [] when unreadable. */
let fallbackTools: McpTool[] = []
try {
  if (toolsFile !== undefined) fallbackTools = JSON.parse(readFileSync(toolsFile, 'utf8')) as McpTool[]
} catch {
  fallbackTools = []
}

const out = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
const note = (text: string): void => {
  process.stderr.write(`dsh-claude-sdk-mcp: ${text}\n`)
}

/** Pending host requests, keyed by request id. */
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let nextRequestId = 1
let socket: net.Socket | undefined
let catalog: McpTool[] = fallbackTools
let catalogVersion = 0

/** Resolve every in-flight host request so no CLI tool call is left hanging. */
function failPending(reason: string): void {
  for (const entry of pending.values()) entry.reject(new Error(reason))
  pending.clear()
}

function hostRequest(message: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (socket === undefined) {
      reject(new Error('harness bridge is not connected'))
      return
    }
    const reqId = Number(message.reqId)
    if (timeoutMs === undefined) {
      pending.set(reqId, { resolve, reject })
      socket.write(`${JSON.stringify(message)}\n`)
      return
    }
    const timer = setTimeout(() => {
      if (pending.delete(reqId)) reject(new Error('harness did not answer in time'))
    }, timeoutMs)
    pending.set(reqId, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    socket.write(`${JSON.stringify(message)}\n`)
  })
}

/**
 * Connect to the harness bridge, retrying while the host finishes changing
 * handles (the CLI may start the server before the host accepts).
 * @returns true when connected, false when the host never answered.
 */
function connect(): Promise<boolean> {
  const deadline = Date.now() + connectTimeoutMs
  return new Promise((resolve) => {
    const attempt = (): void => {
      const candidate = net.connect(pipePath ?? '', () => {
        socket = candidate
        candidate.setEncoding('utf8')
        let buffer = ''
        candidate.on('data', (chunk: string) => {
          buffer += chunk
          let at: number
          while ((at = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, at)
            buffer = buffer.slice(at + 1)
            if (line.trim().length === 0) continue
            receive(line)
          }
        })
        candidate.on('error', (error: Error) => note(`bridge error: ${error.message}`))
        candidate.on('close', () => {
          if (socket === candidate) socket = undefined
          failPending('harness bridge closed')
        })
        candidate.write(`${JSON.stringify({ t: 'hello', token })}\n`)
        resolve(true)
      })
      candidate.on('error', () => {
        candidate.destroy()
        if (Date.now() >= deadline) {
          note('harness bridge unreachable; running in deferred-results mode')
          resolve(false)
          return
        }
        setTimeout(attempt, 200)
      })
    }
    attempt()
  })
}

function receive(line: string): void {
  let message: HostReply
  try {
    message = JSON.parse(line) as HostReply
  } catch (error: unknown) {
    note(`bad bridge frame: ${String(error)}`)
    return
  }
  if (message.t === 'tools') {
    const entry = message.reqId === undefined ? undefined : pending.get(message.reqId)
    if (entry !== undefined && message.reqId !== undefined) {
      pending.delete(message.reqId)
      entry.resolve(message.tools ?? [])
    }
    return
  }
  if (message.t === 'result') {
    const entry = message.reqId === undefined ? undefined : pending.get(message.reqId)
    if (entry !== undefined && message.reqId !== undefined) {
      pending.delete(message.reqId)
      entry.resolve(message.result)
    }
    return
  }
  const extra = message as { t?: string; tools?: McpTool[] }
  if (extra.t === 'catalog') {
    const tools = extra.tools ?? []
    const changed = JSON.stringify(tools) !== JSON.stringify(catalog)
    catalog = tools
    catalogVersion += 1
    if (changed) out({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    return
  }
  if (extra.t === 'close') process.exit(0)
}

/** One MCP `tools/list`: prefer the harness (live catalog), fall back to the file. */
async function listTools(): Promise<McpTool[]> {
  if (socket === undefined) return catalog
  try {
    const reqId = nextRequestId++
    const tools = await hostRequest({ t: 'tools/list', reqId, version: catalogVersion }, listTimeoutMs)
    if (Array.isArray(tools)) catalog = tools as McpTool[]
    return catalog
  } catch (error: unknown) {
    note(`tools/list fell back to the bundled catalog: ${String(error)}`)
    return catalog
  }
}

/**
 * One MCP `tools/call`: forward to the harness and wait for the real result.
 * Nothing here ever executes a tool.
 */
async function callTool(params: {
  name?: string
  arguments?: unknown
  _meta?: Record<string, unknown>
} | undefined): Promise<unknown> {
  const toolUseId = params?._meta?.['claudecode/toolUseId'] ?? null
  const name = params?.name
  if (socket === undefined) {
    return {
      content: [{
        type: 'text',
        text: `Tool execution is deferred to the host harness: the result for "${String(name)}" arrives in a following user message. Do not call this tool again for the same request.`,
      }],
      isError: false,
    }
  }
  try {
    const reqId = nextRequestId++
    const result = await hostRequest({
      t: 'tools/call',
      reqId,
      toolUseId,
      name,
      args: params?.arguments ?? {},
    })
    if (result === undefined || typeof result !== 'object') {
      return { content: [{ type: 'text', text: 'The host returned no tool result.' }], isError: true }
    }
    return result
  } catch (error: unknown) {
    return {
      content: [{ type: 'text', text: `Tool bridge failed: ${String((error as Error)?.message ?? error)}` }],
      isError: true,
    }
  }
}

function handle(message: {
  id?: number
  method?: string
  params?: { protocolVersion?: string; name?: string; arguments?: unknown; _meta?: Record<string, unknown> }
}): void {
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      out({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'dsh', version: '0.0.1' },
        },
      })
      return
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return
    case 'ping':
      out({ jsonrpc: '2.0', id, result: {} })
      return
    case 'tools/list':
      void listTools().then((tools) => {
        out({ jsonrpc: '2.0', id, result: { tools } })
      }, (error: unknown) => {
        out({ jsonrpc: '2.0', id, result: { tools: catalog } })
        note(`tools/list failed: ${String(error)}`)
      })
      return
    case 'tools/call':
      void callTool(params).then((result) => {
        out({ jsonrpc: '2.0', id, result })
      }, (error: unknown) => {
        out({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `Tool call failed: ${String(error)}` }], isError: true },
        })
      })
      return
    case 'resources/list':
      out({ jsonrpc: '2.0', id, result: { resources: [] } })
      return
    case 'prompts/list':
      out({ jsonrpc: '2.0', id, result: { prompts: [] } })
      return
    default:
      if (id !== undefined) {
        out({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(method)}` } })
      }
  }
}

await connect()

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  input += chunk
  let at: number
  while ((at = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, at)
    input = input.slice(at + 1)
    if (line.trim().length === 0) continue
    try {
      handle(JSON.parse(line) as { id?: number; method?: string; params?: never })
    } catch (error: unknown) {
      note(`bad MCP frame: ${String(error)}`)
    }
  }
})
process.stdin.on('end', () => {
  failPending('stdio closed')
  process.exit(0)
})