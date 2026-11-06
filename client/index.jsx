import React, { useCallback, useEffect, useState } from "react";
import { DEFAULT_INSTRUCTIONS } from "../src/analysis.mjs";
import { CSS } from "./styles.js";
export const name = "ops-assistant-ui";
export const inject = ["slots", "connection"];
const PANEL = "dsh-ops-assistant";
const labels = {
  queued: "等待执行",
  collecting: "正在采集",
  analyzing: "正在分析",
  completed: "分析完成",
  failed: "失败",
  interrupted: "运行中断",
  cancelled: "已取消",
  pending: "待投递",
  sending: "投递中",
  accepted: "平台已接受",
  unknown: "投递结果未知",
  ok: "完整查询",
  partial: "数据不完整",
};
const sourceLabels = {
  zabbix: "Zabbix",
  nightingale: "夜莺 Nightingale",
  alertmanager: "Prometheus / Alertmanager",
};
const time = (t) =>
  t
    ? new Date(t).toLocaleString("zh-CN", {
        hour12: false,
        timeZone: "Asia/Shanghai",
      })
    : "—";
const empty = {
  config: { sources: [], tasks: [] },
  runs: [],
  deliveries: [],
  pollStatus: {},
};
const freshTask = () => ({
  name: "每 30 分钟告警巡检",
  sourceIds: [],
  intervalMinutes: 30,
  timeoutMinutes: 15,
  maxBatchChars: 20000,
  workspace: "/opt/dsh-ops-assistant",
  agentPreset: "",
  instructions: DEFAULT_INSTRUCTIONS,
  allowedTools: [],
  enabled: false,
  deliveryMode: "off",
  targets: [],
  sendDataOnFailure: true,
});

function Badge({ status, children }) {
  return (
    <span className={`ops-badge ops-${status}`}>
      {children ?? labels[status] ?? status}
    </span>
  );
}
function Field({ title, hint, children, group = false }) {
  const id = React.useId();
  const Tag = group ? "span" : "label";
  return (
    <div className="ops-field">
      <Tag htmlFor={group ? undefined : id}>{title}</Tag>
      {group ? children : React.cloneElement(children, { id })}
      {hint && <small>{hint}</small>}
    </div>
  );
}
function Button({ children, primary, danger, ...props }) {
  return (
    <button
      className={`ops-button${primary ? " ops-primary" : ""}${danger ? " ops-danger" : ""}`}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}
function Empty({ children }) {
  return <div className="ops-empty">{children}</div>;
}

export function OpsPanel({ call }) {
  const [state, setState] = useState(empty);
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState(null);
  const [task, setTask] = useState(null);
  const [bots, setBots] = useState([]);
  const [targets, setTargets] = useState([]);
  const [botId, setBotId] = useState("");
  const [tools, setTools] = useState([]);
  const [report, setReport] = useState(null);
  const [raw, setRaw] = useState(null);
  const refresh = useCallback(
    async () => setState(await call("state", {})),
    [call],
  );
  useEffect(() => {
    let active = true;
    const load = () =>
      call("state", {})
        .then((v) => {
          if (active) setState(v);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [call]);
  async function act(action, success) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await action();
      await refresh();
      if (success) setNotice(success);
      return value;
    } catch (e) {
      setError(e.message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  async function editTask(value) {
    setTask(structuredClone(value ?? freshTask()));
    setBotId("");
    setTargets([]);
    const [b, t] = await Promise.all([
      call("im.bots", {}),
      call("tools.list", {}),
    ]);
    setBots(b);
    setTools(t);
  }
  const setTaskField = (key, value) => setTask((t) => ({ ...t, [key]: value }));
  const toggleSource = (id) =>
    setTaskField(
      "sourceIds",
      task.sourceIds.includes(id)
        ? task.sourceIds.filter((x) => x !== id)
        : [...task.sourceIds, id],
    );
  async function openReport(id) {
    const result = await act(() => call("run.get", { id }));
    if (result) {
      setReport(result);
      setRaw(null);
    }
  }
  function download(text, filename, type = "text/plain;charset=utf-8") {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const activeRuns = state.runs.filter((r) =>
    ["queued", "collecting", "analyzing"].includes(r.status),
  );
  const showRuns = (rows) => (
    <div className="ops-table-wrap">
      <table>
        <thead>
          <tr>
            <th>巡检任务 / 时间窗</th>
            <th>告警</th>
            <th>分析状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((run) => (
            <tr key={run.id}>
              <td>
                <strong>{run.task.name}</strong>
                <small>
                  {time(run.start)} → {time(run.end)}
                </small>
                <small>{run.id}</small>
              </td>
              <td>
                {run.alertCount} 条
                <small>已覆盖 {run.coveredCount || run.analyzed || 0} 条</small>
              </td>
              <td>
                <Badge status={run.status} />
                {run.sources.some((s) => s.status !== "ok") && (
                  <small className="ops-warn">数据源不完整</small>
                )}
                <small>{run.stage}</small>
              </td>
              <td>
                <div className="ops-actions">
                  <Button onClick={() => openReport(run.id)}>查看报告</Button>
                  {["queued", "collecting", "analyzing"].includes(
                    run.status,
                  ) ? (
                    <Button
                      danger
                      disabled={busy}
                      onClick={() =>
                        act(
                          () => call("run.cancel", { id: run.id }),
                          "已请求取消",
                        )
                      }
                    >
                      取消
                    </Button>
                  ) : (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        act(
                          () => call("run.retry", { id: run.id }),
                          "已排队重新分析，复用保留的原文",
                        )
                      }
                    >
                      重新分析
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <Empty>尚无巡检记录。先添加告警源和任务，再运行一次。</Empty>
      )}
    </div>
  );

  return (
    <div className="ops-root">
      <style>{CSS}</style>
      <header className="ops-header">
        <div>
          <div className="ops-eyebrow">OPERATIONS · DSH</div>
          <h1>运维管理</h1>
          <p>接入告警，关联分析，把有依据的结论交给团队。</p>
        </div>
        <div className="ops-header-actions">
          <Badge status={state.imAvailable ? "ok" : "partial"}>
            {state.imAvailable ? "本地 IM 插件可用" : "本地 IM 插件未启用"}
          </Badge>
          <Button disabled={busy} onClick={() => act(refresh)}>
            刷新
          </Button>
        </div>
      </header>
      <nav className="ops-tabs">
        {[
          ["overview", "运行概览"],
          ["sources", "告警接入"],
          ["tasks", "巡检任务"],
          ["reports", "分析报告"],
          ["deliveries", "IM 投递"],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <div role="alert" className="ops-notice ops-error">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="ops-notice">
          {notice}
        </div>
      )}
      {state.fatalError && (
        <div role="alert" className="ops-notice ops-error">
          运行异常：{state.fatalError}
        </div>
      )}
      {tab === "overview" && (
        <>
          <div className="ops-stats">
            {[
              [
                "已接入告警源",
                state.config.sources.filter((s) => s.enabled).length,
                "按来源保留原始记录",
              ],
              [
                "自动巡检任务",
                state.config.tasks.filter((t) => t.enabled).length,
                "Host 运行期间按周期执行",
              ],
              ["正在处理", activeRuns.length, "采集、分析与等待队列"],
              [
                "待处理投递",
                state.deliveries.filter((d) => d.status !== "accepted").length,
                "每个目标分别记录状态",
              ],
            ].map(([label, value, hint]) => (
              <article key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>{hint}</small>
              </article>
            ))}
          </div>
          <section className="ops-section">
            <div className="ops-section-title">
              <h2>最近巡检</h2>
              <Button
                onClick={() => {
                  setTab("tasks");
                  act(() => editTask());
                }}
              >
                新建巡检任务
              </Button>
            </div>
            {showRuns(state.runs.slice(0, 8))}
          </section>
          <div className="ops-footnote">
            窗口采用北京时间展示、UTC 保存。自动任务在窗口结束 2
            分钟后开始；历史缺失会在报告中明确标记。
          </div>
        </>
      )}
      {tab === "sources" && (
        <section className="ops-section">
          <div className="ops-section-title">
            <div>
              <h2>告警接入</h2>
              <p>直接从监控平台采集告警。凭据保存在 DSH 凭据服务中。</p>
            </div>
            <Button
              primary
              onClick={() =>
                setSource({
                  name: "",
                  type: "nightingale",
                  url: "",
                  token: "",
                  enabled: true,
                  authMode: "bearer",
                })
              }
            >
              添加告警源
            </Button>
          </div>
          <div className="ops-grid">
            {state.config.sources.map((s) => (
              <article className="ops-source-card" key={s.id}>
                <div className="ops-card-top">
                  <h3>{s.name}</h3>
                  <Badge status={s.enabled ? "ok" : "cancelled"}>
                    {s.enabled ? "已启用" : "已停用"}
                  </Badge>
                </div>
                <p>{sourceLabels[s.type]}</p>
                <code>{s.url}</code>
                {s.type === "alertmanager" && (
                  <p className="ops-warn">快照观测，无法保证完整历史</p>
                )}
                {state.pollStatus[s.id] && (
                  <small>
                    最近轮询：{time(state.pollStatus[s.id].at)} ·{" "}
                    {state.pollStatus[s.id].ok ? "成功" : "失败"}
                  </small>
                )}
                <div className="ops-actions">
                  <Button onClick={() => setSource({ ...s, token: "" })}>
                    编辑
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        const result = await call("source.test", { id: s.id });
                        setNotice(`查询到 ${result.count} 条。${result.note}`);
                      })
                    }
                  >
                    测试采集
                  </Button>
                </div>
              </article>
            ))}
          </div>
          {!state.config.sources.length && (
            <Empty>接入第一个告警源，让巡检有数据可查。</Empty>
          )}
        </section>
      )}
      {tab === "tasks" && (
        <section className="ops-section">
          <div className="ops-section-title">
            <div>
              <h2>巡检任务</h2>
              <p>设置来源、分析步骤和可选的 IM 投递。</p>
            </div>
            <Button
              primary
              disabled={busy}
              onClick={() => act(() => editTask())}
            >
              新建任务
            </Button>
          </div>
          {state.config.tasks.map((t) => (
            <article className="ops-task-card" key={t.id}>
              <div>
                <div className="ops-card-top">
                  <h3>{t.name}</h3>
                  <Badge status={t.enabled ? "ok" : "cancelled"}>
                    {t.enabled ? "自动执行中" : "自动执行已关闭"}
                  </Badge>
                </div>
                <p>
                  每 {t.intervalMinutes} 分钟 · {t.sourceIds.length} 个来源 ·{" "}
                  {t.deliveryMode === "off"
                    ? "仅保存在本地"
                    : t.deliveryMode === "manual"
                      ? "手动审核后推送"
                      : "自动推送到 IM"}
                </p>
                <small>
                  分析预设：{t.agentPreset || "使用 DSH 默认"} ·{" "}
                  {t.allowedTools.length} 个授权补查工具
                </small>
              </div>
              <div className="ops-actions">
                <Button onClick={() => act(() => editTask(t))}>配置</Button>
                <Button
                  primary
                  disabled={busy}
                  onClick={() =>
                    act(() => call("task.run", { id: t.id }), "已加入执行队列")
                  }
                >
                  立即巡检
                </Button>
              </div>
            </article>
          ))}
          {!state.config.tasks.length && (
            <Empty>添加任务后，可先手动运行，再开启自动巡检。</Empty>
          )}
        </section>
      )}
      {tab === "reports" && (
        <section className="ops-section">
          <div className="ops-section-title">
            <h2>分析报告</h2>
            <span className="ops-muted">
              保留告警原文、分析会话和完整性记录
            </span>
          </div>
          {showRuns(state.runs)}
        </section>
      )}
      {tab === "deliveries" && (
        <section className="ops-section">
          <div className="ops-section-title">
            <h2>IM 投递记录</h2>
            <span className="ops-muted">
              “平台已接受”不代表已读；结果未知时不自动重发。
            </span>
          </div>
          <div className="ops-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>报告 / 目标</th>
                  <th>状态</th>
                  <th>尝试</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {state.deliveries.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <strong>{d.targetId}</strong>
                      <small>机器人：{d.botId}</small>
                      <small>批次：{d.runId}</small>
                    </td>
                    <td>
                      <Badge status={d.status} />
                      <small>{d.error}</small>
                    </td>
                    <td>{d.attempts}</td>
                    <td>
                      {!["accepted", "sending"].includes(d.status) && (
                        <Button
                          disabled={busy}
                          onClick={() => {
                            if (
                              d.status === "unknown" &&
                              !window.confirm(
                                "消息可能已发送。请先核对接收端，确认仍要重发？",
                              )
                            )
                              return;
                            act(
                              () =>
                                call("delivery.retry", {
                                  id: d.id,
                                  confirmUnknown: d.status === "unknown",
                                }),
                              "已尝试投递",
                            );
                          }}
                        >
                          重试
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!state.deliveries.length && (
              <Empty>暂无投递。任务可以只保存报告，不开启 IM。</Empty>
            )}
          </div>
        </section>
      )}
      {source && (
        <div className="ops-overlay">
          <form
            className="ops-dialog"
            onSubmit={async (e) => {
              e.preventDefault();
              const v = await act(
                () => call("source.save", source),
                "告警源已保存",
              );
              if (v) setSource(null);
            }}
          >
            <div className="ops-section-title">
              <h2>{source.id ? "编辑" : "添加"}告警源</h2>
              <Button onClick={() => setSource(null)}>关闭</Button>
            </div>
            {error && <div role="alert" className="ops-notice ops-error">{error}</div>}
            <Field title="名称">
              <input
                required
                value={source.name}
                onChange={(e) => setSource({ ...source, name: e.target.value })}
              />
            </Field>
            <Field title="平台类型">
              <select
                value={source.type}
                onChange={(e) => setSource({ ...source, type: e.target.value })}
              >
                {Object.entries(sourceLabels).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              title="API 地址"
              hint={
                source.type === "zabbix"
                  ? "填写完整 api_jsonrpc.php 地址"
                  : "填写平台根地址，可包含部署子路径"
              }
            >
              <input
                required
                type="url"
                placeholder={
                  source.type === "zabbix"
                    ? "https://zabbix.example/api_jsonrpc.php"
                    : "https://monitor.example"
                }
                value={source.url}
                onChange={(e) => setSource({ ...source, url: e.target.value })}
              />
            </Field>
            <Field
              title="API Token"
              hint="编辑时留空保留原凭据；修改地址后须重新填写。"
            >
              <input
                type="password"
                autoComplete="new-password"
                value={source.token}
                onChange={(e) =>
                  setSource({ ...source, token: e.target.value })
                }
              />
            </Field>
            {source.type === "zabbix" && (
              <Field title="鉴权方式">
                <select
                  value={source.authMode}
                  onChange={(e) =>
                    setSource({ ...source, authMode: e.target.value })
                  }
                >
                  <option value="bearer">Authorization Bearer（新版）</option>
                  <option value="body">JSON-RPC auth（旧版）</option>
                </select>
              </Field>
            )}
            <label className="ops-check">
              <input
                type="checkbox"
                checked={source.enabled}
                onChange={(e) =>
                  setSource({ ...source, enabled: e.target.checked })
                }
              />
              启用此告警源
            </label>
            <button className="ops-button ops-primary" disabled={busy}>
              保存告警源
            </button>
          </form>
        </div>
      )}
      {task && (
        <div className="ops-overlay">
          <form
            className="ops-dialog ops-wide"
            onSubmit={async (e) => {
              e.preventDefault();
              const v = await act(() => call("task.save", task), "任务已保存");
              if (v) setTask(null);
            }}
          >
            <div className="ops-section-title">
              <div>
                <h2>{task.id ? "配置" : "新建"}巡检任务</h2>
                <p>先完成一次手动验证，再开启周期执行和自动推送。</p>
              </div>
              <Button onClick={() => setTask(null)}>关闭</Button>
            </div>
            {error && <div role="alert" className="ops-notice ops-error">{error}</div>}
            <div className="ops-form-grid">
              <div>
                <Field title="任务名称">
                  <input
                    required
                    value={task.name}
                    onChange={(e) => setTaskField("name", e.target.value)}
                  />
                </Field>
                <Field title="巡检周期（分钟）">
                  <input
                    type="number"
                    min="5"
                    max="1440"
                    value={task.intervalMinutes}
                    onChange={(e) =>
                      setTaskField("intervalMinutes", Number(e.target.value))
                    }
                  />
                </Field>
                <Field title="服务器上的工作目录">
                  <input
                    required
                    value={task.workspace}
                    onChange={(e) => setTaskField("workspace", e.target.value)}
                  />
                </Field>
                <Field
                  title="DSH 分析预设"
                  hint="填现有 Agent Preset ID；留空沿用默认模型与预设。"
                >
                  <input
                    value={task.agentPreset}
                    onChange={(e) =>
                      setTaskField("agentPreset", e.target.value)
                    }
                  />
                </Field>
                <Field title="采集与分析总超时（分钟）">
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={task.timeoutMinutes}
                    onChange={(e) =>
                      setTaskField("timeoutMinutes", Number(e.target.value))
                    }
                  />
                </Field>
                <Field
                  title="单批告警字符预算"
                  hint="超量自动分批；单条原文超限会报错，不会静默截断。"
                >
                  <input
                    type="number"
                    min="2000"
                    max="80000"
                    value={task.maxBatchChars}
                    onChange={(e) =>
                      setTaskField("maxBatchChars", Number(e.target.value))
                    }
                  />
                </Field>
                <label className="ops-check">
                  <input
                    type="checkbox"
                    checked={task.enabled}
                    onChange={(e) => setTaskField("enabled", e.target.checked)}
                  />
                  开启自动巡检
                </label>
              </div>
              <div>
                <Field title="选择告警源" group>
                  <div className="ops-options">
                    {state.config.sources
                      .filter((s) => s.enabled)
                      .map((s) => (
                        <label className="ops-check" key={s.id}>
                          <input
                            type="checkbox"
                            checked={task.sourceIds.includes(s.id)}
                            onChange={() => toggleSource(s.id)}
                          />
                          {s.name}
                        </label>
                      ))}
                    {!state.config.sources.some((s) => s.enabled) && (
                      <small>请先添加告警源。</small>
                    )}
                  </div>
                </Field>
                <Field title="报告投递">
                  <select
                    value={task.deliveryMode}
                    onChange={(e) =>
                      setTaskField("deliveryMode", e.target.value)
                    }
                  >
                    <option value="off">关闭：只保存在运维平台</option>
                    <option value="manual">手动：查看报告后点击推送</option>
                    <option value="auto">自动：完成后推送到选定目标</option>
                  </select>
                </Field>
                {task.deliveryMode !== "off" && (
                  <>
                    <Field title="本地 IM 机器人">
                      <select
                        value={botId}
                        onChange={async (e) => {
                          const id = e.target.value;
                          setBotId(id);
                          setTargets([]);
                          if (id) {
                            const t = await act(() =>
                              call("im.targets", { botId: id }),
                            );
                            if (t) setTargets(t);
                          }
                        }}
                      >
                        <option value="">选择机器人</option>
                        {bots.map((b) => (
                          <option key={b.botId} value={b.botId}>
                            {b.channel} · {b.botId}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field title="添加接收目标">
                      <select
                        value=""
                        onChange={(e) => {
                          if (
                            e.target.value &&
                            !task.targets.some(
                              (t) =>
                                t.botId === botId &&
                                t.targetId === e.target.value,
                            )
                          )
                            setTaskField("targets", [
                              ...task.targets,
                              { botId, targetId: e.target.value },
                            ]);
                        }}
                      >
                        <option value="">选择已保存的群聊或私聊目标</option>
                        {targets.map((t) => (
                          <option key={t.targetId} value={t.targetId}>
                            {t.name || t.targetId} · {t.kind}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div className="ops-targets">
                      {task.targets.map((t) => (
                        <div key={t.botId + t.targetId}>
                          <span>
                            {t.targetId}
                            <small>{t.botId}</small>
                          </span>
                          <Button
                            onClick={() =>
                              setTaskField(
                                "targets",
                                task.targets.filter((x) => x !== t),
                              )
                            }
                          >
                            移除
                          </Button>
                        </div>
                      ))}
                    </div>
                    <small>
                      目标在 DSH-IM 中创建；未安装 IM 插件不影响本地分析。
                    </small>
                    <label className="ops-check">
                      <input
                        type="checkbox"
                        checked={task.sendDataOnFailure}
                        onChange={(e) =>
                          setTaskField("sendDataOnFailure", e.target.checked)
                        }
                      />
                      分析失败时发送标明“AI 未完成”的数据汇总
                    </label>
                  </>
                )}
              </div>
            </div>
            <Field title="排查步骤（支持 Markdown，无需 SKILL 格式）">
              <textarea
                rows="8"
                value={task.instructions}
                onChange={(e) => setTaskField("instructions", e.target.value)}
              />
            </Field>
            <Field
              title="允许补查的工具"
              group
              hint="只勾选只读的知识检索、历史记忆和监控查询工具。未选择时仅分析输入的告警原文。"
            >
              <div className="ops-tool-list">
                {tools
                  .filter((t) => t.name !== "run_code")
                  .map((t) => (
                    <label
                      key={t.name}
                      className="ops-check"
                      title={t.description}
                    >
                      <input
                        type="checkbox"
                        checked={task.allowedTools.includes(t.name)}
                        onChange={(e) =>
                          setTaskField(
                            "allowedTools",
                            e.target.checked
                              ? [...task.allowedTools, t.name]
                              : task.allowedTools.filter((x) => x !== t.name),
                          )
                        }
                      />
                      <span>{t.name}</span>
                    </label>
                  ))}
                {!tools.length && (
                  <small>没有发现可选工具；请先在 DSH 中接入 MCP。</small>
                )}
              </div>
            </Field>
            <div className="ops-sticky-footer">
              <button className="ops-button ops-primary" disabled={busy}>
                保存任务
              </button>
            </div>
          </form>
        </div>
      )}
      {report && (
        <div className="ops-overlay">
          <div className="ops-dialog ops-wide">
            <div className="ops-section-title">
              <div>
                <h2>巡检报告</h2>
                <small>{report.run.id}</small>
              </div>
              <Button
                onClick={() => {
                  setReport(null);
                  setRaw(null);
                }}
              >
                关闭
              </Button>
            </div>
            <div className="ops-actions">
              <Button
                onClick={() =>
                  download(report.markdown, `巡检-${report.run.id}.md`)
                }
              >
                导出 Markdown
              </Button>
              <Button
                onClick={() =>
                  act(async () =>
                    setRaw(
                      await call("run.alerts", { id: report.run.id, page: 0 }),
                    ),
                  )
                }
              >
                查看原始告警（{report.run.alertCount}）
              </Button>
              {report.run.task.deliveryMode !== "off" &&
                !["queued", "collecting", "analyzing"].includes(
                  report.run.status,
                ) && (
                  <Button
                    primary
                    disabled={busy}
                    onClick={() =>
                      act(
                        () => call("run.deliver", { id: report.run.id }),
                        "投递结果请到 IM 投递页查看",
                      )
                    }
                  >
                    推送到已配置 IM
                  </Button>
                )}
            </div>
            <pre className="ops-report">{report.markdown}</pre>
            <details>
              <summary>分析会话 ID（可在 DSH 中追踪）</summary>
              <pre>{report.run.sessions.join("\n") || "暂无"}</pre>
            </details>
            {raw && (
              <div>
                <div className="ops-section-title">
                  <h3>原始记录 · 第 {raw.page + 1} 页</h3>
                  <div className="ops-actions">
                    <Button
                      disabled={raw.page === 0}
                      onClick={() =>
                        act(async () =>
                          setRaw(
                            await call("run.alerts", {
                              id: report.run.id,
                              page: raw.page - 1,
                            }),
                          ),
                        )
                      }
                    >
                      上一页
                    </Button>
                    <Button
                      disabled={(raw.page + 1) * 50 >= raw.total}
                      onClick={() =>
                        act(async () =>
                          setRaw(
                            await call("run.alerts", {
                              id: report.run.id,
                              page: raw.page + 1,
                            }),
                          ),
                        )
                      }
                    >
                      下一页
                    </Button>
                    <Button
                      onClick={() =>
                        download(
                          JSON.stringify(raw.items, null, 2),
                          `告警-${report.run.id}-page${raw.page + 1}.json`,
                          "application/json",
                        )
                      }
                    >
                      导出本页
                    </Button>
                  </div>
                </div>
                <pre className="ops-raw">
                  {JSON.stringify(raw.items, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Icon({ size = 16 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    >
      <rect x="2.5" y="3" width="15" height="12" rx="2" />
      <path d="M6 18h8M10 15v3M5 10h3l2-4 2 6 1-2h2" />
    </svg>
  );
}
export function apply(ctx) {
  const call = async (method, payload) => {
    const result = await ctx.connection.rpc.call("/api", PANEL, {
      method,
      payload,
    });
    if (result?.ok !== true)
      throw new Error(result?.error?.message ?? "无法连接运维插件");
    return result.value;
  };
  const render = () => <OpsPanel call={call} />;
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: PANEL,
        order: 22,
        label: () => "运维管理",
        inject: () => ({}),
      },
      render,
    ),
  );
  ctx.inject(["layout"], (pageCtx) =>
    pageCtx.slots.inject("main", () => {
      const main = pageCtx.slots.register(
        { name: "main", key: PANEL, inject: () => ({}) },
        render,
      );
      const sidebar = pageCtx.slots.inject("sidebar.panellist", () =>
        pageCtx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL,
            order: 11,
            label: () => "运维管理",
          },
          Icon,
        ),
      );
      return () => {
        sidebar();
        main();
      };
    }),
  );
}
