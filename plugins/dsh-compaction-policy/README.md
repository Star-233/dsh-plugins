# @nu11dev/dsh-compaction-policy 0.1.0（上下文预算与压缩策略）

决定**什么时候压缩上下文**（阈值）与**每次请求要多少输出空间**（输出 cap），并在需要时真的调用
preset 内的压缩引擎。v0.4 从 `@nu11dev/dsh-frugal-orchestrator` 拆出：那边只剩编排，这边只管预算与压缩。

**状态：0.1.0 发布候选。** 离线测试不调用付费模型。本包可以独立安装
（`dsh plugin --profile web add @nu11dev/dsh-compaction-policy`），也是
`@nu11dev/dsh-frugal-orchestrator` 的 `frugal` preset 所依赖的策略包。装完或升级后**重启 DSH 进程**
（bundle 列表只在启动时读）；配置本身是 volatile，改完下一步生效。

## 一、为什么会有这个包（白话）

DSH 原来的规矩是：**本次请求的输出 cap 要从上下文窗口里先扣掉，剩下的才给对话用**。

```
阈值      = min(window × 0.75, window − 请求输出 cap − headroom)
消息预算  = window − 请求输出 cap
```

你为了不让模型被截断，把输出 cap 填成 200000/256000，于是：

| 现象 | 数字 |
| --- | --- |
| 256k 窗口被扣掉 200000 输出 cap + 32768 headroom | 只剩 **23232** 给整段对话 |
| 子 agent 光系统提示 + 工具表 | 约 18000 |
| 读一个文件就越界 | 触发压缩 → 压缩引擎又取不到 → 报错退出 |

**越想不截断，可用空间反而越小**，这就是那个反直觉的地方。这个包把三件事拆开：

- **B｜阈值不再跟着输出 cap 走**：阈值只由「窗口 − max(15%×窗口, 16384)」决定（256k 窗口 → 预留
  38400 → **阈值 217600**），与本次请求要多少输出无关。
- **C｜输出 cap 是「愿望」**：只有真的装不下时才在发送前收窄到「窗口 − 输入 − 64」（下限 1024）；
  平时就按模型条目声明的能力走（决策 A：**不设人为上限**，执行者与主 agent 一致）。
- **D｜压缩真的能执行**：v0.3 的压缩是**死代码**——preset 把引擎挂在 `isolate: { compaction: true }`
  的组里，Cordis 只按**调用方**的 isolate 表解析服务，profile 顶层行与 `agent.ctx`（挂载点的兄弟）
  永远读不到，于是每次越界都抛 `COMPACTION-UNAVAILABLE`、工具结果剪裁静默失效。
  修法是 preset 组内的 **bridge 行**（见 §四）。

失败语义与 pi / oh-my-oh-pi 一致：**任何预算或压缩失败都不终止 turn**——记一条日志、降级继续；
真正的上下文溢出交给 provider 报错，再由 `agent/request-error` 强制压缩一次并返回 `{kind:'retry'}`。

## 二、安装与启用

1. **装包**：

   ```bash
   dsh plugin --profile web add @nu11dev/dsh-compaction-policy
   ```

   `dsh plugin add` 会同时把包写进 `dependencies` 与 `dsh.profile.bundles`（包里的
   `dsh.bundle.patch` 声明了 `./cordis.patch.yml`）。开发本仓库时也可以按路径装：
   `dsh plugin --profile web add "link:<repo>/plugins/dsh-compaction-policy"`。

2. **给要接管的 preset 加 bridge 行**（这是接管开关；它不在本包的 patch 里，因为 preset 子行不能按
   id 定位，只能整份重述）。以 `ptc` 为例：

   ```yaml
   - id: compaction
     name: cordis:group
     group: true
     isolate: { compaction: true, toolResultPruner: true }
     config:
       - id: compaction-basic
         name: '@deepseek-ai/dsh-compaction-basic'
         config:
           auto: false                      # 压缩时机交给本包，别让内置比例抢跑
       - id: compaction-policy-bridge        # ← 新增这一行
         name: '@nu11dev/dsh-compaction-policy/bridge'
       - id: command-compact
         name: '@deepseek-ai/dsh-command-compact'
       - id: tool-result-pruner
         name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
         config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
   ```

   **没加 bridge 的 preset 完全不受影响**（不 fit、不剪裁、不压缩），继续走宿主内置路径，只在日志里
   记一条 `ungoverned … reason=no-bridge`。

3. **改模型条目的 `maxTokens`**：未桥接的 preset 仍由内置引擎决定阈值，而它们的预留就是模型
   条目的 `maxTokens`。**`maxTokens` 达到或超过 `contextWindow` 会让消息预算变成 0，
   内置压缩直接抛 `TargetPressureConfigError`**。作为参考，一套 256k 窗口的部署会把条目统一收到
   **32768**：
   内置阈值 = 256000 − 32768 − 32768 = **190464**，消息预算 223232。

4. **重启 DSH**（bundle 列表只在启动时读），然后：

   ```bash
   cd plugins/dsh-compaction-policy && node verify-profile.mjs
   ```

## 三、参数（侧栏「插件」→ 组合包 @nu11dev/dsh-compaction-policy → 行 compaction-policy → 配置）

15 个字段全部是 `.volatile()`：改完立即对活 agent 生效，不需要重启。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `reserveRatio` | 0.15 | 预留比例；预留 = max(比例×窗口, 下限) |
| `reserveFloorTokens` | 16384 | 预留下限（pi/ompi 同值） |
| `thresholdPercent` | 空 | 百分比覆盖；`80` / `"80%"` 都读作 80%（**裸数字是百分比，不是 token**） |
| `thresholdTokens` | 0 | 绝对 token 覆盖；0 = 用预留公式 |
| `desiredOutputCap` | 0 | 每次请求要的输出；**0 = 跟随模型条目声明的能力**（决策 A） |
| `workerOutputCap` | 0 | 执行者单独上限；0 = 与上面一致（要省钱才填，即决策 B） |
| `fitHeadroomTokens` | 64 | fit 时贴住窗口的安全间隙（ompi 同值） |
| `minFittedOutputTokens` | 1024 | fit 下限：宁可按上限发，也不发会被 provider 拒的请求 |
| `estimateMarginDivisor` | 10 | 没有 provider usage 锚点时，本地估算 ×(1+1/10) |
| `keepRecentTokens` | 20000 | 压缩时原样保留的近期尾部 |
| `compactionRetries` | 2 | 一次压力事件里最多压几次 |
| `maxOverflowRetries` | 1 | 每个 agent 允许几次 overflow 恢复 |
| `agentThresholdOverrides` | 空 | 按 agent 覆盖阈值，写法 `id=90000, id2=80%` |
| `skipFitTargets` | 空 | 不做 fit 的模型：`provider/model, model`（对齐 ompi 的 compat 跳过） |
| `diagnostics` | true | 把每个决定写进 `$DSH_HOME/compaction-policy.log`（512 KiB 截断重来） |

阈值最终会被 `clamp(值, 1, window−1)`，窗口再小也不会等于窗口。

## 四、机制

**触发点**（都在顶层行，按 agent 判定，互不阻塞）：

| 钩子 | 做什么 |
| --- | --- |
| `system-prompt/assemble` | 记下本次装配的工具表与系统提示词（`tokenMeter` 看不到它们） |
| `agent/pre-step` | 在 `next()` **之前**判压：先剪裁工具结果，再用 `tokenMeter` 复核；仍超阈值就选安全范围调 `compactRegion` |
| `agent/request` | `next()` 之后把输出 cap 收窄到装得下的值 |
| `agent/request-error` | provider 报 `CONTEXT_WINDOW_EXCEEDED` → 强制压一次 → 返回 retry |
| `agent/status` | agent 空闲时释放该 agent 的 overflow 计数 |

**引擎怎么找到**：`agentPresets.serviceFor(agent, 'frugalCompaction')` —— 宿主自己的「按 mount
读服务」公开路径。bridge 行在 preset 的 isolate 组**内**用 `ctx.isolate('frugalCompaction')`
铸一个新标签再 `provide`，所以两个 preset 各自 bridge 互不干扰。**故意不 provide 到根**：根表是
进程级单槽，第二个 preset 要么撞名、要么静默拿到别人的引擎，消费端也无法区分「已接管」与「官方未改」。

**选择安全范围**：系统提示词永不切；尾部按 `keepRecentTokens` 保留；工具调用与结果成对平衡。

**失败处理**：每个钩子都是 catch-all。压缩失败、计量失败、无安全范围 → 记日志 + 本次不压，turn
继续跑，下一次 pre-step 再判。overflow 计数按 agent 记在 WeakMap 里，空闲即释放。

## 五、接管范围（`dsh --profile web --dump-config` 实测）

| preset | 引擎 | auto | bridge | 说明 |
| --- | --- | --- | --- | --- |
| ptc | 有 | false | 有 | 用户 profile 整份重述过，可改 |
| frugal | 有 | false | 有 | 由 `@nu11dev/dsh-frugal-orchestrator` 的 bundle patch 加好了 |
| standard | 有 | 默认 | 无 | 官方 preset，保持内置路径 |
| minimal | 无 | — | 无 | 本来就没有压缩行 |
| cordis | 有 | 默认 | 无 | 官方 preset |
| standard/minimal/code/cordis-gitbash | 有 | 默认 | 无 | **`dsh-gitbash-shell` 启动时用 `agentPresets.register()` 运行时注册**，`--dump-config` 看不到、也没法桥接；它们靠模型条目 `maxTokens=32768` 把内置阈值收到 190464 |

`node verify-profile.mjs` 会把这张表打出来，并断言「桥接的 preset 必须 `auto: false`」
「未桥接的 preset 不许被动过」「每个模型条目都留住至少 65536 的消息预算」。

## 六、诊断

`$DSH_HOME/compaction-policy.log`，每行一个决定：

```
boot      services=llm:yes tokenMeter:yes sessionQuery:yes agentPresets:yes engine-name=frugalCompaction …
pressure  id=3f8a1c2d route=example/deepseek-v4.1-flash window=256000 reserve=38400 threshold=217600 pressure=41230 source=usage pruned=false compacted=0
fit       id=3f8a1c2d target=example/deepseek-v4.1-flash window=256000 prompt=41230 desired=32768 cap=32768 kept
ungoverned id=9b2e77aa reason=no-bridge (this preset keeps its built-in compaction)
```

`source` 是计量锚点：`usage` = 真实 provider 用量（可信），`estimated` / `none` =
本地估算（已按 `estimateMarginDivisor` 上浮）。

## 七、开发与自动验证

```bash
cd plugins/dsh-compaction-policy
npm test                 # policy / composition / compaction / fit / overflow / client
npm run verify:profile   # 组合配置盘点（读 profile，只读）
```

测试跑的是**真实的 DSH 运行时**（不 stub 宿主包），所以需要两个路径：`DSH_TOOLS_DIR` 指向装着
运行时包的 `@deepseek-ai` 目录，`DSH_PROFILE_DIR` 指向一个 `node_modules` 里能解析到
`@deepseek-ai/schemastery` 的 profile 目录。CI 用的可复现配方（与
`.github/workflows/ci.yml` 相同）：

```bash
mkdir -p .ci-runtime && cd .ci-runtime
npm init -y && npm install --no-audit --no-fund @deepseek-ai/dsh@0.2.0-rc.2
export DSH_TOOLS_DIR="$PWD/node_modules/@deepseek-ai"   # npm 会把运行时 hoist 到这里
export DSH_PROFILE_DIR="$PWD"
cd ../plugins/dsh-compaction-policy && npm test
```

`npm test` 与 `npm run verify:profile` 只在**仓库 checkout** 里可用：发布到 npm 的 tarball 按 `files`
白名单只带运行时文件（`index.js`、`bridge.js`、`client.js`、`lib/`、`cordis.patch.yml`、README、
LICENSE），既不含 `*.test.mjs` / `test-runtime.mjs`，也不含 `verify-profile.mjs`。装包是为了用它，
跑这些脚本要 clone 仓库。

`npm run verify:profile` **不在 CI 里**：它要 boot 一个真实 profile 并断言该 profile link 的正是本
checkout，只在本机（仓库 + 已装 profile）才有意义。注意 profile 里的包名要与本包的 scoped 名一致
（`node_modules/@nu11dev/dsh-compaction-policy`），旧的未加 scope 的 `link:` 需要重装。

| 测试 | 覆盖 |
| --- | --- |
| [policy](policy.test.mjs) | 纯数学：预留、阈值、clamp、fit 下限、百分比 vs 绝对值、估算上浮 |
| [composition](composition.test.mjs) | **真实 cordis + loader 复现 isolate 盲区**：无 bridge 时组外取不到、有 bridge 时按 mount 取到、不泄漏给未桥接的兄弟组、两棵树互不干扰。**删掉 `bridge.js` 这条测试会直接报错退出（exit 1）**（已实测） |
| [compaction](compaction.test.mjs) | 真实 Session/TokenMeter/fake LLM：真实 `compaction/start` 与 `compaction/end`、checkpoint、失败后 turn 继续、无安全范围降级 |
| [fit](fit.test.mjs) | 小输入保持 desired、逼近窗口时收窄、room<1024 → 1024、跳过条件、历史 header 不改 |
| [overflow](overflow.test.mjs) | 溢出 → 压缩 → retry；重试上限；其他错误码不动；空闲释放；恢复失败保留原错误 |
| [client](client.test.mjs) | 配置页 15 字段、跨半默认值一致、React 渲染 |

## 八、English summary

`@nu11dev/dsh-compaction-policy` decouples the **compaction threshold** from the **per-request output cap**
and makes compaction actually executable.

*Threshold (B).* The threshold is `window − max(15% × window, 16384)` — 217600 on a 256k window —
with optional absolute (`thresholdTokens`) or percent (`thresholdPercent`) overrides and
per-agent overrides. The request's output cap is **not** part of it.

*Output cap (C).* The cap is a wish: `agent/request` narrows it to
`window − prompt − 64` (floor 1024) only when the request would not fit; otherwise the model keeps
its declared output capability (`desiredOutputCap: 0` = the model entry's `maxTokens`;
**decision A** adds no artificial Lead/worker limit — `workerOutputCap` stays opt-in).

*Reachability (D).* A preset mounts its compaction engine inside a `cordis:group` with
`isolate: { compaction: true, toolResultPruner: true }`, which interns each name as an
**entry-local symbol**. Cordis resolves services through the **caller's** isolate table, so a top-level
row — and `agent.ctx`, which is the mount's *sibling* — can never read `ctx.compaction`.
The companion `@nu11dev/dsh-compaction-policy/bridge` row lives **inside** that group, republishes the
engine under a fresh per-mount label (`ctx.isolate('frugalCompaction')`), and the policy row
resolves it per agent through the host's own
`agentPresets.serviceFor(agent, 'frugalCompaction')`. Publishing at the root instead would intern
a **process-global single slot**, so a second bridged preset would collide or silently serve the wrong
engine. The bridge row therefore *is* the takeover switch: a preset without it is left entirely alone.

*Failure semantics.* Nothing here terminates a turn. Budget and compaction failures are logged and
degraded; a provider `CONTEXT_WINDOW_EXCEEDED` is recovered by one forced `compactRegion`
followed by a retry, bounded by `maxOverflowRetries` per agent — the same semantics as pi /
oh-my-oh-pi.

## 九、依赖与生效边界

- 依赖宿主 DSH **0.2.0-rc.2** 的 `agentPresets.serviceFor`、`agent/pre-step`、
  `agent/request`、`agent/request-error`、`tokenMeter`、`sessionQuery`、
  `compaction` / `toolResultPruner`。日志里的 `boot services=…` 会逐个报告可达性；
  缺 `agentPresets` 就永远不会接管任何 preset。
- 宿主半改源码要**重启 DSH 进程**；volatile 配置写入对下一步生效。
- 客户端半（[client.js](client.js)）是手写 `__ModuleLoader__.load` 注册文件，没有独立 bundle
  构建：改源码后**刷新页面**才会拿到新字节，而宿主运行时必须重启后验收。
- 回滚：把 preset 里的 `compaction-policy-bridge` 行删掉即恢复该 preset 的内置路径，并重启 DSH；要整包
  回退就 `dsh plugin --profile web add @nu11dev/dsh-compaction-policy@<旧版本>`。未桥接的 preset 仍由模型
  条目的 `maxTokens` 决定内置阈值，按需调回原值。

## 十、许可

[MIT](LICENSE) © 2026 Star-233。仓库：<https://github.com/Star-233/dsh-plugins>。
