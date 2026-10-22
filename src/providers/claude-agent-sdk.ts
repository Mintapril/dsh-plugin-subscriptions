/**
 * Claude Pro/Max subscription transport over the official Claude Agent SDK.
 *
 * Why this module exists: a subscription OAuth token may only be spent by the
 * official client. The direct transport in `claude.ts` posts to the Messages
 * API itself while presenting as the CLI, which the subscription terms do not
 * allow; this transport instead runs `@anthropic-ai/claude-agent-sdk` (the CLI
 * the SDK bundles) with the stored token in `CLAUDE_CODE_OAUTH_TOKEN`, so every
 * inference request is made by the official client.
 *
 * Tool ownership: the harness executes tools, not Claude Code. The SDK learns
 * the harness tool set through one MCP server that forwards every call back
 * here ({@link ClaudeSdkBridge}); the adapter stops at the assistant's tool
 * boundary (`finish: tool-calls`), the harness runs the tools under its own
 * permission rules, and the next request hands the real results back so the
 * CLI continues the same turn. One `stream()` call is therefore exactly one
 * model round trip, which is the contract the adapter already relies on.
 *
 * Claude Code's own agent loop never touches the workspace: built-in tools are
 * off, no settings source loads, and the only MCP server is that bridge.
 *
 * The SDK is an optional runtime dependency: its entry point is resolved (or
 * configured) at runtime and imported dynamically, so a profile without the
 * package simply reports the route as unavailable instead of failing to load.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AnthropicStreamEvent } from '../translate/anthropic.js'
import { AnthropicStreamTranslator, SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from '../translate/anthropic.js'
import type { TranslatableMessage } from '../translate/resolved.js'
import { hostSupportsImageOffload, IMAGE_OFFLOAD_REQUIRED, requiredImageOffloadCount, resolveImages } from '../translate/resolved.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, mapFetchFailure } from './common.js'

// ---------------------------------------------------------------------------
// The SDK surface this module uses
// ---------------------------------------------------------------------------

/*
 * The SDK package is 250MB with its bundled CLI, so it is not a declared
 * dependency and its own types are not imported: the shapes below are the
 * narrow contract this module relies on, and the installed version is checked
 * only for the options it must accept. A structural mismatch shows up as a
 * clear runtime failure instead of a hard build dependency.
 */

/** One declared MCP tool, in the shape the CLI consumes. */
export interface ClaudeSdkMcpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Anthropic usage block as the SDK reports it. */
interface SdkUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  thinking_tokens?: number
}

/** A complete assistant message, used when partial events are unavailable. */
interface SdkAssistantPayload {
  content?: readonly unknown[]
  stop_reason?: string | null
  usage?: SdkUsage
}

/** Streaming frame carrying one raw Messages-API event. */
interface SdkStreamEventMessage {
  type: 'stream_event'
  event: AnthropicStreamEvent
  parent_tool_use_id?: string | null
}

/** Whole-message frame. */
interface SdkAssistantMessage {
  type: 'assistant'
  message?: SdkAssistantPayload
  parent_tool_use_id?: string | null
}

/** Turn result frame: usage, stop reason, and failure classification. */
interface SdkResultMessage {
  type: 'result'
  subtype?: string
  is_error?: boolean
  stop_reason?: string | null
  usage?: SdkUsage
  session_id?: string
  api_error_status?: number | null
  errors?: readonly string[]
  num_turns?: number
  fast_mode_state?: 'off' | 'cooldown' | 'on'
  fast_mode_disabled_reason?: string
}

/** Startup and status frames. */
interface SdkSystemMessage {
  type: 'system'
  subtype?: string
  session_id?: string
  model?: string
  tools?: readonly string[]
}

/** Subscription window frame. */
interface SdkRateLimitMessage {
  type: 'rate_limit_event'
  rate_limit_info?: { status?: string; resetsAt?: number }
}

type SdkMessage = SdkStreamEventMessage | SdkAssistantMessage | SdkResultMessage | SdkSystemMessage | SdkRateLimitMessage

/** The interactive query handle returned by the SDK. */
export interface ClaudeSdkQuery extends AsyncGenerator<SdkMessage, void> {
  interrupt(): Promise<unknown>
  setModel(model?: string): Promise<void>
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>
  close(): void
  /** The CLI's model table, including which models can run fast mode. */
  supportedModels?(): Promise<readonly SdkModelRow[]>
}

/** One row of the CLI's model table. */
interface SdkModelRow {
  value?: string
  resolvedModel?: string
  displayName?: string
  supportsFastMode?: boolean
}

/** The `query()` entry point of the SDK module. */
export interface ClaudeSdkModule {
  query(params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }): ClaudeSdkQuery
}

/** One reasoning budget the CLI accepts. */
export type ClaudeSdkThinking =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens?: number }
  | { type: 'disabled' }

/** Everything one request hands the transport beyond the harness options. */
export interface ClaudeSdkRoute {
  /** Pool account this turn belongs to; absent means the default account. */
  account?: string
  model: string
  /** Reasoning effort resolved for this exact model. */
  effort?: string
  /** Thinking parameter resolved for this exact model. */
  thinking?: ClaudeSdkThinking
  /** Output cap resolved for this exact model. */
  maxTokens?: number
  /** Prompt-cache lifetime resolved from config and the per-model preference. */
  promptCacheTtl?: '5m' | '1h'
  /**
   * This session's Speed choice. `true` opts the SDK session into fast mode;
   * `false` keeps it standard; absent leaves the plugin's own policy in charge.
   */
  fast?: boolean
  /** Attachment service, for images the harness resolved into the request. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Read the stored subscription token; `force` refreshes it first. */
  accessToken: (force: boolean) => Promise<string>
  /** Ephemeral sessions never keep a process or declare tools. */
  ephemeral?: boolean
}

/** Construction options for {@link ClaudeSdkTransport}. */
export interface ClaudeSdkTransportOptions {
  /** Explicit `sdk.mjs` path; absent means discover an installation. */
  sdkEntry?: string
  /** Directory holding the tool catalogs and the per-session pipe. */
  dir: string
  /** Isolated `CLAUDE_CONFIG_DIR`, so the user's own Claude Code state is untouched. */
  configDir: string
  /** Working directory handed to the CLI. */
  workDir: string
  /** Idle timeout of one turn's stream read. */
  idleTimeoutMs: number
  /** How long an idle CLI process is kept for reuse. */
  idleCloseMs: number
  /** Fast-mode policy: `auto` leaves Claude Code's own setting alone. */
  fastMode?: 'auto' | 'on' | 'off'
  /** This plugin's proxy config, translated to proxy variables for the CLI. */
  proxyPath?: string
  onWarn?: (message: string) => void
  /** Diagnostic hook; the plugin logs session starts and cost here. */
  onLog?: (message: string, detail?: unknown) => void
  /** Raw result frame hook, for hosts that want per-turn cost accounting. */
  onResult?: (key: string, message: unknown) => void
  /** Read a subscription token for the one-time fast-capability probe. */
  accessToken?: (force: boolean) => Promise<string>
  /** How long a harness tool result waits for the CLI to report its call. */
  toolWaitMs?: number
  /** How long a late bridge handshake is awaited before degrading. */
  helloMs?: number
}

/**
 * What the adapter needs from the transport, so the plugin can refuse the route
 * with a clear error when the SDK is not installed instead of silently falling
 * back to the direct transport.
 */
export interface ClaudeSdkRouteStream {
  stream(options: GenerateOptions, route: ClaudeSdkRoute): AsyncGenerator<StreamChunk>
  /** Stop every CLI process; resolves once each teardown has been requested. */
  close(): Promise<void>
  /**
   * Whether the official CLI marks this model fast-capable. Model metadata
   * only: the account still needs usage credits for a fast turn to run fast.
   */
  supportsFast(model: string): Promise<boolean>
  /**
   * Drop any cached capability answer so the next {@link supportsFast} asks the
   * CLI again (the Settings model list's refresh calls this). Optional: an
   * implementation without a cache simply omits it.
   */
  invalidateFast?(): void
}

/**
 * A transport stand-in that refuses every turn with the given reason.
 * @param reason - operator-facing explanation.
 * @returns the refusal seam.
 */
export function claudeSdkUnavailable(reason: string): ClaudeSdkRouteStream {
  return {
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<StreamChunk> {
      throw new LlmError(reason, 'UNSUPPORTED')
    },
    async close(): Promise<void> {
      // Nothing was started.
    },
    async supportsFast(): Promise<boolean> {
      return false
    },
  }
}

/** Longest the one-time fast-capability probe may take before it answers nothing. */
const FAST_PROBE_TIMEOUT_MS = 20_000

/**
 * Bound the probe's control request.
 *
 * The Speed toggle reads the capability table when the composer mounts, so an
 * unbounded await would leave the control missing until the host restarts. A
 * timed-out probe answers as a failure instead, which the table already turns
 * into a retry after the cooldown.
 * @param work - the SDK's model-table request.
 * @returns the rows, or the promise rejects when the CLI did not answer in time.
 */
async function withFastProbeTimeout(work: Promise<readonly SdkModelRow[]>): Promise<readonly SdkModelRow[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<readonly SdkModelRow[]>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('the CLI did not answer the model-table request'))
        }, FAST_PROBE_TIMEOUT_MS)
        timer.unref()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** One capability answer carrying no fast models (probe skipped or failed). */
const EMPTY_FAST_TABLE: { exact: Set<string>; aliases: Set<string> } = { exact: new Set(), aliases: new Set() }

/** MCP server name the harness tool set is registered under. */
export const CLAUDE_SDK_MCP_SERVER = 'dsh'

/** Prefix the CLI puts in front of every MCP tool name. */
const MCP_TOOL_PREFIX = `mcp__${CLAUDE_SDK_MCP_SERVER}__`

/** Longest a tool result may wait for the CLI to report its call. */
const DEFAULT_TOOL_WAIT_MS = 30_000

/** How long the MCP child may take to reach the bridge before degrading. */
const DEFAULT_HELLO_MS = 20_000

/** Bytes kept from CLI stderr for diagnostics. */
const STDERR_TAIL = 4_000

/** Inline image budget carried by one request, mirroring the direct transport. */
const CLAUDE_REQUEST_IMAGE_BUDGET = 20 * 1024 * 1024

/** Per-image cap: 2000px edges, 3.75MB encoded (under the 5MB base64 limit). */
const CLAUDE_IMAGE_LIMIT = { maxEdge: 2000, maxBytes: 3_750_000 }

/** Built at runtime so bundlers never try to resolve the optional peer. */
const SDK_SPECIFIER = ['@anthropic-ai', 'claude-agent-sdk'].join('/')

/** Characters the CLI accepts in an MCP tool name. */
const TOOL_NAME_UNSAFE = /[^A-Za-z0-9_-]/g

// ---------------------------------------------------------------------------
// SDK discovery
// ---------------------------------------------------------------------------

/**
 * Candidate SDK entry points, most explicit first: an operator override, the
 * environment, this profile's own resolution, then every profile under the
 * harness home (the package is a large optional peer, so an installation that
 * already has it is reused instead of downloaded again).
 * @param explicit - entry path from plugin configuration.
 * @returns candidate `sdk.mjs` paths in preference order.
 */
export function claudeSdkEntryCandidates(explicit?: string): string[] {
  const candidates: string[] = []
  if (explicit !== undefined && explicit.length > 0) candidates.push(explicit)
  const fromEnv = process.env.DSH_CLAUDE_AGENT_SDK
  if (fromEnv !== undefined && fromEnv.length > 0) candidates.push(fromEnv)
  try {
    const resolved = createRequire(import.meta.url).resolve(SDK_SPECIFIER)
    if (typeof resolved === 'string' && resolved.length > 0) candidates.push(resolved)
  } catch {
    // Not installed in this profile; the scans below may still find one.
  }
  const profileRoot = join(homedir(), '.dsh', 'profiles')
  candidates.push(join(profileRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'))
  let names: string[] = []
  try {
    names = readdirSync(profileRoot)
  } catch {
    names = []
  }
  for (const name of names) {
    candidates.push(join(profileRoot, name, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'))
  }
  return candidates
}

/**
 * First existing SDK entry point. An explicit path is authoritative: a typo
 * must refuse the route loudly instead of silently borrowing another
 * profile's copy.
 * @param explicit - entry path from plugin configuration.
 * @returns the path, or undefined when no installation can be found.
 */
export function resolveClaudeSdkEntry(explicit?: string): string | undefined {
  if (explicit !== undefined && explicit.length > 0) {
    try {
      return existsSync(explicit) ? explicit : undefined
    } catch {
      return undefined
    }
  }
  for (const candidate of claudeSdkEntryCandidates()) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Keep looking.
    }
  }
  return undefined
}

const sdkLoads = new Map<string, Promise<ClaudeSdkModule>>()

/**
 * Import the SDK once per entry path; a failed import is retried next time.
 * @param entry - `sdk.mjs` path.
 * @returns the SDK module.
 */
export function loadClaudeSdk(entry: string): Promise<ClaudeSdkModule> {
  let loading = sdkLoads.get(entry)
  if (loading === undefined) {
    loading = import(pathToFileURL(entry).href)
      .then(module => module as unknown as ClaudeSdkModule)
      .catch((error: unknown) => {
        sdkLoads.delete(entry)
        throw error
      })
    sdkLoads.set(entry, loading)
  }
  return loading
}

/** The MCP child script, next to this module in every build layout. */
function mcpServerScript(): string {
  return fileURLToPath(new URL('./claude-sdk-mcp.js', import.meta.url))
}

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

/**
 * Bidirectional map between harness tool names and the CLI's MCP tool names.
 *
 * The CLI prefixes every MCP tool with `mcp__<server>__` itself and accepts
 * only `[A-Za-z0-9_-]`, so the catalog carries the bare sanitized name and the
 * reverse map restores the original name the harness knows.
 */
export class ClaudeSdkToolNames {
  private readonly forward = new Map<string, string>()
  private readonly back = new Map<string, string>()

  /**
   * Register one harness tool.
   * @param name - the harness tool name.
   * @returns the bare MCP tool name the CLI will expose.
   */
  register(name: string): string {
    const known = this.forward.get(name)
    if (known !== undefined) return known
    const base = name.replace(TOOL_NAME_UNSAFE, '_')
    let candidate = base
    for (let suffix = 2; this.back.has(candidate) && this.back.get(candidate) !== name; suffix++) {
      candidate = `${base}_${suffix}`
    }
    this.forward.set(name, candidate)
    this.back.set(candidate, name)
    return candidate
  }

  /**
   * Restore a harness tool name from the name the model used.
   * @param name - MCP tool name, optionally with the CLI's prefix.
   * @returns the harness tool name.
   */
  restore(name: string | undefined): string {
    const text = String(name ?? '')
    const bare = text.startsWith(MCP_TOOL_PREFIX) ? text.slice(MCP_TOOL_PREFIX.length) : text
    return this.back.get(text) ?? this.back.get(bare) ?? bare
  }

  /** Every fully qualified tool name, for `allowedTools`. */
  allowed(): string[] {
    return [...this.back.keys()].map(name => `${MCP_TOOL_PREFIX}${name}`)
  }
}

/**
 * Project the harness tool schemas into the MCP catalog the CLI consumes.
 * @param tools - harness tool schemas.
 * @param names - the session's name map.
 * @returns MCP tool definitions.
 */
function mcpCatalog(tools: GenerateOptions['tools'], names: ClaudeSdkToolNames): ClaudeSdkMcpTool[] {
  const catalog: ClaudeSdkMcpTool[] = []
  for (const tool of tools ?? []) {
    if (typeof tool?.name !== 'string' || tool.name.length === 0) continue
    const parameters = typeof tool.parameters === 'object' && tool.parameters !== null ? tool.parameters : {}
    catalog.push({
      name: names.register(tool.name),
      description: typeof tool.description === 'string' ? tool.description : tool.name,
      inputSchema: { type: 'object', ...parameters },
    })
  }
  return catalog
}

// ---------------------------------------------------------------------------
// Message projection
// ---------------------------------------------------------------------------

/** Stable digest of one harness message, for append-only detection. */
function messageDigest(message: TranslatableMessage): string {
  const toolCallId = (message as { toolCallId?: unknown }).toolCallId
  return createHash('sha1')
    .update(JSON.stringify([message.role, toolCallId ?? null, message.content]))
    .digest('hex')
}

/** Digest of a text blob. */
function textDigest(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/** Digest of the declared tool set, so a changed schema rebuilds the session. */
function toolDigest(tools: GenerateOptions['tools']): string {
  const rows = (tools ?? []).map(tool => [tool?.name ?? '', tool?.description ?? '', tool?.parameters ?? null])
  rows.sort((left, right) => (String(left[0]) < String(right[0]) ? -1 : 1))
  return createHash('sha1').update(JSON.stringify(rows)).digest('hex')
}

/** Index of the first non-system message; the system slot ends there. */
function conversationStart(messages: readonly { role: string }[]): number {
  const index = messages.findIndex(message => message.role !== 'system')
  return index === -1 ? messages.length : index
}

/** Concatenate a message's text blocks. */
function messageText(message: TranslatableMessage): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * The messages the CLI must receive: everything except the leading system slot
 * and model-produced assistant turns, which the CLI already holds.
 * @param messages - request messages.
 * @returns the harness-side messages in conversation order.
 */
function harnessSideMessages(messages: readonly TranslatableMessage[]): TranslatableMessage[] {
  const start = conversationStart(messages)
  const out: TranslatableMessage[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') continue
    if (message.role === 'system' && index < start) continue
    out.push(message)
  }
  return out
}

/** The rendered system prompt: the explicit one plus every leading system message. */
function systemTextOf(options: GenerateOptions): string {
  const messages = options.messages ?? []
  const start = conversationStart(messages)
  const parts: string[] = []
  if (typeof options.system === 'string' && options.system.trim().length > 0) parts.push(options.system)
  for (const message of messages.slice(0, start)) {
    const text = messageText(message as TranslatableMessage)
    if (text.trim().length > 0) parts.push(text)
  }
  return parts.join('\n\n')
}

/** Tool result content for one tool-role message, images kept native. */
function toolResultContent(message: { content: readonly unknown[] }): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = []
  for (const raw of message.content) {
    const block = raw as { type?: string; text?: string; dataBase64?: string; mediaType?: string; attachment?: { name?: string } }
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image' && typeof block.dataBase64 === 'string') {
      parts.push({ type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.dataBase64 } })
    } else if (block.type === 'file') {
      parts.push({ type: 'text', text: `[file ${String(block.attachment?.name ?? 'attachment')}]` })
    }
  }
  if (parts.length === 0) parts.push({ type: 'text', text: '(no output)' })
  return parts
}

/**
 * Anthropic-shaped content blocks for one harness-side message.
 * @param message - a user, tool, developer, or mid-conversation system message.
 * @returns content blocks for one SDK user message.
 */
function userContentBlocks(message: TranslatableMessage): Record<string, unknown>[] {
  if (message.role === 'tool') {
    const source = message.source as { kind?: string; callId?: unknown } | undefined
    const id = (message as { toolCallId?: unknown }).toolCallId ?? (source?.kind === 'tool' ? source.callId : undefined)
    if (id === undefined) throw new LlmError('tool result has no call id', 'INVALID_REQUEST')
    return [{
      type: 'tool_result',
      tool_use_id: String(id),
      content: toolResultContent(message),
      ...(message as { isError?: boolean }).isError === true ? { is_error: true } : {},
    }]
  }
  const wrapped = message.role === 'system' || message.role === 'developer'
  const blocks: Record<string, unknown>[] = []
  for (const raw of message.content) {
    const block = raw as { type?: string; text?: string; dataBase64?: string; mediaType?: string; toolCallId?: unknown; content?: readonly unknown[]; isError?: boolean }
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      blocks.push({ type: 'text', text: wrapped ? `${SYSTEM_REMINDER_OPEN}${block.text}${SYSTEM_REMINDER_CLOSE}` : block.text })
      continue
    }
    if (block.type === 'image' && typeof block.dataBase64 === 'string') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.dataBase64 } })
      continue
    }
    if (block.type === 'tool-result' && block.toolCallId !== undefined) {
      blocks.push({
        type: 'tool_result',
        tool_use_id: String(block.toolCallId),
        content: toolResultContent({ content: block.content ?? [] }),
        ...block.isError === true ? { is_error: true } : {},
      })
    }
  }
  if (blocks.length === 0) {
    blocks.push({
      type: 'text',
      text: wrapped ? `${SYSTEM_REMINDER_OPEN}(no content)${SYSTEM_REMINDER_CLOSE}` : '(no content)',
    })
  }
  return blocks
}

/**
 * One user message replaying a whole conversation, used when a CLI session
 * starts or has to be rebuilt: the CLI only accepts user turns, so assistant
 * turns and settled tool calls ride as labelled text.
 * @param messages - the request's messages, images already resolved.
 * @returns content blocks for the single replay message.
 */
function transcriptBlocks(messages: readonly TranslatableMessage[]): Record<string, unknown>[] {
  const start = conversationStart(messages)
  const sections: string[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system' && index < start) continue
    if (message.role === 'assistant') {
      const calls = message.content
        .filter(block => block.type === 'tool-call')
        .map(block => `[tool call ${(block as { name: string }).name}(${(block as { arguments: string }).arguments})]`)
      const text = messageText(message)
      const body = [text, ...calls].filter(part => part.length > 0).join('\n')
      if (body.length > 0) sections.push(`[assistant]\n${body}`)
      continue
    }
    if (message.role === 'tool') {
      const source = message.source as { kind?: string; callId?: unknown } | undefined
      const id = (message as { toolCallId?: unknown }).toolCallId ?? (source?.kind === 'tool' ? source.callId : undefined) ?? '?'
      const text = message.content
        .map(block => (block.type === 'text' ? block.text : block.type === 'image' ? '[image]' : ''))
        .join('\n')
      const failed = (message as { isError?: boolean }).isError === true ? ' (error)' : ''
      sections.push(`[tool result ${String(id)}${failed}]\n${text}`)
      continue
    }
    const text = messageText(message)
    if (text.length > 0) sections.push(`${message.role === 'user' ? '[user]' : '[harness note]'}\n${text}`)
    for (const block of message.content) {
      if (block.type === 'file') {
        const name = (block as { attachment?: { name?: string } }).attachment?.name ?? 'attachment'
        sections.push(`[user attached file ${String(name)}]`)
      }
    }
  }
  const body = sections.join('\n\n')
  const blocks: Record<string, unknown>[] = [{
    type: 'text',
    text: `<prior-conversation>\n${body.length > 0 ? body : '(no earlier turns)'}\n</prior-conversation>`,
  }]
  blocks.push(...newestImages(messages))
  return blocks
}

/** Resolved image blocks of the newest user turn, in conversation order. */
function newestImages(messages: readonly TranslatableMessage[]): Record<string, unknown>[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message === undefined || message.role !== 'user') continue
    const images: Record<string, unknown>[] = []
    for (const block of message.content) {
      const candidate = block as { type?: string; dataBase64?: string; mediaType?: string }
      if (candidate.type === 'image' && typeof candidate.dataBase64 === 'string') {
        images.push({ type: 'image', source: { type: 'base64', media_type: candidate.mediaType, data: candidate.dataBase64 } })
      }
    }
    return images
  }
  return []
}

/** Append-only check: every already-delivered digest is the same prefix here. */
function isPrefix(sent: readonly string[], next: readonly string[]): boolean {
  if (sent.length > next.length) return false
  for (const [index, digest] of sent.entries()) {
    if (digest !== next[index]) return false
  }
  return true
}

/** Sum two usage reports (one harness turn may contain several round trips). */
function addUsage(total: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (next === undefined) return total
  if (total === undefined) return { ...next }
  const sum: TokenUsage = {
    inputTokens: (total.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (next.outputTokens ?? 0),
  }
  const cacheRead = (total.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0)
  const cacheWrite = (total.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0)
  if (cacheRead > 0) sum.cacheReadTokens = cacheRead
  if (cacheWrite > 0) sum.cacheWriteTokens = cacheWrite
  return sum
}

/** Token usage reported by a `result` frame. */
function resultUsage(message: SdkResultMessage): TokenUsage | undefined {
  const usage = message.usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const total: TokenUsage = {
    inputTokens: Number(usage.input_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
  }
  const cacheRead = Number(usage.cache_read_input_tokens ?? 0)
  const cacheWrite = Number(usage.cache_creation_input_tokens ?? 0)
  if (cacheRead > 0) total.cacheReadTokens = cacheRead
  if (cacheWrite > 0) total.cacheWriteTokens = cacheWrite
  if (Number(usage.thinking_tokens ?? 0) > 0) total.reasoningTokens = Number(usage.thinking_tokens)
  return total
}

/**
 * Classify a failed `result` frame into a harness failure code.
 * @param message - the SDK result frame.
 * @returns the harness code.
 */
function resultFailureCode(message: SdkResultMessage): string {
  const status = typeof message.api_error_status === 'number' ? message.api_error_status : undefined
  const text = [message.subtype, ...Array.isArray(message.errors) ? message.errors : []].join(' ')
  if (status === 401 || status === 403 || /authenticat|credential|oauth token|invalid api key/i.test(text)) return 'AUTH'
  if (status === 429 || /rate limit|usage limit|limit reached|out of usage/i.test(text)) return 'RATE_LIMIT'
  if (status === 413 || /prompt is too long|context (window|length)|too many tokens/i.test(text)) {
    return CONTEXT_WINDOW_EXCEEDED_CODE
  }
  if (status !== undefined && status >= 500) return 'SERVER'
  if (status !== undefined && status >= 400) return 'INVALID_REQUEST'
  return 'SERVER'
}

/**
 * Build the environment for one CLI process.
 *
 * Exported so the provider controls can be asserted without spawning a CLI:
 * every knob the direct transport sends on the wire (prompt-cache TTL, output
 * cap, proxy) becomes the documented Claude Code environment variable here,
 * and no credential other than the subscription token survives.
 * @param params - directory, credential, resolved controls, proxy variables.
 * @returns the environment for the SDK subprocess.
 */
export function claudeSdkEnv(params: {
  configDir: string
  accessToken: string
  promptCacheTtl?: '5m' | '1h'
  maxTokens?: number
  proxyEnv?: Record<string, string>
  baseEnv?: NodeJS.ProcessEnv
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(params.baseEnv ?? process.env) }
  for (const name of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  ]) {
    delete env[name]
  }
  env.CLAUDE_CONFIG_DIR = params.configDir
  env.CLAUDE_CODE_OAUTH_TOKEN = params.accessToken
  // Identify this host honestly, and keep optional spend and telemetry off.
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'dsh-plugin-subscriptions'
  env.DISABLE_TELEMETRY = '1'
  env.DISABLE_ERROR_REPORTING = '1'
  env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = 'false'
  env.DISABLE_AUTOCOMPACT = '1'
  // Never let the bundled CLI replace itself behind the host's back. Policy and
  // remote-settings traffic is deliberately NOT disabled: an org-managed
  // account must keep receiving its own policy limits.
  env.DISABLE_AUTOUPDATER = '1'
  if (params.promptCacheTtl !== undefined) {
    env.CLAUDE_CODE_PROMPT_CACHE_TTL = params.promptCacheTtl
    env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL = params.promptCacheTtl
  }
  if (params.maxTokens !== undefined) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(params.maxTokens)
  Object.assign(env, params.proxyEnv ?? {})
  return env
}

/** Reject a promise when the caller aborts, without cancelling the producer. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new LlmError('claude agent sdk request aborted by caller', 'ABORTED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LlmError('claude agent sdk request aborted by caller', 'ABORTED'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

/** Unbounded push queue shaped as the SDK's streaming-input iterable. */
class UserInputQueue implements AsyncIterableIterator<unknown> {
  private readonly items: unknown[] = []
  private readonly waiters: ((result: IteratorResult<unknown>) => void)[] = []
  private closed = false

  push(message: unknown): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ value: message, done: false })
    else this.items.push(message)
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
    return this
  }

  next(): Promise<IteratorResult<unknown>> {
    const item = this.items.shift()
    if (item !== undefined) return Promise.resolve({ value: item, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise(resolve => {
      this.waiters.push(resolve)
    })
  }

  return(): Promise<IteratorResult<unknown>> {
    this.close()
    return Promise.resolve({ value: undefined, done: true })
  }
}

// ---------------------------------------------------------------------------
// Bridge: the harness side of the MCP tool channel
// ---------------------------------------------------------------------------

/** What the bridge asks a session for when the CLI needs something. */
interface ClaudeSdkBridgeHandlers {
  /** The catalog the CLI may declare right now. */
  tools: () => ClaudeSdkMcpTool[]
  /** Deliver one tool call and wait for the harness's real result. */
  call: (call: { toolUseId: string | null; name: string; arguments: Record<string, unknown> }) => Promise<unknown>
}

/**
 * Named-pipe server that answers the MCP child's catalog and tool-call
 * requests. One listener serves every session; the secret handed to each child
 * routes it back to its own session.
 */
export class ClaudeSdkBridge {
  private readonly dir: string
  private readonly onWarn: ((message: string) => void) | undefined
  private pipePath: string | undefined
  private server: net.Server | undefined
  private starting: Promise<string> | undefined
  /** session key → live socket */
  private readonly connections = new Map<string, net.Socket>()
  /** token → session key */
  private readonly tokens = new Map<string, string>()
  /** session key → request handlers */
  private readonly handlers = new Map<string, ClaudeSdkBridgeHandlers>()
  /** session key → hello resolver */
  private readonly helloWaiters = new Map<string, () => void>()

  constructor(options: { dir: string; onWarn?: (message: string) => void }) {
    this.dir = options.dir
    this.onWarn = options.onWarn
  }

  /** Start the listener once and return its address. */
  async address(): Promise<string> {
    if (this.pipePath !== undefined) return this.pipePath
    this.starting ??= this.start()
    return this.starting
  }

  private async start(): Promise<string> {
    const path = process.platform === 'win32'
      ? `\\\\.\\pipe\\dsh-claude-sdk-${randomUUID()}`
      : join(this.dir, `bridge-${process.pid}.sock`)
    const server = net.createServer(socket => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    server.on('error', (error: unknown) => {
      this.onWarn?.(`claude agent sdk bridge error: ${String((error as Error)?.message ?? error)}`)
    })
    server.unref()
    this.server = server
    this.pipePath = path
    return path
  }

  /**
   * Reserve a channel for one session.
   * @param key - session key.
   * @param handlers - catalog and tool-call callbacks.
   * @returns the pipe address and this session's secret.
   */
  async channel(key: string, handlers: ClaudeSdkBridgeHandlers): Promise<{ pipePath: string; token: string }> {
    const pipePath = await this.address()
    const token = randomUUID()
    this.tokens.set(token, key)
    this.handlers.set(key, handlers)
    return { pipePath, token }
  }

  /** Drop one session's channel and tell its child to exit. */
  release(key: string): void {
    const socket = this.connections.get(key)
    this.connections.delete(key)
    if (socket !== undefined) {
      try {
        socket.write(`${JSON.stringify({ t: 'close' })}\n`)
        socket.end()
      } catch {
        // Already gone.
      }
    }
    this.handlers.delete(key)
    this.helloWaiters.delete(key)
    for (const [token, owner] of [...this.tokens]) {
      if (owner === key) this.tokens.delete(token)
    }
  }

  /** Write one frame to a session's child, when it is connected. */
  send(key: string, message: Record<string, unknown>): boolean {
    const socket = this.connections.get(key)
    if (socket === undefined) return false
    try {
      socket.write(`${JSON.stringify(message)}\n`)
      return true
    } catch {
      return false
    }
  }

  /** Whether a session's child has connected to the bridge. */
  isConnected(key: string): boolean {
    return this.connections.has(key)
  }

  /**
   * Wait until a session's child says hello.
   * @param key - session key.
   * @param timeoutMs - how long to wait.
   * @returns true when connected.
   */
  async waitForHello(key: string, timeoutMs: number): Promise<boolean> {
    if (this.connections.has(key)) return true
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (connected: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.helloWaiters.delete(key)
        resolve(connected)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref()
      this.helloWaiters.set(key, () => finish(true))
    })
  }

  private accept(socket: net.Socket): void {
    socket.setEncoding('utf8')
    const state: { key?: string; buffer: string } = { buffer: '' }
    socket.on('data', (chunk: string) => {
      state.buffer += chunk
      let at: number
      while ((at = state.buffer.indexOf('\n')) >= 0) {
        const line = state.buffer.slice(0, at)
        state.buffer = state.buffer.slice(at + 1)
        if (line.trim().length === 0) continue
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        void this.receive(state, socket, message)
      }
    })
    socket.on('error', () => {
      if (state.key !== undefined && this.connections.get(state.key) === socket) this.connections.delete(state.key)
    })
    socket.on('close', () => {
      if (state.key !== undefined && this.connections.get(state.key) === socket) this.connections.delete(state.key)
    })
  }

  private async receive(
    state: { key?: string; buffer: string },
    socket: net.Socket,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (message.t === 'hello') {
      const key = this.tokens.get(String(message.token))
      if (key === undefined) {
        socket.destroy()
        return
      }
      state.key = key
      this.connections.set(key, socket)
      this.helloWaiters.get(key)?.()
      return
    }
    const key = state.key
    if (key === undefined) return
    const handlers = this.handlers.get(key)
    if (message.t === 'tools/list') {
      const tools = handlers?.tools() ?? []
      this.write(socket, { t: 'tools', reqId: message.reqId, tools })
      return
    }
    if (message.t === 'tools/call') {
      let result: unknown
      try {
        result = await handlers?.call({
          toolUseId: typeof message.toolUseId === 'string' ? message.toolUseId : null,
          name: String(message.name),
          arguments: typeof message.args === 'object' && message.args !== null
            ? message.args as Record<string, unknown>
            : {},
        })
      } catch (error: unknown) {
        result = {
          content: [{ type: 'text', text: `harness rejected the call: ${String((error as Error)?.message ?? error)}` }],
          isError: true,
        }
      }
      if (result === undefined) {
        result = { content: [{ type: 'text', text: 'harness closed before answering' }], isError: true }
      }
      this.write(socket, { t: 'result', reqId: message.reqId, result })
    }
  }

  private write(socket: net.Socket, message: Record<string, unknown>): void {
    try {
      socket.write(`${JSON.stringify(message)}\n`)
    } catch {
      // The child is gone; its CLI process is already lost.
    }
  }

  /** Stop the listener and drop every channel. */
  close(): void {
    for (const key of [...this.handlers.keys()]) this.release(key)
    try {
      this.server?.close()
    } catch {
      // Already closed.
    }
    this.server = undefined
    this.pipePath = undefined
    this.starting = undefined
  }
}

// ---------------------------------------------------------------------------
// Session: one CLI process per harness session
// ---------------------------------------------------------------------------

/** The signature a live CLI process was started with. */
interface ClaudeSdkSignature {
  model: string
  system: string
  tools: string
  effort: string
  thinking: string
  cache: string
  maxTokens: string
  fastMode: string
}

/** What one request contributes to the append-or-rebuild decision. */
interface ClaudeSdkPlan {
  mode: 'append' | 'rebuild'
  signature: ClaudeSdkSignature
  systemText: string
  sideHashes: string[]
  freshMessages: TranslatableMessage[]
  softChanged: boolean
}

/**
 * Whether one model id falls inside a capability table.
 *
 * The CLI lists both bare family aliases (`opus`) and concrete ids
 * (`claude-opus-5-5`); an exact match wins, and a family alias covers every id
 * of that family, so a dated spelling the CLI did not enumerate still counts.
 * @param table - exact ids and family aliases the CLI marks fast-capable.
 * @param model - the model id the harness routes to.
 * @returns whether that model can run fast mode.
 */
export function fastCapabilityMatches(
  table: { exact: ReadonlySet<string>; aliases: ReadonlySet<string> },
  model: string,
): boolean {
  if (table.exact.has(model)) return true
  for (const alias of table.aliases) {
    if (model.startsWith(`claude-${alias}`)) return true
  }
  return false
}

/**
 * What each fast-mode refusal means for the operator, in one line. The CLI's
 * reason codes come from its own fast-mode gate; `preference` is the plan
 * policy one, and `extra_usage_disabled`/`out_of_credits` are the credits gate.
 */
export const CLAUDE_SDK_FAST_REFUSAL_HINTS: Record<string, string> = {
  preference: 'the account policy keeps fast mode off — Claude fast mode bills as usage credits (pay-as-you-go) and is not part of a subscription plan',
  extra_usage_disabled: 'usage credits are not enabled for this account, so fast mode cannot run',
  out_of_credits: 'usage credits are exhausted',
  org_level_disabled: 'your organization turned fast mode off',
  org_level_disabled_until: 'your organization limited usage credits',
  member_level_disabled: 'usage credits are turned off for this account',
  seat_tier_level_disabled: 'this seat plan does not include usage credits',
  overage_not_provisioned: 'overage billing is not provisioned for this account',
  no_limits_configured: 'no usage-credit limits are configured for this account',
  model_not_allowed: 'this model does not support fast mode',
  not_first_party: 'fast mode is only available on the first-party API',
  disabled_by_env: 'fast mode is disabled in this environment',
  sdk_opt_in_required: 'the SDK session did not opt in to fast mode',
  cooldown: 'fast mode is cooling down after a rate limit',
  pending: 'the account state was still loading',
}

/** One in-flight tool call the CLI is waiting on. */
interface PendingToolCall {
  id: string
  name: string
  resolve: (result: unknown) => void
}

/**
 * One live CLI session. Every `stream()` call consumes exactly one model round
 * trip: the generator stops at the assistant's tool boundary, and the next call
 * answers those tool calls and reads the continuation.
 */
export class ClaudeSdkSession {
  private readonly transport: ClaudeSdkTransport
  readonly key: string
  private query: ClaudeSdkQuery | undefined
  private iterator: AsyncGenerator<SdkMessage, void> | undefined
  private input: UserInputQueue | undefined
  private signature: ClaudeSdkSignature | undefined
  /** Digests of the harness-side messages already delivered to this CLI. */
  private sentHashes: string[] = []
  /** Tool calls the CLI is waiting on, keyed by tool-use id. */
  private readonly pendingCalls = new Map<string, PendingToolCall>()
  /** Tool calls the last assistant turn asked for, keyed by tool-use id. */
  private expectedCalls = new Map<string, { id: string; name: string }>()
  /** Wake-ups waiting for a tool call to arrive over the bridge. */
  private readonly callWaiters = new Set<() => void>()
  private readonly toolNames = new ClaudeSdkToolNames()
  private catalog: ClaudeSdkMcpTool[] = []
  private degraded = false
  private degradedWarned = false
  private dirty = false
  private partialSeen = false
  private ready = false
  private lastUsed = Date.now()
  private lastRateLimit: { status?: string; resetsAt?: number } | undefined
  private forceToken = false
  /** Whether this turn asked the CLI for fast mode. */
  private fastRequested = false
  /** Reason already reported for this CLI process, so a refusal warns once. */
  private fastRefusalReported: string | undefined

  constructor(transport: ClaudeSdkTransport, key: string) {
    this.transport = transport
    this.key = key
  }

  /** Mark the session as used so the idle sweep leaves it alone. */
  touch(): void {
    this.lastUsed = Date.now()
  }

  /** Hold the CLI's tool call until the harness supplies its result. */
  private readonly onToolCall = (call: { toolUseId: string | null; name: string }): Promise<unknown> =>
    new Promise((resolve) => {
      const id = call.toolUseId ?? `unknown-${randomUUID()}`
      this.pendingCalls.set(id, { id, name: call.name, resolve })
      this.expectedCalls.delete(id)
      for (const waiter of [...this.callWaiters]) waiter()
    })

  /** The catalog the CLI may declare, in MCP shape. */
  private readonly toolCatalog = (): ClaudeSdkMcpTool[] => this.catalog

  /**
   * Serve one harness request.
   * @param options - the harness generate options.
   * @param route - resolved model/effort/thinking plus the credential seam.
   */
  async *stream(options: GenerateOptions, route: ClaudeSdkRoute): AsyncGenerator<StreamChunk> {
    this.touch()
    const watchdog = idleWatchdog(options.signal, this.transport.idleTimeoutMs)
    try {
      // Images are resolved before projection: the CLI takes them inline.
      const messages = await resolveImages(
        options.messages ?? [],
        route.resolveAttachments?.(),
        options.signal,
        CLAUDE_IMAGE_LIMIT,
      ) as readonly TranslatableMessage[]
      if (hostSupportsImageOffload()) {
        const offloadImages = requiredImageOffloadCount(messages, CLAUDE_REQUEST_IMAGE_BUDGET)
        if (offloadImages > 0) {
          throw new LlmError(
            `claude request images exceed the ${CLAUDE_REQUEST_IMAGE_BUDGET}-byte base64 budget; `
            + `${offloadImages} more oldest image(s) must be offloaded`,
            IMAGE_OFFLOAD_REQUIRED,
            { offloadImages },
          )
        }
      }
      let plan = this.plan(options, messages, route)
      if (plan.mode === 'append' && plan.softChanged) {
        try {
          await this.applyRouteChange(plan.signature)
        } catch (error: unknown) {
          this.transport.warn(
            `claude agent sdk: live model/effort change failed (${String((error as Error)?.message ?? error)}); rebuilding the session`,
          )
          this.dirty = true
          plan = this.plan(options, messages, route)
        }
      }
      if (plan.mode === 'append' && plan.freshMessages.length === 0 && this.pendingCalls.size === 0) {
        // Nothing new to forward and nothing waiting: the harness is asking
        // again for the same state (a retry), so replay rather than sit on an
        // idle CLI until the watchdog fires.
        plan.mode = 'rebuild'
      }
      if (plan.mode === 'rebuild') {
        this.catalog = route.ephemeral === true ? [] : mcpCatalog(options.tools, this.toolNames)
        await this.start(plan, route)
      }
      this.fastRequested = plan.signature.fastMode.includes('true')
      yield* this.pump(messages, plan, watchdog)
    } catch (error: unknown) {
      this.dirty = true
      const code = (error as { code?: string; failure?: { code?: string } })?.failure?.code
        ?? (error as { code?: string })?.code
      if (code === 'AUTH') this.forceToken = true
      if (options.signal?.aborted === true) await this.abortTurn()
      throw mapFetchFailure('claude agent sdk', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
      this.touch()
    }
  }

  /** Decide whether this request appends to the live CLI session or rebuilds it. */
  private plan(options: GenerateOptions, messages: readonly TranslatableMessage[], route: ClaudeSdkRoute): ClaudeSdkPlan {
    const systemText = systemTextOf(options)
    const signature: ClaudeSdkSignature = {
      model: options.model,
      system: textDigest(systemText),
      tools: route.ephemeral === true ? '' : toolDigest(options.tools),
      effort: route.effort ?? '',
      thinking: route.thinking === undefined ? '' : JSON.stringify(route.thinking),
      cache: route.promptCacheTtl ?? '',
      maxTokens: route.maxTokens === undefined ? '' : String(route.maxTokens),
      // The effective overlay, so a Speed switch is detected and applied live.
      fastMode: JSON.stringify(this.transport.flagSettings({ fast: route.fast === true })),
    }
    const side = harnessSideMessages(messages)
    const sideHashes = side.map(messageDigest)
    // Process-level facts cannot change under a live CLI; model and effort can,
    // and are applied through control requests instead of a rebuild.
    const previous = this.signature
    const hardSame = previous !== undefined
      && previous.system === signature.system
      && previous.tools === signature.tools
      && previous.thinking === signature.thinking
      && previous.cache === signature.cache
      && previous.maxTokens === signature.maxTokens
    const appendable = this.ready
      && !this.dirty
      && route.ephemeral !== true
      && hardSame
      && isPrefix(this.sentHashes, sideHashes)
    const softChanged = appendable
      && previous !== undefined
      && (previous.model !== signature.model
        || previous.effort !== signature.effort
        || previous.fastMode !== signature.fastMode)
    const skip = appendable ? this.sentHashes.length : 0
    return {
      mode: appendable ? 'append' : 'rebuild',
      signature,
      systemText,
      sideHashes,
      freshMessages: side.slice(skip),
      softChanged,
    }
  }

  /**
   * Apply a model/effort change to the live CLI instead of rebuilding it.
   * @param next - the signature this request asks for.
   */
  private async applyRouteChange(next: ClaudeSdkSignature): Promise<void> {
    const previous = this.signature
    const query = this.query
    if (previous === undefined || query === undefined) throw new Error('no live session to retune')
    if (previous.model !== next.model) await query.setModel(next.model)
    if (previous.effort !== next.effort) {
      await query.applyFlagSettings({ effortLevel: next.effort.length > 0 ? next.effort : null })
    }
    if (previous.fastMode !== next.fastMode) {
      const overlay = JSON.parse(next.fastMode) as Record<string, unknown>
      await query.applyFlagSettings(Object.keys(overlay).length > 0 ? overlay : { fastMode: null })
    }
    this.signature = { ...previous, model: next.model, effort: next.effort, fastMode: next.fastMode }
    this.transport.log('claude agent sdk session retuned', {
      model: next.model,
      effort: next.effort,
      fast: next.fastMode,
    })
  }

  /** Spawn a fresh CLI session for this conversation. */
  private async start(plan: ClaudeSdkPlan, route: ClaudeSdkRoute): Promise<void> {
    await this.teardown()
    const sdk = await this.transport.sdk()
    const channel = await this.transport.bridge.channel(this.key, {
      tools: this.toolCatalog,
      call: this.onToolCall,
    })
    await mkdir(this.transport.dir, { recursive: true })
    // The CLI is spawned with these as its cwd and config root; both must exist.
    await mkdir(this.transport.configDir, { recursive: true })
    await mkdir(this.transport.workDir, { recursive: true })
    const toolsFile = join(this.transport.dir, `tools-${createHash('sha1').update(this.key).digest('hex').slice(0, 16)}.json`)
    await writeFile(toolsFile, JSON.stringify(this.catalog), 'utf8')
    const input = new UserInputQueue()
    const accessToken = await route.accessToken(this.forceToken)
    this.forceToken = false
    const query = sdk.query({ prompt: input, options: this.queryOptions(plan, route, channel, toolsFile, accessToken) })
    this.input = input
    this.query = query
    this.iterator = query
    this.signature = plan.signature
    this.sentHashes = [...plan.sideHashes]
    this.ready = true
    this.dirty = false
    this.degraded = false
    this.degradedWarned = false
    this.lastRateLimit = undefined
    // The SDK spawns its CLI lazily on the first read, so the bridge handshake
    // is observed where it matters (tool-result delivery) rather than blocking
    // here, which would deadlock against that first read.
  }

  /** Build the SDK options for one CLI process. */
  private queryOptions(
    plan: ClaudeSdkPlan,
    route: ClaudeSdkRoute,
    channel: { pipePath: string; token: string },
    toolsFile: string,
    accessToken: string,
  ): Record<string, unknown> {
    const env = claudeSdkEnv({
      configDir: this.transport.configDir,
      accessToken,
      ...route.promptCacheTtl === undefined ? {} : { promptCacheTtl: route.promptCacheTtl },
      ...route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens },
      proxyEnv: this.transport.proxyEnv(),
    })
    const options: Record<string, unknown> = {
      cwd: this.transport.workDir,
      env,
      model: route.model,
      // The harness owns the system prompt: a custom prompt replaces the Claude
      // Code preset entirely, so no coding-CLI instructions leak into a turn.
      systemPrompt: {
        type: 'custom',
        prompt: plan.systemText.length > 0
          ? plan.systemText
          : 'You are a helpful assistant working inside a host harness.',
      },
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      promptSuggestions: false,
      persistSession: false,
      stderr: (line: string) => {
        this.transport.log('claude agent sdk cli stderr', line.slice(0, STDERR_TAIL))
      },
    }
    if (route.effort !== undefined) options.effort = route.effort
    if (route.thinking !== undefined) {
      options.thinking = route.thinking
      // The direct transport asks for summarized thinking so the reasoning is
      // visible; the CLI spells the same knob as a spawn flag.
      options.extraArgs = { 'thinking-display': 'summarized' }
    }
    const flagSettings = this.transport.flagSettings({ fast: route.fast === true })
    if (Object.keys(flagSettings).length > 0) options.settings = flagSettings
    if (route.ephemeral !== true) {
      options.mcpServers = {
        [CLAUDE_SDK_MCP_SERVER]: {
          type: 'stdio',
          command: process.execPath,
          args: [mcpServerScript(), '--pipe', channel.pipePath, '--token', channel.token, '--tools', toolsFile],
          // Keep the harness tool set in the prompt instead of behind the CLI's
          // tool search, so the model sees the same declarations DSH sends.
          alwaysLoad: true,
        },
      }
      options.allowedTools = this.toolNames.allowed()
    }
    return options
  }

  /** Deliver tool results, push new user turns, and read one round trip. */
  private async *pump(
    messages: readonly TranslatableMessage[],
    plan: ClaudeSdkPlan,
    watchdog: ReturnType<typeof idleWatchdog>,
  ): AsyncGenerator<StreamChunk> {
    if (plan.mode === 'rebuild') {
      this.input?.push({
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: transcriptBlocks(messages) },
      })
    } else {
      const results = new Map<string, { content: unknown; isError: boolean }>()
      const forwarded: TranslatableMessage[] = []
      for (const message of plan.freshMessages) {
        if (message.role !== 'tool') {
          forwarded.push(message)
          continue
        }
        const source = message.source as { kind?: string; callId?: unknown } | undefined
        const id = (message as { toolCallId?: unknown }).toolCallId ?? (source?.kind === 'tool' ? source.callId : undefined)
        if (id === undefined) continue
        results.set(String(id), {
          content: toolResultContent(message),
          isError: (message as { isError?: boolean }).isError === true,
        })
      }
      if (results.size > 0) await this.deliverResults(results, watchdog)
      for (const message of forwarded) {
        this.input?.push({
          type: 'user',
          parent_tool_use_id: null,
          message: { role: 'user', content: userContentBlocks(message) },
        })
      }
    }
    yield* this.readRoundTrip(watchdog)
  }

  /** Answer the paused turn's tool calls with the harness's real results. */
  private async deliverResults(
    results: Map<string, { content: unknown; isError: boolean }>,
    watchdog: ReturnType<typeof idleWatchdog>,
  ): Promise<void> {
    if (!this.transport.bridge.isConnected(this.key)) {
      await this.transport.bridge.waitForHello(this.key, this.transport.helloGraceMs)
    }
    this.degraded = !this.transport.bridge.isConnected(this.key)
    if (this.degraded) {
      if (!this.degradedWarned) {
        this.degradedWarned = true
        this.transport.warn('claude agent sdk: the tool bridge is not connected; tool results are delivered as text')
      }
      const lines = [...results.entries()].map(([id, result]) => {
        const text = (result.content as { type?: string; text?: string }[])
          .map(part => (part.type === 'text' ? part.text ?? '' : part.type === 'image' ? '[image]' : ''))
          .join('\n')
        return `<tool_result call_id="${id}"${result.isError ? ' error="true"' : ''}>\n${text}\n</tool_result>`
      })
      this.input?.push({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'text', text: `<harness-tool-results>\n${lines.join('\n')}\n</harness-tool-results>` }],
        },
      })
      this.pendingCalls.clear()
      this.expectedCalls.clear()
      return
    }
    await this.waitForCalls(results, watchdog.signal)
    for (const call of [...this.pendingCalls.values()]) {
      const result = results.get(call.id)
      call.resolve(result ?? {
        content: [{ type: 'text', text: 'the harness returned no result for this call' }],
        isError: true,
      })
      this.pendingCalls.delete(call.id)
    }
    this.expectedCalls.clear()
  }

  /** Wait until the CLI has reported the calls it wants executed. */
  private waitForCalls(results: Map<string, unknown>, signal: AbortSignal | undefined): Promise<void> {
    const missing = (): string[] => [...results.keys()].filter(id => !this.pendingCalls.has(id))
    if (missing().length === 0 || this.expectedCalls.size === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.callWaiters.delete(check)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const check = (): void => {
        if (missing().length === 0) done()
      }
      const timer = setTimeout(done, this.transport.toolWaitMs)
      timer.unref()
      this.callWaiters.add(check)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  /** Read exactly one model round trip out of the session's event stream. */
  private async *readRoundTrip(watchdog: ReturnType<typeof idleWatchdog>): AsyncGenerator<StreamChunk> {
    const iterator = this.iterator
    if (iterator === undefined) throw new LlmError('claude agent sdk session is not running', 'STREAM_CLOSED')
    this.partialSeen = false
    const translator = new AnthropicStreamTranslator()
    let usage: TokenUsage | undefined
    let outcome: { kind: 'tool-calls' } | { kind: 'result'; message: SdkResultMessage } | undefined
    const toolCalls: { id: string; name: string }[] = []
    for (;;) {
      const step = await raceAbort(iterator.next(), watchdog.signal)
      if (step.done === true) {
        throw new LlmError('claude agent sdk ended the stream before the turn finished', 'STREAM_CLOSED')
      }
      const message = step.value
      watchdog.pulse()
      if (message.type === 'stream_event') {
        if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) continue
        this.partialSeen = true
        const event = message.event
        for (const chunk of translator.push(event)) {
          if (chunk.type === 'usage') {
            usage = addUsage(usage, chunk.usage)
            continue
          }
          if (chunk.type === 'finish') continue
          if (chunk.type === 'tool-call-delta') {
            yield chunk.name === undefined ? chunk : { ...chunk, name: this.toolNames.restore(chunk.name) }
            continue
          }
          if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
            const block: ContentBlock = { ...chunk.block, name: this.toolNames.restore(chunk.block.name) }
            toolCalls.push({ id: String(block.id), name: this.toolNames.restore(chunk.block.name) })
            yield { ...chunk, block }
            continue
          }
          yield chunk
        }
        if (event.type === 'message_stop' && translator.finishReason === 'tool-calls') {
          outcome = { kind: 'tool-calls' }
          break
        }
        continue
      }
      if (message.type === 'assistant') {
        if (this.partialSeen) continue
        for (const chunk of this.translateAssistant(message, translator, toolCalls)) {
          if (chunk.type === 'usage') {
            usage = addUsage(usage, chunk.usage)
            continue
          }
          if (chunk.type === 'finish') continue
          yield chunk
        }
        continue
      }
      if (message.type === 'result') {
        outcome = { kind: 'result', message }
        try {
          this.transport.onResult(this.key, message)
        } catch {
          // Diagnostics must never break a turn.
        }
        break
      }
      if (message.type === 'system') {
        this.onSystemMessage(message)
        continue
      }
      if (message.type === 'rate_limit_event') {
        const info = message.rate_limit_info
        if (info !== undefined) this.lastRateLimit = info
        continue
      }
      // `user` echoes, task and status frames carry no harness content.
    }
    if (outcome === undefined) throw new LlmError('claude agent sdk produced no outcome', EMPTY_RESPONSE_CODE)
    if (outcome.kind === 'tool-calls') {
      this.expectedCalls = new Map(toolCalls.map(call => [call.id, call]))
      yield { type: 'usage', usage: usage ?? { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const result = outcome.message
    this.reportFastRefusal(result.fast_mode_state, result.fast_mode_disabled_reason)
    if (result.is_error === true && translator.emittedBlock !== true) {
      const text = [result.subtype ?? 'request failed', ...Array.isArray(result.errors) ? result.errors : []].join(': ')
      const retryAfter = this.lastRateLimit?.status === 'rejected' && typeof this.lastRateLimit.resetsAt === 'number'
        ? Math.max(1, this.lastRateLimit.resetsAt - Date.now())
        : undefined
      throw new LlmError(`claude agent sdk: ${text}`, resultFailureCode(result), {
        ...typeof result.api_error_status === 'number' ? { status: result.api_error_status } : {},
        ...retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter },
      })
    }
    yield { type: 'usage', usage: usage ?? resultUsage(result) ?? { inputTokens: 0, outputTokens: 0 } }
    if (translator.emittedBlock !== true && toolCalls.length === 0) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
        },
      }
      return
    }
    const stopReason = typeof result.stop_reason === 'string' ? result.stop_reason : ''
    const maxed = stopReason === 'max_tokens' || translator.finishReason === 'max-tokens'
    yield { type: 'finish', reason: maxed ? { kind: 'max-tokens' } : { kind: 'stop' } }
  }

  /**
   * Translate a complete assistant message when partial stream events are
   * unavailable: synthesize the equivalent Messages-API events so both paths go
   * through the shared translator and produce the same chunks.
   * @param message - the SDK assistant frame.
   * @param translator - the turn's translator.
   * @param toolCalls - collector for the tool calls this message asked for.
   * @returns chunks for the harness.
   */
  private translateAssistant(
    message: SdkAssistantMessage,
    translator: AnthropicStreamTranslator,
    toolCalls: { id: string; name: string }[],
  ): StreamChunk[] {
    const raw: StreamChunk[] = []
    const content = Array.isArray(message.message?.content) ? message.message.content : []
    raw.push(...translator.push({
      type: 'message_start',
      message: { usage: message.message?.usage ?? {} },
    } as AnthropicStreamEvent))
    for (const [index, entry] of content.entries()) {
      const block = entry as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }
      if (block.type === 'text') {
        raw.push(...translator.push({ type: 'content_block_start', index, content_block: { type: 'text' } } as AnthropicStreamEvent))
        raw.push(...translator.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text ?? '' },
        } as AnthropicStreamEvent))
        raw.push(...translator.push({ type: 'content_block_stop', index } as AnthropicStreamEvent))
        continue
      }
      if (block.type === 'thinking') {
        raw.push(...translator.push({
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking' },
        } as AnthropicStreamEvent))
        raw.push(...translator.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: block.thinking ?? '' },
        } as AnthropicStreamEvent))
        raw.push(...translator.push({ type: 'content_block_stop', index } as AnthropicStreamEvent))
        continue
      }
      if (block.type === 'tool_use') {
        raw.push(...translator.push({
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name },
        } as AnthropicStreamEvent))
        raw.push(...translator.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
        } as AnthropicStreamEvent))
        raw.push(...translator.push({ type: 'content_block_stop', index } as AnthropicStreamEvent))
      }
    }
    const stopReason = message.message?.stop_reason
    raw.push(...translator.push({
      type: 'message_delta',
      delta: {
        stop_reason: stopReason === 'tool_use' ? 'tool_use' : stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn',
      },
      usage: message.message?.usage,
    } as AnthropicStreamEvent))
    raw.push(...translator.push({ type: 'message_stop' } as AnthropicStreamEvent))
    const out: StreamChunk[] = []
    for (const chunk of raw) {
      if (chunk.type === 'tool-call-delta') {
        out.push(chunk.name === undefined ? chunk : { ...chunk, name: this.toolNames.restore(chunk.name) })
        continue
      }
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        const name = this.toolNames.restore(chunk.block.name)
        const block: ContentBlock = { ...chunk.block, name }
        toolCalls.push({ id: String(block.id), name })
        out.push({ ...chunk, block })
        continue
      }
      out.push(chunk)
    }
    return out
  }

  /** Capture the CLI's startup facts. */
  private onSystemMessage(message: SdkSystemMessage): void {
    if (message.subtype !== 'init') return
    this.transport.log('claude agent sdk session started', {
      sessionId: message.session_id,
      model: message.model,
      tools: Array.isArray(message.tools) ? message.tools.length : undefined,
    })
  }

  /**
   * Tell the operator when a requested fast turn actually ran standard.
   *
   * Fast mode is plan-gated: Claude Code keeps it off unless the account has
   * usage credits, so a subscription-only account sees `preference` and every
   * turn stays standard. One notice per CLI process, not per turn.
   * @param state - the fast-mode state the result frame reported.
   * @param reason - the CLI's reason code, when it refused.
   */
  private reportFastRefusal(state: 'off' | 'cooldown' | 'on' | undefined, reason: string | undefined): void {
    if (!this.fastRequested || state === 'on') return
    const code = reason ?? (state === 'cooldown' ? 'cooldown' : 'unknown')
    if (this.fastRefusalReported === code) return
    this.fastRefusalReported = code
    this.transport.warn(`claude agent sdk: fast mode is not active (${code}); ${CLAUDE_SDK_FAST_REFUSAL_HINTS[code] ?? 'the CLI did not report why'}`)
  }

  /** Stop the CLI turn a caller abort interrupted, then drop the process. */
  private async abortTurn(): Promise<void> {
    for (const call of this.pendingCalls.values()) {
      call.resolve({ content: [{ type: 'text', text: 'the caller aborted this turn' }], isError: true })
    }
    this.pendingCalls.clear()
    this.expectedCalls.clear()
    const query = this.query
    if (query !== undefined) {
      const interrupt = Promise.resolve().then(() => query.interrupt()).catch(() => undefined)
      await Promise.race([interrupt, new Promise(resolve => setTimeout(resolve, 2_000))])
    }
    await this.teardown()
  }

  /** Drop the CLI process and its bridge channel. */
  async teardown(): Promise<void> {
    for (const call of this.pendingCalls.values()) {
      call.resolve({ content: [{ type: 'text', text: 'the claude session was reset' }], isError: true })
    }
    this.pendingCalls.clear()
    this.expectedCalls.clear()
    const query = this.query
    this.query = undefined
    this.iterator = undefined
    this.input?.close()
    this.input = undefined
    this.ready = false
    this.transport.bridge.release(this.key)
    if (query !== undefined) {
      try {
        query.close()
      } catch {
        // Already closed.
      }
    }
  }

  /** How long this session has been idle. */
  idleFor(now: number): number {
    return now - this.lastUsed
  }

  /** Whether a tool call is still outstanding. */
  hasOutstandingCalls(): boolean {
    return this.pendingCalls.size > 0 || this.expectedCalls.size > 0
  }
}

// ---------------------------------------------------------------------------
// Transport: owns the bridge and every live session
// ---------------------------------------------------------------------------

/**
 * Claude subscription transport. One instance per adapter; it keeps at most one
 * CLI process per live harness session and drops idle ones.
 */
export class ClaudeSdkTransport implements ClaudeSdkRouteStream {
  private readonly options: ClaudeSdkTransportOptions
  readonly bridge: ClaudeSdkBridge
  private readonly sessions = new Map<string, ClaudeSdkSession>()
  private readonly sweepTimer: NodeJS.Timeout
  private sdkCache: ClaudeSdkModule | undefined
  private fastCapability: Promise<{ exact: Set<string>; aliases: Set<string> }> | undefined
  private fastCapabilityRetryAt = 0

  constructor(options: ClaudeSdkTransportOptions) {
    this.options = options
    this.bridge = new ClaudeSdkBridge({ dir: options.dir, ...options.onWarn === undefined ? {} : { onWarn: options.onWarn } })
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(60_000, Math.max(15_000, options.idleCloseMs / 2)))
    this.sweepTimer.unref()
  }

  /** Directory holding tool catalogs and the bridge socket. */
  get dir(): string {
    return this.options.dir
  }

  /** Isolated `CLAUDE_CONFIG_DIR`. */
  get configDir(): string {
    return this.options.configDir
  }

  /** Working directory handed to the CLI. */
  get workDir(): string {
    return this.options.workDir
  }

  /** Idle timeout of one stream read. */
  get idleTimeoutMs(): number {
    return this.options.idleTimeoutMs
  }

  /** How long a tool result waits for the CLI to report its call. */
  get toolWaitMs(): number {
    return this.options.toolWaitMs ?? DEFAULT_TOOL_WAIT_MS
  }

  /** How long a late bridge handshake is awaited before degrading. */
  get helloGraceMs(): number {
    return Math.min(this.options.helloMs ?? DEFAULT_HELLO_MS, 2_000)
  }

  /** Fast-mode policy. */
  get fastMode(): string {
    return this.options.fastMode ?? 'auto'
  }

  /**
   * Fast-mode overlay for the CLI's flag settings layer.
   *
   * The plugin policy wins when it is explicit (`on`/`off`); under `auto` the
   * session's own Speed choice decides, and a session with no choice leaves
   * Claude Code's default alone.
   * @param route - the request's fast choice, when it made one.
   * @returns the overlay, empty when the provider is left alone.
   */
  flagSettings(route?: { fast?: boolean }): Record<string, unknown> {
    if (this.fastMode === 'on') return { fastMode: true }
    if (this.fastMode === 'off') return { fastMode: false }
    if (route?.fast === undefined) return {}
    return { fastMode: route.fast }
  }

  /**
   * Fast capability as the official CLI reports it, resolved once per process.
   *
   * This is model metadata (`supportsFastMode`), not a promise that this
   * account may run fast: a plan without usage credits still gets a standard
   * turn, and the reason is logged through {@link reportFastRefusal}.
   * @param model - the model id the harness routes to.
   * @returns whether the CLI marks that model fast-capable.
   */
  async supportsFast(model: string): Promise<boolean> {
    return fastCapabilityMatches(await this.fastCapabilityTable(), model)
  }

  /**
   * Drop the cached capability table so the next read asks the CLI again.
   *
   * The Settings model list's refresh is the only caller: it may have just
   * installed the SDK or changed plan, and the five-minute failure cooldown
   * would otherwise keep answering "no fast models" from stale facts.
   */
  invalidateFast(): void {
    this.fastCapability = undefined
    this.fastCapabilityRetryAt = 0
  }

  /**
   * The cached capability table. A failed probe answers "no fast models" and is
   * retried after a cooldown, so a transient failure (an expired token, a busy
   * spawn) does not hide the toggle for the rest of the process.
   */
  private fastCapabilityTable(): Promise<{ exact: Set<string>; aliases: Set<string> }> {
    if (this.fastCapability !== undefined) return this.fastCapability
    if (Date.now() < this.fastCapabilityRetryAt) return Promise.resolve(EMPTY_FAST_TABLE)
    this.fastCapability = this.probeFastCapability().catch((error: unknown) => {
      this.fastCapability = undefined
      this.fastCapabilityRetryAt = Date.now() + 5 * 60_000
      this.warn(`claude agent sdk: fast-mode capability probe failed (${String((error as Error)?.message ?? error)})`)
      return EMPTY_FAST_TABLE
    })
    return this.fastCapability
  }

  /**
   * Ask a throwaway CLI process for its model table. Cheap enough to run once:
   * no tools, no MCP bridge, no transcript, and the process is closed at once.
   */
  private async probeFastCapability(): Promise<{ exact: Set<string>; aliases: Set<string> }> {
    const empty = EMPTY_FAST_TABLE
    const token = this.options.accessToken === undefined ? undefined : await this.options.accessToken(false)
    if (token === undefined) return empty
    const sdk = await this.sdk()
    if (typeof sdk.query !== 'function') return empty
    // The CLI is spawned with these as its cwd and config root; both must exist
    // or the spawn fails with a misleading "binary failed to launch (ENOENT)".
    await mkdir(this.dir, { recursive: true })
    await mkdir(this.configDir, { recursive: true })
    await mkdir(this.workDir, { recursive: true })
    const input = new UserInputQueue()
    const query = sdk.query({ prompt: input, options: this.capabilityOptions(token) })
    try {
      // `supportedModels()` starts the CLI and answers on its own (~1.6s cold
      // here). Reading the prompt first does NOT help: `next()` only resolves
      // once a real message arrives, so waiting for it burned the whole 20s
      // timeout and made the first Speed read take that long.
      const rows = await withFastProbeTimeout(query.supportedModels?.() ?? Promise.resolve([]))
      const exact = new Set<string>()
      const aliases = new Set<string>()
      for (const row of rows) {
        if (row.supportsFastMode !== true) continue
        if (typeof row.value === 'string' && row.value.length > 0) {
          exact.add(row.value)
          // A bare family alias ('opus') covers every id of that family.
          if (!row.value.includes('-')) aliases.add(row.value)
        }
        if (typeof row.resolvedModel === 'string' && row.resolvedModel.length > 0) exact.add(row.resolvedModel)
      }
      this.log('claude agent sdk fast capability', { exact: [...exact], aliases: [...aliases] })
      return { exact, aliases }
    } finally {
      input.close()
      try {
        query.close()
      } catch {
        // Already closed.
      }
    }
  }

  /** Options for the throwaway capability process: no tools, no bridge, no transcript. */
  private capabilityOptions(accessToken: string): Record<string, unknown> {
    return {
      cwd: this.workDir,
      env: claudeSdkEnv({ configDir: this.configDir, accessToken, proxyEnv: this.proxyEnv() }),
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      promptSuggestions: false,
    }
  }

  /**
   * Proxy environment for the CLI, read from this plugin's own proxy config so
   * a user-configured proxy keeps working on the SDK transport too.
   * @returns proxy variables, empty when no proxy is configured.
   */
  proxyEnv(): Record<string, string> {
    const path = this.options.proxyPath
    if (path === undefined || path.length === 0 || !existsSync(path)) return {}
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { enabled?: boolean; url?: string; bypass?: string[] }
      if (raw.enabled !== true || typeof raw.url !== 'string' || raw.url.length === 0) return {}
      const env: Record<string, string> = {
        HTTPS_PROXY: raw.url,
        HTTP_PROXY: raw.url,
        https_proxy: raw.url,
        http_proxy: raw.url,
      }
      if (Array.isArray(raw.bypass) && raw.bypass.length > 0) {
        env.NO_PROXY = raw.bypass.join(',')
        env.no_proxy = env.NO_PROXY
      }
      return env
    } catch {
      return {}
    }
  }

  /** Forward a diagnostic message. */
  warn(message: string): void {
    this.options.onWarn?.(message)
  }

  /** Forward a structured log line. */
  log(message: string, detail?: unknown): void {
    this.options.onLog?.(message, detail)
  }

  /** Forward a raw result frame. */
  onResult(key: string, message: unknown): void {
    this.options.onResult?.(key, message)
  }

  /** Resolve and import the SDK once; throws when it is not installed. */
  async sdk(): Promise<ClaudeSdkModule> {
    if (this.sdkCache !== undefined) return this.sdkCache
    const entry = resolveClaudeSdkEntry(this.options.sdkEntry)
    if (entry === undefined) {
      throw new LlmError(
        'the Claude Agent SDK is not installed for this profile; install @anthropic-ai/claude-agent-sdk '
        + '(or set claudeSdkEntry / DSH_CLAUDE_AGENT_SDK) to use the compliant claude subscription transport',
        'UNSUPPORTED',
      )
    }
    this.sdkCache = await loadClaudeSdk(entry)
    return this.sdkCache
  }

  /** Whether an SDK installation can be found right now. */
  available(): boolean {
    return resolveClaudeSdkEntry(this.options.sdkEntry) !== undefined
  }

  /** Serve one harness request through a CLI process. */
  async *stream(options: GenerateOptions, route: ClaudeSdkRoute): AsyncGenerator<StreamChunk> {
    const key = this.keyFor(options, route)
    if (key === undefined || options.purpose !== undefined) {
      const session = new ClaudeSdkSession(this, `ephemeral-${randomUUID()}`)
      try {
        yield* session.stream(options, { ...route, ephemeral: true })
      } finally {
        await session.teardown()
      }
      return
    }
    let session = this.sessions.get(key)
    if (session === undefined) {
      session = new ClaudeSdkSession(this, key)
      this.sessions.set(key, session)
    }
    session.touch()
    yield* session.stream(options, route)
  }

  /** Session key: one CLI process per (account, harness session). */
  private keyFor(options: GenerateOptions, route: ClaudeSdkRoute): string | undefined {
    if (options.sessionId === undefined) return undefined
    return `${route.account ?? 'default'}::${String(options.sessionId)}`
  }

  /** Drop sessions that have been idle past the configured window. */
  private sweep(): void {
    const now = Date.now()
    for (const [key, session] of [...this.sessions]) {
      if (session.hasOutstandingCalls()) continue
      if (session.idleFor(now) < this.options.idleCloseMs) continue
      this.sessions.delete(key)
      void session.teardown()
    }
  }

  /** Stop every CLI process and the bridge. */
  async close(): Promise<void> {
    clearInterval(this.sweepTimer)
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map(session => session.teardown()))
    this.bridge.close()
  }
}