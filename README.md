# dsh-plugin-subscriptions (fork) [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English | [中文](README.zh.md)

Use **ChatGPT (Codex)**, **Claude**, **Grok (X Premium)**, **GitHub Copilot** and **Google Antigravity**
subscriptions as LLM providers in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — no
API keys. Tokens live at `~/.dsh/plugins/subscriptions/auth.json` (mode 0600) and refresh automatically.

| Route | Subscription | Models |
| --- | --- | --- |
| `codex` | ChatGPT Plus/Pro | live catalog |
| `claude` | Claude Pro/Max | catalog discovery, static fallback |
| `grok` | X Premium (xAI) | live catalog |
| `copilot` | GitHub Copilot | live catalog (device-flow login) |
| `antigravity` | Google Antigravity | live catalog |

This is a personal fork of [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions)
based on **v0.9.10**. Upstream behaviour is unchanged; the difference is how the **Claude** route talks to
Anthropic. For the full feature tour (Settings page, account pools, usage cards, proxy, provider tools) see
the [upstream README](https://github.com/V1ki/dsh-plugin-subscriptions#readme).

## What this fork adds

### 1. Claude runs on the Claude Agent SDK (compliance)

Upstream's Claude route logs in with the Claude Code OAuth client and then **posts to the Messages API
itself**, presenting as the CLI (`user-agent: claude-cli/…`, `x-app: cli`, the Claude Code beta flags and a
mandatory `"You are Claude Code…"` system block). A subscription OAuth token may only be spent by the
official client, so that path does not comply with the subscription terms.

Here, every inference request is made by the official client:

- It runs `@anthropic-ai/claude-agent-sdk` (which bundles Claude Code) with the stored token in
  `CLAUDE_CODE_OAUTH_TOKEN`; the plugin never posts to the Messages API itself.
- The harness keeps tool ownership. The SDK learns the harness tool set through one **MCP server** that
  forwards every call back to the plugin over a named pipe; the adapter stops at the assistant's tool
  boundary (`finish: tool-calls`), DSH executes the tools under its own permission rules, and the next
  request hands the **real** results back so the CLI continues the same turn. One `stream()` call is
  exactly one model round trip.
- One CLI process per `(account, session)`, with an append-only history so the CLI's prompt cache keeps
  working. Compaction, forks, a system-prompt or tool change, an interrupt or an error rebuild it (the
  history is then replayed as one `<prior-conversation>` message).
- `purpose: compaction | session-title` calls use a throwaway process with no tools.

Isolation — none of your own Claude Code state is touched:

| Setting | Why |
| --- | --- |
| `settingSources: []` | no `CLAUDE.md`, hooks, skills, plugins or MCP config load |
| `tools: []`, `strictMcpConfig` | Claude Code's own tools are off; the harness bridge is the only server |
| `persistSession: false` | no transcript in `projects/` → never listed by `claude --resume` or the desktop Code panel |
| private `CLAUDE_CONFIG_DIR` (`~/.dsh/plugins/subscriptions/claude-sdk/`) | CLI config, policy cache and session keys stay out of `~/.claude` |
| `DISABLE_AUTOUPDATER=1` | the bundled CLI never replaces itself; org policy and remote settings keep flowing |

Measured with the isolation check: 0 added / 0 changed / 0 removed files in `~/.claude` across sessions, and
the session ids never appear there. The CLI stores no credentials, so the plugin's stored refresh token is
untouched. An org-managed account still receives its own policy limits.

If no SDK installation is found the route **refuses turns** (`UNSUPPORTED`) instead of falling back to the
non-compliant direct transport. Point `claudeSdkEntry` at a copy, or set `claudeTransport: 'api'` to opt
back in deliberately.

### 2. Speed control (fast mode) for Claude

The composer Speed control and the per-model subagent-speed defaults used to be Codex-only; they now cover
Claude too:

- Fast is offered only for models the CLI marks fast-capable (`claude-opus-*` today; Sonnet, Fable and
  Haiku are not). The transport reads that table once per process from the CLI itself.
- The choice reaches the CLI as the flag-settings overlay `settings.fastMode`, and Fast ↔ Standard is
  applied live through `applyFlagSettings` — no process restart, no prompt-cache loss.
- **Fast is plan-gated.** Claude Code bills fast turns as usage credits (pay-as-you-go), so a
  subscription-only account keeps running standard. The plugin reports the CLI's reason once per session
  instead of letting the toggle look effective:

  ```
  claude agent sdk: fast mode is not active (preference); the account policy keeps fast mode off —
  Claude fast mode bills as usage credits (pay-as-you-go) and is not part of a subscription plan
  ```

### 3. Provider controls keep their meaning

| Control | How the SDK transport carries it |
| --- | --- |
| reasoning effort | spawn `effort`, retuned live when the session changes it |
| thinking | `thinking: adaptive/enabled(budget)` plus `--thinking-display summarized` |
| prompt-cache TTL (5m / 1h, per-model override) | `CLAUDE_CODE_PROMPT_CACHE_TTL` and the subagent variant |
| output cap (`maxTokens`) | `CLAUDE_CODE_MAX_OUTPUT_TOKENS` |
| model switch | `--model`, then `setModel()` live |
| plugin proxy (`proxy.json`) | `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` for the CLI |
| images, tool-result images, account pools, retry policy, idle timeout, compaction, titles, interrupts | unchanged (same seams as upstream) |

Not carried: `temperature` and `stop` (the CLI exposes neither) and per-turn `total_cost_usd` (available
through the `onResult` hook). Model discovery and the usage badge still call Anthropic's metadata endpoints
directly — metadata only, no inference; set `models.claude` in the config to skip discovery.

### 4. Model list refresh in Settings

The model list in the account manager (per-model display names, visibility, default effort, context,
tools) can now re-read the provider's catalog on demand:

- **Refresh stays clickable while the draft is dirty.** It used to be disabled until every edit was saved,
  which put the one control that can reveal a newly available model out of reach exactly when someone was
  halfway through renaming models.
- **Unsaved edits survive the refresh.** The answer replaces the catalog; pending display names, visibility,
  effort and context values stay in the draft, and a model the provider just started advertising appears as
  a new row. An explicit visibility list still keeps new models unchecked; *Automatically show all models*
  keeps meaning "including models added later".
- **The result is reported**, e.g. `Fetched 13 model(s) · 2 new · unsaved edits kept`, so a refresh that
  changed nothing cannot be mistaken for a dead button. A discovery failure still falls back to the built-in
  catalog and marks the account row as unavailable.
- On Claude the refresh also drops the cached fast-capability answer and asks the CLI again, so a freshly
  installed SDK or a plan change reaches the Speed control immediately instead of after the five-minute
  failure cooldown.

### 5. Files added / changed

| Path | Change |
| --- | --- |
| `src/providers/claude-agent-sdk.ts` | new — SDK discovery, named-pipe MCP bridge, per-session state machine, stream translation, fast capability |
| `src/providers/claude-sdk-mcp.ts` | new — the MCP stdio server the CLI spawns (declares the harness tools, forwards calls, degrades safely) |
| `src/providers/claude.ts` | delegates `streamCore` to the transport; adds `supportsFastTier` / `fastCapableModels` |
| `src/index.ts` | config keys, transport construction + disposal, speed controller, model-list `fastTier` |
| `src/provider-settings.ts` | subagent speed defaults per provider |
| `src/translate/anthropic.ts` | two read-only accessors on the stream translator |
| `src/client/{SpeedSelect,ProviderModelEditor}.tsx`, `model-filter.ts`, `locales.ts` | Speed control is provider-agnostic; the model list's Refresh keeps the draft and reports what it fetched |
| `test/claude-agent-sdk.spec.ts` | new — env mapping, tool names, fast policy/matching/reasons, MCP child, config |
| `test/claude-model-refresh.spec.ts` | new — a forced refresh re-reads the catalog; a failed one does not poison it |

`pnpm test` runs 649 specs, including those 14. Behaviour that needs a real credential (tool boundary,
result hand-back, cache TTL, output cap, effort retune, interrupt recovery, fast refusal, `~/.claude`
isolation) is verified out of tree and reproducible from the sibling `work/` folder.

### 6. Config (new keys only)

```yaml
- id: llm-subscriptions
  config:
    claudeTransport: agent-sdk       # default; 'api' opts back into the direct (non-compliant) path
    claudeSdkEntry: /path/to/@anthropic-ai/claude-agent-sdk/sdk.mjs   # optional explicit entry
    claudeIdleCloseMs: 600000        # drop an idle CLI process after this long
    claudeFastMode: auto             # auto = follow the Speed control; on/off force it
```

SDK lookup order: `claudeSdkEntry` → `DSH_CLAUDE_AGENT_SDK` → this profile's `node_modules` → any other
profile under `~/.dsh/profiles`. To install it where it belongs:

```sh
cd ~/.dsh/profiles/<profile> && pnpm add @anthropic-ai/claude-agent-sdk@0.3.287
```

All other configuration keys are upstream's — see its README.

## Install / build this fork

Installing `dsh-plugin-subscriptions` from npm or GitHub fetches **upstream**, so build the fork and point a
profile at it:

```sh
git clone https://github.com/Mintapril/dsh-plugin-subscriptions.git
cd dsh-plugin-subscriptions && pnpm install && pnpm build && pnpm test
dsh plugin --profile web add ./dsh-plugin-subscriptions
```

Or replace an installed copy's build output with the fork's:

```sh
cp -r lib/. ~/.dsh/profiles/<profile>/node_modules/dsh-plugin-subscriptions/lib/
```

Either way, restart DSH afterwards.

## Keeping up with upstream

```sh
git fetch upstream && git merge upstream/main    # or: git rebase upstream/main
```

Conflicts are expected only in `src/index.ts` (config and speed wiring), `src/providers/claude.ts` (the
delegation seam) and `src/client/` (Speed control gating); the two new provider files are self-contained.
Re-run `pnpm test` after every merge — `test/claude-agent-sdk.spec.ts` fails loudly if a seam moved.

## Develop

```sh
pnpm install   # dsh 0.2.1-rc.2 baseline
pnpm build     # tsc (lib/) + tsdown (lib/client.js)
pnpm test      # node --test over compiled specs
```

## License

MIT, as upstream.