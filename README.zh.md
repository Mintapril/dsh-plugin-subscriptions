# dsh-plugin-subscriptions（fork） [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](README.md) | 中文

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里把 **ChatGPT (Codex)**、**Claude**、
**Grok (X Premium)**、**GitHub Copilot**、**Google Antigravity** 的订阅当作 LLM provider 使用——不需要
API key。token 存在 `~/.dsh/plugins/subscriptions/auth.json`（权限 0600）并自动刷新。

| 路由 | 订阅 | 模型 |
| --- | --- | --- |
| `codex` | ChatGPT Plus/Pro | 在线目录 |
| `claude` | Claude Pro/Max | 目录发现，失败时用静态目录 |
| `grok` | X Premium (xAI) | 在线目录 |
| `copilot` | GitHub Copilot | 在线目录（device flow 登录） |
| `antigravity` | Google Antigravity | 在线目录 |

这是 [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions) 的个人 fork，基于
**v0.9.10**。上游行为保持不变，差别只在 **Claude** 路由怎么和 Anthropic 通信。完整功能说明（设置页、
账号池、用量卡片、代理、provider 工具）请看[上游 README](https://github.com/V1ki/dsh-plugin-subscriptions)。

## 这个 fork 做了什么

### 1. Claude 改由 Claude Agent SDK 调用（合规）

上游的 Claude 路由用 Claude Code 的 OAuth client 登录后**自己直连 Messages API**，并冒充 CLI
（`user-agent: claude-cli/…`、`x-app: cli`、Claude Code 的 beta 头，以及一条强制的
`"You are Claude Code…"` system 块）。订阅型 OAuth token 只允许官方客户端使用，这条路径不符合订阅条款。

这里所有推理请求都由官方客户端发出：

- 用 `@anthropic-ai/claude-agent-sdk`（自带 Claude Code）运行，token 通过 `CLAUDE_CODE_OAUTH_TOKEN` 交给它；
  插件自己不再向 Messages API 发请求。
- 工具执行权仍在 harness。SDK 通过**一个 MCP server** 拿到 harness 的工具集，每次调用经命名管道回传给插件；
  adapter 停在 assistant 的工具边界（`finish: tool-calls`），由 DSH 按自己的权限规则执行，下一轮再把**真实结果**
  回灌给仍在等待的 CLI，让它继续同一轮。一次 `stream()` 恰好是一次模型往返。
- 每个 `(account, session)` 一个常驻 CLI 进程，历史只追加，CLI 的 prompt cache 继续有效。压缩、分叉、
  system prompt 或工具集变化、中断、异常都会重建（重建时把历史压成一条 `<prior-conversation>` 重放）。
- `purpose: compaction | session-title` 这类一次性调用走临时进程，且不带工具。

隔离——你自己的 Claude Code 状态完全不受影响：

| 设置 | 作用 |
| --- | --- |
| `settingSources: []` | 不读 `CLAUDE.md`、hooks、skills、plugins、MCP 配置 |
| `tools: []`、`strictMcpConfig` | Claude Code 自己的工具关闭，只挂 harness 的桥 |
| `persistSession: false` | 不写 `projects/` → `claude --resume` 和桌面端 Code 面板都不会出现这些会话 |
| 独立的 `CLAUDE_CONFIG_DIR`（`~/.dsh/plugins/subscriptions/claude-sdk/`） | CLI 配置、策略缓存、会话 key 都不落 `~/.claude` |
| `DISABLE_AUTOUPDATER=1` | 自带 CLI 不自行升级；org 的 policy 与 remote settings 照常生效 |

隔离实测：跨会话 `~/.claude` 新增/修改/删除均为 0，会话 id 在里面出现 0 次；CLI 不落盘凭据，所以插件存的
refresh token 不受影响。

找不到 SDK 安装时该路由**拒绝服务**（`UNSUPPORTED`），不会静默退回不合规的直连路径。可以指定
`claudeSdkEntry`，或显式设置 `claudeTransport: 'api'` 退回。

### 2. Claude 也有速度（fast）开关

输入框的 Speed 控件和按模型的子代理速度默认值原先只对 Codex 生效，现在也覆盖 Claude：

- 只有 CLI 标记为 fast-capable 的模型才出现（目前是 `claude-opus-*`；Sonnet / Fable / Haiku 不支持），
  这份能力表每个进程从 CLI 自己读一次。
- 选择以 flag-settings 覆盖 `settings.fastMode` 下发，Fast ↔ 标准通过 `applyFlagSettings` **热应用**，
  不重启进程、不丢 prompt cache。
- **fast 受套餐限制。** Claude Code 把 fast 按用量额度（按量 / usage credits）计费，纯订阅账号仍是标准速度。
  插件会在该会话里说明一次原因，而不是让开关看起来生效：

  ```
  claude agent sdk: fast mode is not active (preference); the account policy keeps fast mode off —
  Claude fast mode bills as usage credits (pay-as-you-go) and is not part of a subscription plan
  ```

### 3. provider 旋钮含义不变

| 旋钮 | SDK 传输如何落地 |
| --- | --- |
| 推理强度 | spawn 时 `effort`，会话内改档热切换 |
| 思考 | `thinking: adaptive/enabled(budget)` + `--thinking-display summarized` |
| 提示缓存 TTL（5m / 1h，可按模型覆盖） | `CLAUDE_CODE_PROMPT_CACHE_TTL` 及子代理同名变量 |
| 输出上限（`maxTokens`） | `CLAUDE_CODE_MAX_OUTPUT_TOKENS` |
| 模型切换 | `--model`，之后 `setModel()` 热切换 |
| 插件代理（`proxy.json`） | 转成 CLI 的 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` |
| 图片、工具结果图片、账号池、重试策略、空闲超时、压缩、标题、中断 | 与上游相同 |

没有对应的：`temperature` 与 `stop`（CLI 不暴露）；每轮 `total_cost_usd`（可通过 `onResult` 钩子拿到）。
模型目录与用量徽标仍直连 Anthropic 的**元数据**接口（不推理）；把 `models.claude` 写进配置即可跳过目录发现。

### 4. 新增 / 修改的文件

| 路径 | 内容 |
| --- | --- |
| `src/providers/claude-agent-sdk.ts` | 新增——SDK 解析、命名管道 MCP 桥、会话状态机、流翻译、fast 能力 |
| `src/providers/claude-sdk-mcp.ts` | 新增——被 CLI 启动的 MCP stdio 服务（声明工具、转发调用、安全降级） |
| `src/providers/claude.ts` | `streamCore` 委派给传输层；新增 `supportsFastTier` / `fastCapableModels` |
| `src/index.ts` | 配置项、传输构造与回收、speed 控制器、模型列表 `fastTier` |
| `src/provider-settings.ts` | 按 provider 存储子代理速度默认值 |
| `src/translate/anthropic.ts` | 流翻译器上两个只读访问器 |
| `src/client/{SpeedSelect,ProviderModelEditor}.tsx`、`locales.ts` | Speed 控件不再限定 Codex |
| `test/claude-agent-sdk.spec.ts` | 新增——env 映射、工具名、fast 策略/匹配/原因、MCP 子进程、配置 |

`pnpm test` 共 644 个用例，含上面 11 个。需要真实凭据的行为（工具边界、结果回灌、缓存 TTL、输出上限、
effort 热切换、中断恢复、fast 拒绝、`~/.claude` 隔离）在仓库外验证，脚本在同级 `work/` 目录。

### 5. 配置（只列新增项）

```yaml
- id: llm-subscriptions
  config:
    claudeTransport: agent-sdk       # 默认；'api' 显式退回不合规的直连路径
    claudeSdkEntry: /path/to/@anthropic-ai/claude-agent-sdk/sdk.mjs   # 可选，显式指定入口
    claudeIdleCloseMs: 600000        # 空闲 CLI 进程保留多久后回收
    claudeFastMode: auto             # auto 跟随 Speed 选择；on/off 强制
```

SDK 查找顺序：`claudeSdkEntry` → `DSH_CLAUDE_AGENT_SDK` → 本 profile 的 `node_modules` →
`~/.dsh/profiles` 下的其他 profile。装到该在的位置：

```sh
cd ~/.dsh/profiles/<profile> && pnpm add @anthropic-ai/claude-agent-sdk@0.3.287
```

其余配置项都是上游的，见上游 README。

## 安装 / 构建这个 fork

从 npm 或 GitHub 安装 `dsh-plugin-subscriptions` 装的是**上游**，所以自己构建后用本地路径装：

```sh
git clone https://github.com/Mintapril/dsh-plugin-subscriptions.git
cd dsh-plugin-subscriptions && pnpm install && pnpm build && pnpm test
dsh plugin --profile web add ./dsh-plugin-subscriptions
```

或者把已安装副本的构建产物替换成 fork 的：

```sh
cp -r lib/. ~/.dsh/profiles/<profile>/node_modules/dsh-plugin-subscriptions/lib/
```

无论哪种方式，之后都要重启 DSH。

## 跟随上游

```sh
git fetch upstream && git merge upstream/main    # 或 git rebase upstream/main
```

冲突预期只出现在 `src/index.ts`（配置与 speed 接线）、`src/providers/claude.ts`（委派接缝）和
`src/client/`（Speed 控件显示条件）；两个新增 provider 文件是自包含的。每次合并后跑 `pnpm test`——
接缝移位时 `test/claude-agent-sdk.spec.ts` 会直接报错。

## 开发

```sh
pnpm install   # dsh 0.2.1-rc.2 基线
pnpm build     # tsc（lib/）+ tsdown（lib/client.js）
pnpm test      # node --test 跑编译后的用例
```

## 许可

MIT，与上游一致。