# 验证与接口依据

目标版本：DSH 0.2.1-rc.5。验证时间：2026-11-06。

## 已验证

1. 页面通过 esbuild 构建成 DSH `window.__ModuleLoader__` 客户端插件。
2. Node 内置测试覆盖：配置校验、凭据不回传、原文分批、ID 覆盖、跨批关联、Zabbix 大整数游标与恢复事件、夜莺历史与不完整分页、Alertmanager 消失不等于恢复、禁止带凭据跟随重定向、同窗口去重、关闭 IM、失败数据版、发送结果未知、重启恢复、DSH 事件读取及取消。
3. 隔离目录中安装真实 `@deepseek-ai/dsh@0.2.1-rc.5`，通过原生插件安装命令加载；使用实际 Web Host，不是仿制壳。
4. Headless Edge 中验证侧栏入口、页面加载、来源保存、模拟夜莺 API 采集、任务保存、可选 IM、真实 DSH 会话发起、报告和原文分页展示；没有浏览器脚本错误。
5. 隔离 DSH 未配置模型：真实调用被记录为“分析失败”，原文和会话 ID 保留，没有错误宣称 AI 成功。

## 未验证

- 用户 Ubuntu 的进程管理、文件权限、具体监控版本、真实分页/历史保留行为。
- 用户模型的 JSON 输出成功率、速度、跨告警关联质量和知识检索效果。
- 用户本机 DSH-IM 的机器人发现及真实群聊投递。
- 大型告警库长期运行、断电恢复、连续数天追赶和多用户并发编辑。

## 公开接口依据

- [DSH rc.5 Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/api/session-controller/src/index.ts)：`create`、`prompt`、`cancel`。
- [DSH rc.5 会话请求类型](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/api/session-controller/src/types.ts)：`cwd`、`agentPreset`、`requestId`、`mode`、`content`。
- [DSH rc.5 工具权限](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/core/tools/src/index.ts)：Agent scope 下 `restrict` 和最终 `guard`。
- [DSH-IM v5.10.0 主动投递](https://github.com/xmanrui/dsh-im/blob/v5.10.0/PROACTIVE_DELIVERY.md)：本机 `listBots`、`listTargets`、`send`；不假定带投递幂等键或自动重试。
- [DSH-IM 客户端插件构建示例](https://github.com/xmanrui/dsh-im/blob/v5.10.0/plugin-src/client/build.mjs)：客户端模块装载格式；本项目按该接口独立实现。
- [Zabbix 7.0 event.get](https://www.zabbix.com/documentation/7.0/en/manual/api/reference/event/get)：历史问题时间窗和 eventid 游标。
- [夜莺官方查询说明](https://github.com/ccfos/nightingale/blob/main/aiagent/skill/embedded/builtin/query-alert-events/SKILL.md)：历史路径、分页和 Bearer Token。
- [夜莺历史模型实现](https://github.com/ccfos/nightingale/blob/main/models/alert_his_event.go)：时间过滤字段为 `last_eval_time`。main 会变化，用户现场版本需复核。

业务实现是本插件的设计，不代表上述项目官方推荐或认可。
