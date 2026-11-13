# 验证与接口依据

目标版本：DSH 0.2.1-rc.5。验证时间：2026-11-06。

## 已验证

1. 页面通过 esbuild 构建成 DSH `window.__ModuleLoader__` 客户端插件。
2. Node 内置测试覆盖：配置校验、凭据不回传、原文分批、ID 覆盖、跨批关联、Zabbix 大整数游标与恢复事件、夜莺历史与不完整分页、Alertmanager 消失不等于恢复、禁止带凭据跟随重定向、同窗口去重、关闭 IM、失败数据版、发送结果未知、重启恢复、DSH 事件读取及取消。
3. 隔离目录中安装真实 `@deepseek-ai/dsh@0.2.1-rc.5`，通过原生插件安装命令加载；使用实际 Web Host，不是仿制壳。
4. Headless Edge 中验证侧栏入口、页面加载、来源保存、模拟夜莺 API 采集、任务保存、可选 IM、真实 DSH 会话发起、报告和原文分页展示；没有浏览器脚本错误。
5. 隔离 DSH 未配置模型：真实调用被记录为“分析失败”，原文和会话 ID 保留，没有错误宣称 AI 成功。

## 0.1.1 增量验证

- 自动测试共 25 项，新增 SQLite WAL 数据迁移、原库保留、持久路径重启读取、目标已有数据库拒绝覆盖、磁盘缺失拒绝创建空库、目录指针保存失败回退和迁移期间管理写入/调度隔离。
- IM 测试验证渠道/机器人发现、去除平台原生 route、保存时目标校验、配置保存不发消息，以及更新投递配置不会改变历史报告目标和调度时间。
- Headless Edge 中以真实页面组件、后端 Handler 和 SQLite 运行本地页面联调；IM 服务使用模拟机器人。验证渠道 → 机器人 → 群目标 → 保存、无目标提示、相对路径拒绝、目录迁移后历史记录保留和页面刷新后的路径展示。
- 上述增量页面测试没有向真实 IM 平台发送消息；真实机器人投递仍需现场验证。
- 新 `.tgz` 安装到独立 DSH 0.2.1-rc.5 Web profile，验证原生侧栏与新页面、通过原生管理接口迁移数据库、停止并重启 Host 后继续读取新路径；没有浏览器脚本错误。

## 未验证

- 用户 Ubuntu 的进程管理、文件权限、具体监控版本、真实分页/历史保留行为。
- 用户模型的 JSON 输出成功率、速度、跨告警关联质量和知识检索效果。
- 用户本机 DSH-IM 的机器人发现及真实群聊投递。
- 大型告警库长期运行、断电恢复、连续数天追赶和多用户并发编辑。

## 0.1.2 持续采集与本地巡检

- 接口核对日期：2026-11-09。核对夜莺 v9.1.0、v9.1.1 的个人 Token 鉴权、历史接口时间过滤和恢复字段，不代表用户实例已经联调通过。
- 来源添加并启用后独立后台采集，默认 60 秒轮询，可配置 15–3600 秒；夜莺首次读取最近 30 分钟，后续依据持久采集进度和 2 分钟重叠范围继续拉取。个人 Token 使用 `X-User-Token`，需启用 `[HTTP.TokenAuth] Enable = true`，`is_recovered=0` 排除恢复记录。
- 巡检只读取本地数据库，每次实际开始时查询此前一个巡检周期的 `[start,end)`；默认周期为 30 分钟。未覆盖的窗口须标记不完整，不把空列表当作无告警结论；不再延迟 2 分钟执行或逐窗补排停机期间的巡检。
- 2026-11-09 在 Windows / Node.js 25.5.0 执行 `npm run check`，页面构建及全部 51 项测试通过。测试临时目录使用可写工作区。新增测试覆盖无巡检任务时独立采集、事件幂等保存、事务回滚、失败重试、重启续采、实际执行时的本地窗口查询、自定义目录迁移保留事件和进度，以及编辑来源和并发保存时的隔离。
- 夜莺接口用例使用模拟响应；尚未完成真实夜莺 v9.1 的认证、权限、后台采集和数据验证。未新增活跃列表采集或生命周期关联，不把历史触发记录的 `recover_time=0` 解释为当前持续告警。

## 0.1.3 分析回复格式修正

- 2026-11-09 在 Windows / Node.js 25.5.0 执行 `npm run check`，页面构建及全部 79 项测试通过。
- 使用脱敏合成回复覆盖 PromQL 双引号未转义和 `actions` 数组缺闭合括号；验证只对 JSON 语法错误进行一次修正、同一总超时和取消信号、禁止全部工具（包括 `run_code`）、分批和最终合并阶段均有效。
- 修正输出需通过结构、告警 ID 和逐字内容检查；改写事实、查询符号、字符串内空白、ID、字段顺序，或补写截断正文均被拒绝。缺失/编造 ID 不作为语法错误重试。
- 验证原始及修正回复持久化、重分析保留旧版诊断、详情按需返回、列表轮询不包含回复原文，以及修正失败只投递一次标明失败的数据汇总。
- 用户提供的真实回复在本地内存回放中复现两类语法错误，修正后通过上述校验。测试使用预设模型回复，未连接生产模型、监控工具或飞书；真实资产、附件和生成报告均未加入仓库。

## 0.1.4 巡检等待正常轮询覆盖

- 2026-11-09 在 Windows / Node.js 25.5.0 执行 `npm run check`，页面构建及全部 102 项测试通过。
- 模拟单独夜莺及多个来源：只等待任务所选来源，未选择或未配置的平台不影响结果。后台下一轮独立提交后，尾部事件纳入原固定窗口，巡检不主动发起上游请求。
- 验证等待上限、后台失败、前段缺口、初次采集、长期落后、来源换代/停用、Alertmanager 快照，以及取消和 Host 关闭时的等待清理。真实缺口不被当作完整数据；旧报告保持原快照口径。
- 验证页面/飞书共用的来源提示包含具体前段和末尾缺口，及首次采集、失败和快照限制；没有把尚未接入的其他平台列为缺失。
- 使用模拟接口及分析器，尚未在用户生产 DSH 中验证新版等待和实际轮询耗时。

## 0.1.5 零告警静默与 Markdown 卡片

- 2026-11-09 在 Windows / Node.js 25.5.0 执行 `npm run check`，构建及 125 项测试通过。
- 验证定时/手动巡检零告警不建立投递，`partial`/失败及 `sendDataOnFailure` 不绕过静默规则；旧 pending 空记录跳过、重启不补发、accepted/unknown 历史保留。有告警的失败汇总继续遵循原配置。
- 验证新投递持久保存 Markdown 格式并传递给 DSH-IM，旧消息仍按原格式重试；保持同版本目标幂等和结果未知不自动重发。
- 验证北京时间及跨日、事件资产/原始等级/记录时间、结论/待核实/建议分区、动态文本转义、消息长度与截断提示、长名称不遮盖缺口、覆盖提醒及批次入口保留。完整报告不被摘要操作改写。
- 核实 DSH-IM v5.10.0 的 `send(...,{format:"markdown"})` 文档、服务透传、飞书原生卡片实现及官方测试。未向真实飞书发送测试消息，实际样式需在用户加载支持此格式的 DSH-IM 后确认。

## 0.1.6 巡检记录单条与批量删除

- 2026-11-11 在 Windows / Node.js 25.5.0 执行 `npm run check`，页面构建及 143 项测试通过，其中新增 18 项删除相关测试（含状态子测试）。
- 验证单条与批量删除、重复 ID 去重、无效及不存在的 ID、活动状态整批拒绝；通过 SQLite 触发器注入失败，验证记录及投递一起回滚。250 条关联投递全部清理，不受页面 200 条投递列表上限影响。
- 验证排队需先取消、当前执行保护、多目标异步投递全程保护、旧投递快照不能发送或恢复已删记录，也不会重复发送已经确认的消息；迁移、关闭与请求取消期间拒绝删除。
- 验证删除后报告与原文接口不可读取，定时任务配置、独立告警历史与采集进度仍可供下一次巡检使用；重开数据库后删除结果保持。
- Headless Edge 中运行真实 React 页面与模拟 RPC，22 项交互断言通过：默认聚焦取消、取消不发请求、单条删除、全选排除活动记录、防止重复提交、失败保留确认框、轮询清理选择以及删除后关闭报告与原文。已检查 1400×1100 页面截图；这不替代生产 DSH 的端到端验证。
- 新增功能使用本地模拟数据与投递服务验证，未删除用户生产数据、未向真实 IM 发送消息。DSH 0.2.2-rc.1 的完整宿主联调尚未完成。

## 0.1.7 本地格式修正与分析会话复用

- 2026-11-11 在 Windows / Node.js 25.5.0 执行 `npm run check`，页面构建及 166 项自动测试通过。
- 本地修复验证缺失容器闭合、完整 PromQL 标签选择器引号转义、保留转义与字段顺序，并拒绝截断正文/值、歧义引号、缺逗号/冒号、额外文本和超限输入；保留原有逐字内容和告警 ID 校验。
- 用户提供的格式修正请求内 `previousOutput` 在内存回放，仅需补 1 个 `]`，本地处理约 1.2ms；原模型格式修正耗时 3分33秒。该结果是本地格式处理测试，不代表生产模型整体耗时；附件及真实资产内容没有进入仓库。
- 验证同一执行上下文跨分批复用一个会话、重新分析独立、策略不叠加、会话失效不绕过工具限制、并发请求拒绝、取消与同步异常清理；零告警完整/不足/失败均不调用模型。
- 验证默认 8 次/自定义 0–50 次查询预算，按工具执行 token 计数，PTC 内层调用分别计费、传输本身不计；预算跨分批共享，不影响未授权工具拦截。预算耗尽限制查询次数，未承诺固定总响应时长。
- Headless Edge 真实 React 页面与模拟 RPC 的 17 项交互断言通过：新旧任务默认预算、输入范围、保存 0 与自定义次数、本地/旧版 AI 修正标签、耗时和累计补查次数，以及旧报告缺字段兼容；已检查截图布局。
- 核对 DSH 0.2.2-rc.1 的 sessionController.create/prompt/rename、ToolExecution.token 和 guard/restrict 契约，rc.5 同样具备所用工具策略接口。测试使用模拟 Host 与预设回复，未在用户的生产模型和真实 MCP 上测量新版整轮耗时；未修改其模型、自动化任务或历史会话。

## 0.1.8 飞书五段简报

- 本轮验证范围：结论优先、固定五段顺序、任务/窗口/数量置于事件段、来源和原始等级不展示、尾部仅巡检 ID；具体来源缺口保留在本地报告，飞书仅保留结论适用范围提示。
- 分析结构兼容检查：新报告的 `correlation` 独立保存和呈现，旧报告缺字段仍可读取；不将多条告警归为同一事件直接当成已验证共同根因，不新增模型回合或会话。
- 消息边界检查：多事件与建议有界呈现、建议去重、长内容不截断成误导性半句、Markdown 动态文本转义、跨日及缺失时间，以及分析失败不使用旧报告结论。
- 本地构建和 176 项自动测试通过，包含 14 项五段消息布局检查及 6 项关联字段回归；已查看单事件消息预览。测试使用模拟回复与 IM 服务，真实飞书卡片投递仍需在用户环境验收，未向生产群发送测试消息。

## 0.1.9 飞书卡片排版

- 本轮验证范围：飞书 / Lark 使用五段蓝色标签、分隔线、灰色辅助文字与固定动作序号，其他渠道继续使用通用 Markdown；结论仍置顶，尾部仅巡检 ID。
- 边界检查包括动态内容实体转义、禁止告警内容注入卡片标签或提及、完整保留否定与条件句、待核实事项省略计数、消息长度与单事件序号，以及零告警静默和投递幂等。
- 核对 DSH-IM v5.10.0 的公开契约：`format: "markdown"` 将正文置入 Card 2.0 的 Markdown 组件，以 `interactive` 消息发送；不提供自定义卡头或任意卡片 JSON 入参。样式复用此接口，无需新增 Webhook，也不增加模型回合。
- 本地构建和 199 项自动测试通过，包括 12 项卡片格式回归和飞书 / Lark / 非飞书渠道路由、重启后旧正文保留及不确定结果不补发检查。已检查桌面和窄屏的本地样式模拟图，窄屏未出现横向溢出。
- 自动测试和本地预览使用模拟报告与 IM 服务；预览图不是飞书客户端截图，真实飞书渲染及投递仍需在用户环境验收，本轮未向生产群发送测试消息。

## 公开接口依据

- [DSH rc.5 Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/api/session-controller/src/index.ts)：`create`、`prompt`、`cancel`。
- [DSH rc.5 会话请求类型](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/api/session-controller/src/types.ts)：`cwd`、`agentPreset`、`requestId`、`mode`、`content`。
- [DSH rc.5 工具权限](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/core/tools/src/index.ts)：Agent scope 下 `restrict` 和最终 `guard`。
- [DSH 0.2.2-rc.1 会话接口](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/api/session-controller/src/types.ts)：按 sessionId 顺序提交 prompt；[会话命令](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/api/session-controller/src/commands.ts)提供 rename。
- [DSH 0.2.2-rc.1 工具执行标识](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/core/tools/src/contracts.ts)：token 区分实际调用，rootCallId 可由 PTC 子调用共享；[工具流水线](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/core/tools/src/pipeline.ts)在执行前检查 guard。
- [DSH-IM v5.10.0 主动投递](https://github.com/xmanrui/dsh-im/blob/v5.10.0/PROACTIVE_DELIVERY.md)：本机 `listBots`、`listTargets`、`send`；不假定带投递幂等键或自动重试。
- [DSH-IM v5.10.0 Markdown 卡片](https://github.com/xmanrui/dsh-im/blob/v5.10.0/src/channels/feishu/feishu-runtime.mjs#L726)：Markdown 文本发送为飞书 interactive 卡片；[官方测试](https://github.com/xmanrui/dsh-im/blob/v5.10.0/test/channels/feishu/proactive-markdown.test.mjs#L58)验证格式和单次投递。
- [飞书 Card 2.0 富文本语法](https://open.feishu.cn/document/feishu-cards/feishu-card-cardkit/components/markdown?lang=zh-CN)：分区标签、彩色文字、分隔线与 Markdown 标题。
- [DSH-IM 客户端插件构建示例](https://github.com/xmanrui/dsh-im/blob/v5.10.0/plugin-src/client/build.mjs)：客户端模块装载格式；本项目按该接口独立实现。
- [Zabbix 7.0 event.get](https://www.zabbix.com/documentation/7.0/en/manual/api/reference/event/get)：历史问题时间窗和 eventid 游标。
- [夜莺官方 API 说明](https://flashcat.cloud/docs/content/flashcat-monitor/nightingale-v9/usecase/api/)：个人 Token 使用 `X-User-Token`，需开启 `HTTP.TokenAuth.Enable`。
- [夜莺 v9.1.0 鉴权实现](https://github.com/ccfos/nightingale/blob/v9.1.0/center/router/router_mw.go)：个人 Token 与 Bearer JWT 使用不同认证入口。
- [夜莺 v9.1.0 历史接口](https://github.com/ccfos/nightingale/blob/v9.1.0/center/router/router_alert_his_event.go)：`stime/etime`、`is_recovered`、`p/limit` 参数及 `dat.list/dat.total` 响应。
- [夜莺 v9.1.0 历史模型](https://github.com/ccfos/nightingale/blob/v9.1.0/models/alert_his_event.go)：时间过滤字段为 `last_eval_time`，触发和恢复分别保存为历史记录。

业务实现是本插件的设计，不代表上述项目官方推荐或认可。


## 0.2.0 查询方案与证据预取

- 2026-11-12 在 Windows / Node.js 25.5.0 执行 `npm run check`，页面构建及全部 257 项自动测试通过；锁文件已通过离线 npm 解析验证。
- 查询方案测试覆盖旧配置迁移、用途自动匹配与歧义拒绝、固定 IP/时间窗范围、Python 数据字面量解析、候选路径与资产歧义保留、结果截断、任务及连接器隔离缓存、协作取消后等待所属调用结束。没有使用生产 IP、资产名称或告警原文作为仓库测试数据。
- DSH 工具契约依据官方 `dsh-v0.2.2-rc.1` 源码核对；模拟执行管线回归覆盖一次性固定查询许可、任意工具拒绝、最终内容脱敏、策略上下文透传、结束政策、嵌套调用归属、补查预算与去重。携带额外策略上下文的结果不跨会话缓存。
- 固定 PostgreSQL 资产和窗口事件 SQL 已通过已授权环境的只读 `EXPLAIN`；Neo4j 查询使用不存在的合成端点验证语法。未修改数据库或索引。接口/设备事件表当前可能顺序扫描，本版不承诺数据库查询均有索引。
- 验证预取与顺序分批共用同一个插件自建会话；零告警定时、手动、重新分析及来源失败均不创建或提示会话、不发送 IM。轮询列表不携带完整查询证据，详情保留查询记录和缺口。
- Headless Edge 使用真实 React 组件和模拟 RPC，19 项交互检查通过：旧任务打开、按用途过滤工具、保存方案及数值 0、保存负载移除旧字段、报告查询明细与缺口、证据导出入口；已查看页面截图。此检查没有接触真实 DSH 或 IM。
- 尚未在用户 Ubuntu 的真实 DSH / 模型 / MCP 组合上执行升级后的端到端巡检或耗时对照。默认 15 秒为协作取消时限，仍取决于 MCP 传输响应取消；模型生成与采集等待另计，不承诺固定总时长。未发送真实飞书消息。

## 0.2.1 独立查询方案库

- 2026-11-13 在 Windows / Node.js 25.5.0 执行 `npm run check`，页面构建及全部 272 项自动测试通过。
- 方案库覆盖默认初始化、旧任务内嵌配置的持久幂等迁移、重复恢复旧配置后的内容保留、独立修订、过期编辑拒绝、引用删除保护，以及异步目标校验期间并发修改的处理；省略方案库的旧设置写入不会清空现有方案。
- 验证任务仅存方案 ID，新批次入队冻结内容、名称和修订；共享方案修改或删除不改变排队、运行、历史及重新分析使用的快照。旧报告保持可读，资产缓存按方案库 ID/修订隔离，报告正文与查询证据导出保留选用方案。
- Headless Edge 使用真实 React 组件和模拟 RPC，30 项交互检查通过：新建/编辑/复制/删除、修订校验负载、引用任务显示与禁删、任务仅选择方案、往返方案页保留任务草稿、报告快照和实际点击导出查询证据。已查看方案库、任务表单、方案编辑和报告截图，页面布局正常。
- 此轮未连接用户生产 DSH、模型或 MCP，未触发实际巡检或飞书投递；本地验证不替代用户服务器升级后的端到端验收。
