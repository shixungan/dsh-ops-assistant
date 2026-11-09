import React, { useCallback, useEffect, useState } from "react";
import { DEFAULT_INSTRUCTIONS } from "../src/analysis.mjs";
import { coverageWarnings } from "../src/coverage.mjs";
import { CSS } from "./styles.js";
import { DeliverySettings } from "./delivery-settings.jsx";
export const name = "ops-assistant-ui";
export const inject = ["slots", "connection"];
const PANEL = "dsh-ops-assistant";
const labels = {
  queued: "等待执行",
  collecting: "正在读取本地告警",
  analyzing: "正在分析",
  completed: "分析完成",
  failed: "失败",
  interrupted: "运行中断",
  cancelled: "已取消",
  pending: "待投递",
  sending: "投递中",
  accepted: "平台已接受",
  skipped: "已跳过（0 条告警）",
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
function SourceStatus({ status, enabled }) {
  if (!status)
    return <small>{enabled ? "等待首次后台采集" : "后台采集已停用"}</small>;
  const result = status.status ?? (status.ok ? "ok" : "failed");
  return (
    <div className="ops-footnote">
      <p>
        后台采集：{enabled ? ({ ok: "正常", partial: "数据不完整", failed: "失败" }[result] ?? "等待采集") : "已停用"}
        {" · "}本地告警：{status.count ?? 0} 条
      </p>
      <p>最近尝试：{time(status.at)} · 最近成功：{time(status.successAt)}</p>
      <p>已采集至：{time(status.coveredUntil)}</p>
      {status.note && <p>{status.note}</p>}
    </div>
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
  const [deliveryTask, setDeliveryTask] = useState(null);
  const [dataDir, setDataDir] = useState(null);
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
    setTools(await call("tools.list", {}));
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
                {coverageWarnings(run.sources).map((warning, index) => (
                  <small className="ops-warn" key={index}>{warning}</small>
                ))}
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
          ["storage", "数据存储"],
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
              ["正在处理", activeRuns.length, "本地查询、分析与等待队列"],
              [
                "待处理投递",
                state.deliveries.filter((d) => !["accepted", "skipped"].includes(d.status)).length,
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
            告警源独立持续采集到本地。巡检执行时查询此前一个巡检周期的本地告警；
            时间采用北京时间展示，采集尚未覆盖的时段会在报告中标记。
          </div>
        </>
      )}
      {tab === "sources" && (
        <section className="ops-section">
          <div className="ops-section-title">
            <div>
              <h2>告警接入</h2>
              <p>启用后持续采集并保存到本地，无需先创建巡检任务。凭据保存在 DSH 凭据服务中。</p>
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
                  pollIntervalSeconds: 60,
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
                <p>后台采集间隔：{s.pollIntervalSeconds ?? 60} 秒</p>
                {s.type === "alertmanager" && (
                  <p className="ops-warn">快照观测，无法保证完整历史</p>
                )}
                <SourceStatus status={state.pollStatus[s.id]} enabled={s.enabled} />
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
              <p>从本地告警中查询最近一个巡检周期的数据，按排查步骤分析并可选投递。</p>
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
            <div>
              <h2>DSH-IM 投递配置</h2>
              <p>为每个巡检任务选择渠道、机器人和接收目标。</p>
            </div>
          </div>
          <div className="ops-settings-body">
            <Field title="选择要配置投递的巡检任务">
              <select
                value={deliveryTask?.id ?? ""}
                disabled={busy}
                onChange={(e) =>
                  setDeliveryTask(
                    structuredClone(
                      state.config.tasks.find((t) => t.id === e.target.value) ??
                        null,
                    ),
                  )
                }
              >
                <option value="">选择巡检任务</option>
                {state.config.tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            {!state.config.tasks.length && (
              <Empty>请先在“巡检任务”创建任务，再配置投递渠道。</Empty>
            )}
            {deliveryTask && (
              <>
                <DeliverySettings
                  key={deliveryTask.id}
                  value={deliveryTask}
                  onChange={setDeliveryTask}
                  call={call}
                  im={state.im}
                  disabled={busy}
                />
                <div className="ops-actions" style={{ marginTop: 18 }}>
                  <Button
                    primary
                    disabled={busy}
                    onClick={async () => {
                      const updated = await act(
                        () =>
                          call("task.delivery.save", {
                            id: deliveryTask.id,
                            deliveryMode: deliveryTask.deliveryMode,
                            targets: deliveryTask.targets,
                            sendDataOnFailure: deliveryTask.sendDataOnFailure,
                          }),
                        "投递配置已保存，对此后新建的巡检批次生效",
                      );
                      if (updated) setDeliveryTask(updated);
                    }}
                  >
                    保存投递配置
                  </Button>
                  <small>
                    保存不会发送消息；已有报告保留生成时的接收目标。
                  </small>
                </div>
              </>
            )}
          </div>
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
                      <strong>{d.targetName || d.targetId}</strong>
                      <small>机器人：{d.botId}</small>
                      <small>批次：{d.runId}</small>
                    </td>
                    <td>
                      <Badge status={d.status} />
                      <small>{d.error}</small>
                    </td>
                    <td>{d.attempts}</td>
                    <td>
                      {!["accepted", "sending", "skipped"].includes(d.status) && (
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
      {tab === "storage" && (
        <section className="ops-section">
          <div className="ops-section-title">
            <div>
              <h2>告警与报告保存位置</h2>
              <p>自定义本地告警数据库目录，可使用 DSH 服务器上另一块已挂载磁盘。</p>
            </div>
          </div>
          <div className="ops-settings-body">
            <div className="ops-notice">
              <strong>当前数据库</strong>
              <code className="ops-path">
                {state.storage?.databasePath ?? "正在读取…"}
              </code>
              <small>
                持续采集的告警原文、采集进度、分析报告、任务设置和 IM 投递记录均保存在此
                SQLite 数据库；未配置巡检的告警源也会保存数据。
              </small>
            </div>
            <Field
              title="告警数据保存目录"
              hint="Ubuntu 示例：/data/dsh-ops-assistant。填写目录，不要填写数据库文件名；运行 DSH 的用户需要有读写权限。"
            >
              <input
                value={dataDir ?? state.storage?.dataDir ?? ""}
                placeholder="/data/dsh-ops-assistant"
                disabled={busy || !state.storage}
                onChange={(e) => setDataDir(e.target.value)}
              />
            </Field>
            <Button
              primary
              disabled={
                busy || !state.storage || !(dataDir ?? state.storage?.dataDir)
              }
              onClick={() =>
                act(async () => {
                  const result = await call("storage.save", {
                    dataDir: dataDir ?? state.storage.dataDir,
                  });
                  setDataDir(null);
                  return result;
                }, "数据目录已切换，现有记录已迁移；原数据库保留为迁移前副本，无需重启。")
              }
            >
              {busy ? "正在处理…" : "保存目录并迁移数据"}
            </Button>
            <p className="ops-footnote">
              迁移需等待当前采集、分析和投递完成。目标目录不能已有
              ops.sqlite；告警与采集进度会一同迁移。成功后新数据写入新目录，原目录保留迁移前副本，不再同步。
            </p>
            <p className="ops-footnote">
              目录指针保存在 <code>{state.storage?.settingsFile}</code>
              。已保存的目录在重启后继续使用；外置盘未挂载时不会悄悄创建空数据库。
            </p>
            <p className="ops-footnote">
              DSH 会话、工作目录文件、宿主日志和凭据仍由 DSH
              管理，不随本插件数据库迁移。Docker 部署时填写容器内已挂载的目录。
            </p>
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
                source.enabled ? "告警源已保存，后台持续采集已启用" : "告警源已保存，后台采集已停用",
              );
              if (v) setSource(null);
            }}
          >
            <div className="ops-section-title">
              <h2>{source.id ? "编辑" : "添加"}告警源</h2>
              <Button onClick={() => setSource(null)}>关闭</Button>
            </div>
            {error && (
              <div role="alert" className="ops-notice ops-error">
                {error}
              </div>
            )}
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
              title={source.type === "nightingale" ? "夜莺个人 Token" : "API Token"}
              hint={
                source.type === "nightingale"
                  ? "在夜莺个人信息 → Token 管理创建，并启用 HTTP.TokenAuth。编辑时留空保留原凭据；修改地址后须重新填写。"
                  : "编辑时留空保留原凭据；修改地址后须重新填写。"
              }
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
            {source.type === "nightingale" && (
              <p className="ops-footnote">
                启用后持续拉取告警并保存到本地，排除恢复记录；巡检仅查询本地告警，不判断当前恢复状态。
              </p>
            )}
            <Field
              title="后台采集间隔（秒）"
              hint="默认 60 秒，与巡检周期独立。启用后立即开始采集，不需要先创建巡检任务。"
            >
              <input
                required
                type="number"
                min="15"
                max="3600"
                step="1"
                value={source.pollIntervalSeconds ?? 60}
                onChange={(e) => setSource({ ...source, pollIntervalSeconds: Number(e.target.value) })}
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
            {error && (
              <div role="alert" className="ops-notice ops-error">
                {error}
              </div>
            )}
            <div className="ops-form-grid">
              <div>
                <Field title="任务名称">
                  <input
                    required
                    value={task.name}
                    onChange={(e) => setTaskField("name", e.target.value)}
                  />
                </Field>
                <Field title="巡检周期（分钟）" hint="例如 30 分钟：每次执行查询本地此前 30 分钟的告警。后台采集独立运行。">
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
                <Field title="本地查询与分析总超时（分钟）">
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
                <DeliverySettings
                  key={task.id ?? "new"}
                  value={task}
                  onChange={setTask}
                  call={call}
                  im={state.im}
                  disabled={busy}
                />
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
                report.run.alertCount > 0 &&
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
              {report.run.alertCount === 0 && (
                <small>本窗口未查询到告警，仅保存在本地，不推送 IM。</small>
              )}
            </div>
            <pre className="ops-report">{report.markdown}</pre>
            <details>
              <summary>分析会话 ID（可在 DSH 中追踪）</summary>
              <pre>{report.run.sessions.join("\n") || "暂无"}</pre>
            </details>
            <details>
              <summary>AI 原始回复与格式修正（{report.run.analysisOutputs?.length ?? 0}）</summary>
              {report.run.analysisOutputs?.length ? (
                <>
                  <Button onClick={() => download(
                    JSON.stringify(report.run.analysisOutputs, null, 2),
                    `AI回复-${report.run.id}.json`, "application/json",
                  )}>导出全部回复</Button>
                  {report.run.analysisOutputs.map((output, index) => (
                    <details key={index}>
                      <summary>
                        第 {output.version} 版 · {output.stage} · {output.kind === "format-repair" ? "格式修正" : "原始分析"}
                        {" · "}{output.error ? "校验未通过" : "校验通过"}
                      </summary>
                      {output.sessionId && <p>会话：{output.sessionId}</p>}
                      {output.error && <p>{output.error}</p>}
                      <pre className="ops-raw">{output.text}</pre>
                    </details>
                  ))}
                </>
              ) : <p>尚无已保存的完整回复；旧报告可按会话 ID 在 DSH 中查看。</p>}
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
