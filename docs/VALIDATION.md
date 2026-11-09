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

## 公开接口依据

- [DSH rc.5 Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/api/session-controller/src/index.ts)：`create`、`prompt`、`cancel`。
- [DSH rc.5 会话请求类型](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/api/session-controller/src/types.ts)：`cwd`、`agentPreset`、`requestId`、`mode`、`content`。
- [DSH rc.5 工具权限](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/core/tools/src/index.ts)：Agent scope 下 `restrict` 和最终 `guard`。
- [DSH-IM v5.10.0 主动投递](https://github.com/xmanrui/dsh-im/blob/v5.10.0/PROACTIVE_DELIVERY.md)：本机 `listBots`、`listTargets`、`send`；不假定带投递幂等键或自动重试。
- [DSH-IM 客户端插件构建示例](https://github.com/xmanrui/dsh-im/blob/v5.10.0/plugin-src/client/build.mjs)：客户端模块装载格式；本项目按该接口独立实现。
- [Zabbix 7.0 event.get](https://www.zabbix.com/documentation/7.0/en/manual/api/reference/event/get)：历史问题时间窗和 eventid 游标。
- [夜莺官方 API 说明](https://flashcat.cloud/docs/content/flashcat-monitor/nightingale-v9/usecase/api/)：个人 Token 使用 `X-User-Token`，需开启 `HTTP.TokenAuth.Enable`。
- [夜莺 v9.1.0 鉴权实现](https://github.com/ccfos/nightingale/blob/v9.1.0/center/router/router_mw.go)：个人 Token 与 Bearer JWT 使用不同认证入口。
- [夜莺 v9.1.0 历史接口](https://github.com/ccfos/nightingale/blob/v9.1.0/center/router/router_alert_his_event.go)：`stime/etime`、`is_recovered`、`p/limit` 参数及 `dat.list/dat.total` 响应。
- [夜莺 v9.1.0 历史模型](https://github.com/ccfos/nightingale/blob/v9.1.0/models/alert_his_event.go)：时间过滤字段为 `last_eval_time`，触发和恢复分别保存为历史记录。

业务实现是本插件的设计，不代表上述项目官方推荐或认可。
