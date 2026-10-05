# @nu11dev/dsh-frugal-orchestrator 0.4.0（省钱编排）

主 agent 负责目标、设计、拆分和最终验收；少量执行者使用配置中的执行模型，持续完成同一职责的工作并提供证据。支持每会话选择 **Subagent** 或宿主原生 **Agent Teams**，并限制成员与并发。

**状态：0.4.0 发布候选。** 离线测试不调用付费模型。安装：

```bash
dsh plugin --profile web add @nu11dev/dsh-frugal-orchestrator @nu11dev/dsh-compaction-policy
```

**本包的 `frugal` preset 硬依赖 `@nu11dev/dsh-compaction-policy`**（preset 里带一条 bridge 行，见
[依赖与生效边界](#依赖与生效边界)）；只装本包会让 preset 少一行、加载报错。装完**重启 DSH 进程**
（bundle 列表只在启动时读）。

## 开始使用

按原来的启动方式重启 DSH，再打开 Web GUI。本包也可以从侧栏「插件」页按包名安装。

1. 创建会话，选择「省钱编排」（preset id `frugal`）。
2. 打开侧栏 **插件 → @nu11dev/dsh-frugal-orchestrator → frugal-gate → 配置**。这里设置新会话默认模式、工具目录与模型路由。
3. 打开会话头部 **省钱编排** 控件，查看本会话模式、成员、计数、路由和压力；会话空闲且旧工作全部结算后可切模式。
4. 后续工作优先续聊原执行者。Lead 收到证据后决定是否继续或结束。

人类命令走宿主的同一控制器：

```text
/frugal status
/frugal mode subagent
/frugal mode team
```

改变“新会话默认模式”不会改已经固定模式的会话。模式记录写入本会话非模型日志；fork 只读取自己的日志后缀。

## 图片交付桥（v0.4）

子 agent 过去只能用文字汇报，图片无法回传。现在每个**执行者**（Subagent child 或 Team 队友）自己有 `deliver_images`：传绝对路径（png/jpg/jpeg/webp/gif），字节进入宿主的标准附件库（`$DSH_HOME/attachments/v1`，内容寻址），只把附件引用记录到 `<DSH_HOME>/frugal-orchestrator/image-deliveries/<parent>__<child>.json`（只存引用与时间，不存字节、不存 base64），返回 `{delivered[], failed[], count, child, note?}`；部分失败不抛错。

Lead 只拿到**读**的一半 `read_delivered_images({ target, include_read?, task_id? })`：`target` 是它自己的直接 child（Subagent 模式用宿主 `subagents.listChildren` 的持久目录核验，Team 模式用成员名）。默认只回未读过的记录，成功项以原生图片块送进对话；坏图/被回收只进 `missing[]` 与文本诊断，绝不失败整次请求。Lead 拿不到 `deliver_images`：能自己交付图片的 Lead 就能伪造子 agent 的证据。

## 等待下限（minWaitTimeoutMs）

配置页的「最低等待时长（毫秒）」= 这个会话里等待工具的**时间下限**，留空（或 0）表示插件不设下限：

- Subagent 的 `wait_subagent`：省略 `timeout_ms` 时默认 `max(30000, 本值)`；显式传更小的值被明确拒绝（报错说明该传多少），不会被偷偷放大。
- Team 的 `wait_agent`：插件在 Lead 的 own layer 装一个**只能拒绝**的 guard（宿主参数是冻结的，改不了）。省略 `timeout_ms` 按宿主默认 30000 比较：`30000 < 下限` 才拒绝；显式值 `< 下限` 拒绝。宿主自身的 10000..3600000 边界不变。
- 上限 3600000 ms；非法值（非整数/负数/超上限）只记 `CONFIG-INVALID` 且**不**变成下限。
- 这个下限只是这次等待的截止时间：没有活跃队友时 `noProgress` 立即返回，队友有变化也会提前醒来，不会强制睡满。

## 两种模式

| 行为 | Subagent | Agent Teams |
| --- | --- | --- |
| Lead 默认工具 | subagent、wait_subagent、ask_user_question、read_delivered_images | spawn_teammate、send_message、list_agents、wait_agent、interrupt_agent、team_task_create/get/list/update、ask_user_question、read_delivered_images |
| 新建 | subagent({description,prompt}) | 原生 spawn_teammate，按需创建 executor/reviewer |
| 继续原成员 | subagent({agent_id,prompt}) | 原生 send_message，保持同名成员与上下文 |
| 等待 | wait_subagent，完成结果自动送回 | 原生 wait_agent；先确认有活跃队友 |
| 文件、通信和任务 | 执行者提供可核查文件与命令证据 | 共用工作区；用原生任务板记录写入范围、依赖和 CAS revision |

普通 child 保留执行工具和完整指令/skill 基线，禁止继续创建下级。Team 队友保留执行工具、原生通信与任务操作，去除 Lead 专属创建/中断能力和普通 subagent-control 的同名接口。普通 child 不承诺可使用 Team 的 send_message；依靠原有完成结果回送机制。

Team 的 fresh 默认不继承 Lead 长历史，派发必须包含短背景包。原生 fork 仅继承已完成历史，不保证看到 Lead 当前尚未结束的 turn。不要为等待结果另建观察者，也不要用文件修改时间证明任务完成。

Team 原生消息返回 accepted 或 queued 都表示宿主已经接受该消息。queued 占用未结算工作额度；**不要重发**。inactive 只是可用状态，不代表任务完成；任务 ready 不会唤醒 owner。任务完成必须有验收证据。

## 默认配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| defaultCoordinationMode | subagent | 仅影响尚未固定模式的新会话 |
| maxMembers | 3 | 每个模式累计成员上限，不含 Lead |
| maxConcurrent | 2 | 新建和唤醒共享执行槽；补充活跃成员不新增槽 |
| checkpointSteps | 40 | 每工作周期提醒一次短检查点 |
| checkpointMinutes | 8 | 下一模型步骤检查，执行中的工具不会被打断 |
| teamOrchestratorTools | 原生 Team 十个工具 | 与 Subagent 的 orchestratorTools 分开保存 |
| subagentProvider / subagentModel / subagentReasoningEffort | 留空 | 执行者（子 agent）的路由覆盖；三项都留空 = 继承父 agent 当前路由，只填一项时另一半仍按继承补齐 |
| orchestratorProvider / orchestratorModel / orchestratorReasoningEffort | 留空 | 主 agent 的路由覆盖；留空 = 跟随会话里选的模型与思考级别 |

达到成员或并发上限时，在原生派发副作用之前返回结构化错误。总量限制不删除历史成员，仍可等待和继续原成员；已有成员超过新上限时保留它们，阻止新增或超限唤醒。unknown、pending 和未对账预留都保守占用容量，不按时间自动释放。

检查点属于**软预算**，提醒执行者提交已完成项、文件/命令证据、未完成项和下一步，并通知 Lead。它不保证恰好 40 步停止，也不会自动派新的接手者。活跃成员补充消息不重置提醒周期。

配置页共 20 个 volatile 字段。旧字段继续保留：presetId、orchestratorTools、orchestratorSystemPrompt、四种上下文注入开关、执行者与 Lead 的 provider/model/effort、diagnostics。**执行者的 provider/model/思考级别默认留空**（不写任何作者私有的路由）：三项都空时子 agent 请求不带 `agentOptions`，整套继承父 agent；只填一项时另一半仍按继承补齐；显式填写才覆盖。Lead 路由留空表示继承会话选择。

orchestratorTools 真正空白代表不限制工具目录；非空但清洗后无有效工具会退回默认三工具并报 CONFIG-FALLBACK。自定义列表即使暴露 workflow/subagent_fork，这两条绕过成员记账的派发路径仍在执行时返回 DELEGATION-PATH。Team 使用独立列表，不覆盖旧值。

自定义 persona 正文原样保留，固定工具和模式契约始终追加。旧正文仍写“只有两个工具/不能续聊”时显示提醒，请自行更新正文。

## 上下文预算与压缩（已拆出）

> **v0.4 起，请求输出 cap 与上下文压缩策略不再属于本包。** 请安装并用侧栏
> **插件 → @nu11dev/dsh-compaction-policy → compaction-policy → 配置** 管理，见
> [@nu11dev/dsh-compaction-policy](https://github.com/Star-233/dsh-plugins/tree/main/plugins/dsh-compaction-policy#readme)。

拆出的原因：v0.3 的本包是 profile 顶层行，而 preset 把压缩引擎挂在
`isolate: { compaction: true }` 的组里，Cordis 只按**调用方**的 isolate 表解析服务，
顶层行永远读不到 `ctx.compaction`——阈值一到就报 COMPACTION-UNAVAILABLE，工具结果剪裁
静默失效。v0.4 用 preset 组内的 bridge 行把引擎按 mount 重新发布，policy 行再按 agent 解析。

本包只保留：成员/并发上限、模式与身份、工具目录、子 agent 模型路由、诊断。
执行者与 Lead 的单次输出 cap 由模型条目本身的 `maxTokens`（`desiredOutputCap: 0`）
加剩余空间收窄决定，不再由本包写死。

## 模式恢复与诊断

切模式须满足 Lead 空闲、无待处理输入、所有派发/结果已结算、Team 无待投递消息和未完成任务。控制器串行检查并在原生维护隔离里提交；持久化失败恢复原模式。

旧会话没有模式记录时迁移为 Subagent；旧 one-shot 不会被宣传成可续聊。恢复成员必须有真实 catalog/roster 关系；完成判断使用原生日志的输入消费凭据。缺证据或丢失回执保持 unknown，并拒绝依赖“假完成”的切换或超限派发。

头部控件的 **刷新状态 / 对账** 可重新检查原生 roster、消息和终止证据。恢复后首个请求先安装正确身份和路由；若模式在 prompt 已捕获后才变更，返回 MODE-NOT-READY，重试后重新装配。

诊断显示：成员职责/状态与停止原因、新建/续聊/拒绝计数、真实请求 provider/model/effort、路由继承/覆盖来源、具体阻塞项和命令结果。缺记录显示“无记录”，不能视为成功。上下文压力与压缩/剪裁事件见 `@nu11dev/dsh-compaction-policy` 的诊断。

时间口径：模型累计按步骤区间计算；工具区间合并并行重叠；等待包含在工具时间内；墙钟另列，不能把这些相加当总耗时。未获得首事件时不能推断是网络慢或模型正在推理。

diagnostics 可开启 `$DSH_HOME/frugal-gate.log`，记录治理与工具限制排障信息。故障留证用宿主会话导出、`/frugal status` 和诊断日志，避免附上凭据。

## 依赖与生效边界

**v0.4 起本包的 `frugal` preset 硬依赖 [@nu11dev/dsh-compaction-policy](https://github.com/Star-233/dsh-plugins/tree/main/plugins/dsh-compaction-policy#readme)**：preset 的压缩组里带了一条 `@nu11dev/dsh-compaction-policy/bridge` 行（接管开关）。装本包却没装那个包，会让 `frugal` preset 少一行、加载报错，所以两个包一起装：

```bash
dsh plugin --profile web add @nu11dev/dsh-frugal-orchestrator @nu11dev/dsh-compaction-policy
```

不想用那套策略就把 bridge 行删掉，preset 会退回宿主内置压缩。这个关系在 manifest 里写作 `@nu11dev/dsh-compaction-policy` 的 **optional peer**（不被自动安装，因此 `link:` 的开发 profile 在包正式发布前也能装）；两个包都发布以后，可以改成真正的 `dependencies`，让一次安装同时带上它。

离线验证使用 DSH **0.2.0-rc.2** 的真实 Context/Scope、ToolRuntime、SystemPrompt、SessionStore、SessionQuery、Projection、TokenMeter、Compaction、实验 Team runtime/tools。Team 服务或工具注册缺失时显示 TEAM-UNAVAILABLE，拒绝启用，不能静默退回另一模式。

工具呈现要求 native。ptc/both 返回 CONFIG-UNSUPPORTED，不发送模型请求。继承层 restrict、最终目录过滤和执行 guard 同时维护；guard 返回的 disposer 在切 preset、配置重装和卸载时释放。

已加载模块的 volatile 配置写入应用于下一步。**源码升级需重新加载 DSH 进程**；disable/enable 不保证替换模块缓存。本包[客户端](client.js)是手写 ModuleLoader 注册文件，无独立 bundle 构建；修改源码不表示当前页面已经加载它。刷新页面验证服务到的字节，宿主运行时仍须人类重启后验收。

## 开发与自动验证

在本包目录执行：

```bash
npm test
```

测试跑的是**真实的 DSH 运行时**（不 stub 宿主包），需要 `DSH_TOOLS_DIR`（装着运行时包的
`@deepseek-ai` 目录）与 `DSH_PROFILE_DIR`（`node_modules` 里能解析到 `@deepseek-ai/schemastery` 的
profile 目录）。CI 用的可复现配方见仓库根 README 与 `.github/workflows/ci.yml`。`npm run
verify:profile` 不在 CI 里：它要 boot 真实 profile 并断言该 profile link 的正是本 checkout。

`npm test` 与 `npm run verify:profile` 只在**仓库 checkout** 里可用：发布到 npm 的 tarball 按 `files`
白名单只带运行时文件（`index.js`、`client.js`、`lib/`、`cordis.patch.yml`、README、LICENSE），既不含
上面这些 `*.test.mjs` / `test-runtime.mjs`，也不含 `verify-profile.mjs`。装包是为了用它，跑这些脚本
要 clone 仓库。

| 测试 | 覆盖 |
| --- | --- |
| [gate](gate.test.mjs) | 设置更新、preset 切换、权限、基线改写、scope 与 fail-closed |
| [catalog](catalog.test.mjs) | 真实工具/提示词装配、YAML/默认提示词一致、用户覆盖 |
| [client](client.test.mjs) | 表单、20 字段跨半默认值、头部 slot/只读/忙时/失败、React 渲染 |
| [delegation](delegation.test.mjs) | 创建、续聊、等待、快速结束竞态、取消和重装 |
| [baseline](baseline.test.mjs) | 原导出 24 次新建/0 次续聊，成员记账 |
| [budgets](budgets.test.mjs) | 预留/回执、限制、持久化回滚、模式隔离、软检查点恢复 |
| [recovery](recovery.test.mjs) | 原生输入消费记账、queued/open/no-op/canceled/fork 隔离 |
| [team](team.test.mjs) | 原生 Lead/worker 工具、身份、路由、消息/任务 CAS、冷恢复首请求 |

fixture 仅替换执行/模型/持久化后端，不将 fake LLM 通过等同于真实供应商或浏览器体验通过。用例依赖可发现的 DSH 安装和 profile；可显式提供 DSH_PROFILE_DIR。

## 回滚

先收取工作结果并使会话空闲，必要时先把会话切回 Subagent，再退出 DSH，装回上一个已发布版本
（`dsh plugin --profile web add @nu11dev/dsh-frugal-orchestrator@<旧版本>`），按原启动方式重启。
本包不改动 profile 的 provider/model/effort；策略与压缩侧的回滚见 `@nu11dev/dsh-compaction-policy` 的 README。

不要在存在未结算 Team 消息或任务时直接卸载适配器。若日志证据缺失，unknown 可能持续阻止切换；先导出证据核对真实成员，不通过删日志或超时假结算来解锁。

## 许可

[MIT](LICENSE) © 2026 Star-233。仓库：<https://github.com/Star-233/dsh-plugins>。
