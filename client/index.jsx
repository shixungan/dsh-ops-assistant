import React, { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_INSTRUCTIONS } from "../src/analysis.mjs";
import { coverageWarnings } from "../src/coverage.mjs";
import { QUERY_PLANS } from "../src/query-plan.mjs";
import { CSS } from "./styles.js";
import { DeliverySettings } from "./delivery-settings.jsx";
import { DictionarySettings, DictionaryBindings, DictionaryEvidence } from "./dictionary-settings.jsx";
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
  config: { sources: [], tasks: [], queryPlans: [], mcpDictionary: [] },
  runs: [],
  deliveries: [],
  pollStatus: {},
};
const planNames = Object.fromEntries(QUERY_PLANS.map((plan) => [plan.id, plan.name]));
const freshQueryPlan = () => ({
  id: "network-ping", version: 1, instructions: "",
  bindings: { postgres: "", neo4j: "", knowledge: "", memory: "" },
  dictionaryIds: [],
  assetCacheSeconds: 300, queryTimeoutSeconds: 15, maxSupplementaryCalls: 2,
});
const editQueryPlan = (value) => {
  const plan = { ...freshQueryPlan(), ...value, bindings: { ...freshQueryPlan().bindings, ...value?.bindings } };
  if (value && !Object.hasOwn(value, "dictionaryIds")) delete plan.dictionaryIds;
  return plan;
};
const duration = (ms) => Number.isFinite(ms)
  ? (ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`) : "—";
const freshTask = () => ({
  name: "每 30 分钟告警巡检",
  sourceIds: [],
  intervalMinutes: 30,
  timeoutMinutes: 15,
  maxBatchChars: 20000,
  workspace: "/opt/dsh-ops-assistant",
  agentPreset: "",
  instructions: DEFAULT_INSTRUCTIONS,
  queryPlanId: "",
  enabled: false,
  deliveryMode: "off",
  targets: [],
  sendDataOnFailure: true,
});

function QueryPlanSettings({ value, onChange, tools, dictionary }) {
  const plan = editQueryPlan(value);
  const set = (key, next) => onChange({ ...plan, [key]: next });
  const roles = [
    ["postgres", "资产与窗口事件", "PostgreSQL：批量归一 IP，并查询相关设备的窗口事件。"],
    ["neo4j", "网络拓扑", "Neo4j：资产归一后查询交换机间的有界候选路径。"],
    ["knowledge", "错误码说明", "WeKnora：仅在原告警含具体错误码且需要解释时补查。"],
    ["memory", "已确认历史经验", "MemOS：仅补查本批次相关资产的历史经验，不能替代本次证据。"],
  ];
  return (
    <section aria-label="查询方案">
      <div className="ops-section-title">
        <div><h3>取证流程与参数</h3><p>先按方案取证，再交给 AI 分析。可供多个巡检任务共用。</p></div>
      </div>
      <Field title="方案类型">
        <select value={plan.id} onChange={(e) => set("id", e.target.value)}>
          {Object.entries(planNames).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </Field>
      <div className="ops-notice">
        {Object.hasOwn(plan, "dictionaryIds") ? "AI 根据所选字典的查询说明和本批告警决定补查；仅使用条目中已配置的参数，不扩展到其他 MCP。" : plan.id === "network-ping"
          ? "批量查询源/目的 IP → 归一接入交换机 → 定位候选路径 → 查询窗口事件。普通 ping 不自动检索厂商手册。"
          : "优先整理原始告警及可识别资产；不把非网络告警套进 ping 路径分析。"}
        <small>无法确认资产、路径或数据覆盖时保留证据缺口。当前拓扑不直接证明历史窗口内的实际流量路径。</small>
      </div>
      <details><summary>查看内置排查步骤</summary>
        <pre className="ops-report">{QUERY_PLANS.find((item) => item.id === plan.id)?.instructions}</pre>
      </details>
      <DictionaryBindings plan={plan} entries={dictionary}
        onChange={(next) => { const { dictionaryBindings, ...rest } = plan; onChange({ ...rest, dictionaryIds: next }); }} />
      {!Object.hasOwn(plan, "dictionaryIds") && <details><summary>旧版自动取证的 MCP 绑定</summary><small>当前方案未更改字典选择，保留旧版行为。改选字典后，仅查询所选条目。</small>
      <div className="ops-form-grid">
        {roles.map(([role, title, hint]) => {
          const candidates = tools.filter((tool) => tool.roles?.includes(role));
          const selected = plan.bindings[role];
          return (
            <Field key={role} title={title} hint={hint}>
              <select value={selected} onChange={(e) => set("bindings", { ...plan.bindings, [role]: e.target.value })}>
                <option value="">自动识别现有 MCP</option>
                {!!selected && !candidates.some((tool) => tool.name === selected) &&
                  <option value={selected}>{selected}（当前不可用）</option>}
                {candidates.map((tool) => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
              </select>
            </Field>
          );
        })}
      </div>
      <small>同优先级只有唯一匹配时才自动使用；缺失或不唯一会在报告中标明。</small></details>}
      <div className="ops-form-grid">
        <Field title="单次查询超时（秒）" hint="慢查询返回明确缺口，其他已完成的证据继续参与分析。">
          <input type="number" min="1" max="60" value={plan.queryTimeoutSeconds}
            onChange={(e) => set("queryTimeoutSeconds", Number(e.target.value))} />
        </Field>
        <Field title="资产映射缓存（秒）" hint="0 表示关闭跨轮缓存。仅复用短期资产映射；窗口事件与故障结论不跨轮复用。">
          <input type="number" min="0" max="3600" value={plan.assetCacheSeconds}
            onChange={(e) => set("assetCacheSeconds", Number(e.target.value))} />
        </Field>
        <Field title="AI 额外补查上限" hint="原生 MCP 和文档/记忆查询共用此预算；0 表示只分析原文与已取证据。">
          <input type="number" min="0" max="6" value={plan.maxSupplementaryCalls}
            onChange={(e) => set("maxSupplementaryCalls", Number(e.target.value))} />
        </Field>
      </div>
      <Field title="方案补充说明（Markdown）" hint="填写哪些情况继续查询、何时停止和判定习惯；留空采用内置流程。说明随方案保存并注入使用该方案的分析，不会自动扩大查询范围。">
        <textarea rows="7" maxLength={12000} value={plan.instructions}
          placeholder="例如：只核对告警路径上的交换机；无端口事件时保留未知，不扩展无关设备；历史经验只用于提出待验证假设。"
          onChange={(e) => set("instructions", e.target.value)} />
      </Field>
    </section>
  );
}

function QueryEvidence({ value, runId, onDownload }) {
  if (!value) return <p className="ops-footnote">此报告没有查询方案执行记录。零告警会跳过查询，旧报告保持原样。</p>;
  const queries = value.queries ?? [];
  const statusLabels = { ok: "成功", failed: "失败", timeout: "超时", skipped: "跳过", unavailable: "不可用", cached: "缓存命中", partial: "部分结果" };
  return (
    <details open>
      <summary>查询方案与耗时 · {value.plan?.name ?? planNames[value.plan?.id] ?? value.plan?.id ?? "—"} · v{value.plan?.version ?? 1}</summary>
      <div className="ops-actions">
        <small>取证耗时 {duration(value.elapsedMs)} · {queries.length} 条查询记录 · 缓存命中 {queries.filter((q) => q.cacheHit).length} 次</small>
        <Button onClick={() => onDownload(JSON.stringify(value, null, 2), `查询证据-${runId}.json`, "application/json")}>导出查询证据</Button>
      </div>
      <DictionaryEvidence value={value.dictionary} />
      {queries.length ? <div className="ops-table-wrap"><table>
        <thead><tr><th>查询用途 / 工具</th><th>状态</th><th>耗时</th><th>返回条数 / 大小</th><th>说明</th></tr></thead>
        <tbody>{queries.map((query, index) => <tr key={`${query.id ?? "query"}-${index}`}>
          <td><strong>{query.purpose ?? query.id}</strong><small>{query.tool || "未匹配到工具"}</small></td>
          <td><Badge status={query.status}>{query.cacheHit ? "缓存命中" : statusLabels[query.status] ?? query.status}</Badge></td>
          <td>{duration(query.elapsedMs)}</td><td>{query.rowCount ?? "—"}<small>{Number.isFinite(query.resultBytes) ? `${(query.resultBytes / 1024).toFixed(1)} KB` : ""}</small></td>
          <td>{query.note || query.error || "—"}</td>
        </tr>)}</tbody>
      </table></div> : <p>本轮没有执行补充查询。</p>}
      {(value.evidence ?? []).some((item) => item.note) && <details>
        <summary>证据范围与缺口说明</summary>
        <ul>{value.evidence.filter((item) => item.note).map((item, index) =>
          <li key={`${item.id}-${index}`}><strong>{item.purpose ?? item.id}：</strong>{item.note}</li>)}</ul>
      </details>}
      <small>取证与 AI 回复耗时分别记录；AI 回复阶段的时间包含其额外补查和模型处理，不能当作纯模型推理耗时。</small>
    </details>
  );
}

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

const deletionReason = (run) => run.deleteBlockedReason ||
  (["queued", "collecting", "analyzing"].includes(run.status)
    ? "记录正在执行，请先取消并等待结束" : null);

function SelectionCheckbox({ partial = false, ...props }) {
  const input = useRef(null);
  useEffect(() => {
    input.current.indeterminate = partial;
  }, [partial]);
  return <input ref={input} type="checkbox" aria-checked={partial ? "mixed" : props.checked} {...props} />;
}

function DeleteRunsDialog({ rows, busy, error, blocked, onCancel, onConfirm }) {
  const dialog = useRef(null);
  const titleId = React.useId();
  const descriptionId = React.useId();
  useEffect(() => {
    dialog.current.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="ops-dialog ops-delete-dialog"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id={titleId}>删除 {rows.length} 条巡检记录？</h2>
      <div id={descriptionId} className="ops-delete-description">
        <p>将永久删除这些巡检记录、报告、原始告警快照、AI 回复及关联的本地 IM 投递记录，删除后无法恢复。</p>
        <p>巡检任务配置、持续采集的告警库和 DSH 分析会话会保留。已发送的消息不会撤回，尚待投递的消息将停止投递。</p>
      </div>
      <ul className="ops-delete-items">
        {rows.map((run) => (
          <li key={run.id}>
            <strong>{run.task.name}</strong>
            <small>{time(run.start)} → {time(run.end)}</small>
            <small>{run.id}</small>
          </li>
        ))}
      </ul>
      {(error || blocked) && <div role="alert" className="ops-notice ops-error">{error || blocked}</div>}
      <div className="ops-actions ops-delete-actions">
        <Button autoFocus disabled={busy} onClick={onCancel}>取消</Button>
        <Button danger disabled={busy || !!blocked} onClick={onConfirm}>
          {busy ? "正在删除…" : `确认删除 ${rows.length} 条`}
        </Button>
      </div>
    </dialog>
  );
}

function DeleteQueryPlanDialog({ plan, references, busy, error, onCancel, onConfirm }) {
  const dialog = useRef(null);
  const titleId = React.useId();
  useEffect(() => { dialog.current.showModal(); }, []);
  return (
    <dialog ref={dialog} className="ops-dialog ops-delete-dialog" role="alertdialog"
      aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
      <h2 id={titleId}>删除查询方案“{plan.name}”？</h2>
      <div className="ops-delete-description">
        <p>将删除方案定义，无法直接恢复。排队、执行中的巡检和旧报告保留各自的方案快照。</p>
        <p>修订 {plan.revision} · 当前被 {references.length} 个任务引用</p>
      </div>
      {references.length > 0 && <div className="ops-notice ops-error">
        请先为这些任务更换方案：{references.map((item) => item.name).join("、")}
      </div>}
      {error && <div role="alert" className="ops-notice ops-error">{error}</div>}
      <div className="ops-actions ops-delete-actions">
        <Button autoFocus disabled={busy} onClick={onCancel}>取消</Button>
        <Button danger disabled={busy || references.length > 0} onClick={onConfirm}>
          {busy ? "正在删除…" : "确认删除方案"}
        </Button>
      </div>
    </dialog>
  );
}

export function OpsPanel({ call }) {
  const [state, setState] = useState(empty);
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState(null);
  const [task, setTask] = useState(null);
  const [planDraft, setPlanDraft] = useState(null);
  const [planDeletion, setPlanDeletion] = useState(null);
  const [planDeleteError, setPlanDeleteError] = useState("");
  const planDeleting = useRef(false);
  const [deliveryTask, setDeliveryTask] = useState(null);
  const [dataDir, setDataDir] = useState(null);
  const [tools, setTools] = useState([]);
  const [report, setReport] = useState(null);
  const [raw, setRaw] = useState(null);
  const [selectedRunIds, setSelectedRunIds] = useState([]);
  const [deletion, setDeletion] = useState(null);
  const [deleteError, setDeleteError] = useState("");
  const deleting = useRef(false);
  // Ignore a poll that began before a successful deletion, so it cannot put
  // deleted records back into the list while the following refresh runs.
  const stateEpoch = useRef(0);
  const refresh = useCallback(
    async () => {
      const epoch = stateEpoch.current;
      const value = await call("state", {});
      if (epoch === stateEpoch.current) setState(value);
    },
    [call],
  );
  useEffect(() => {
    let active = true;
    const load = () => {
      const epoch = stateEpoch.current;
      call("state", {})
        .then((v) => {
          if (active && epoch === stateEpoch.current) setState(v);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [call]);
  useEffect(() => {
    const eligible = new Set(state.runs.filter((run) => !deletionReason(run)).map((run) => run.id));
    setSelectedRunIds((ids) => {
      const remaining = ids.filter((id) => eligible.has(id));
      return remaining.length === ids.length ? ids : remaining;
    });
  }, [state.runs]);
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
  function editTask(value) {
    const { allowedTools: _legacyTools, maxToolCalls: _legacyBudget, queryPlan: _legacyPlan, queryPlanRef: _snapshot, ...next } = structuredClone(value ?? freshTask());
    setTask({ ...next, queryPlanId: next.queryPlanId ?? "" });
  }
  async function editPlan(value, copy = false) {
    const available = await call("tools.list", {});
    setTools(available);
    setPlanDraft(value ? {
      ...(copy ? {} : { id: value.id, revision: value.revision }),
      name: copy ? `${value.name}（副本）` : value.name,
      config: editQueryPlan(structuredClone(value.config)),
    } : { name: "", config: freshQueryPlan() });
  }
  async function confirmPlanDeletion() {
    if (busy || planDeleting.current || !planDeletion || planReferences(planDeletion.id).length) return;
    planDeleting.current = true;
    setBusy(true); setPlanDeleteError(""); setError(""); setNotice("");
    try {
      await call("queryPlan.delete", { id: planDeletion.id, revision: planDeletion.revision });
      stateEpoch.current++;
      setState((value) => ({ ...value, config: { ...value.config,
        queryPlans: (value.config.queryPlans ?? []).filter((item) => item.id !== planDeletion.id),
      } }));
      setPlanDeletion(null); setNotice("查询方案已删除");
      try { await refresh(); } catch (e) { setError(`删除已成功，但刷新列表失败：${e.message}`); }
    } catch (e) { setPlanDeleteError(e.message); }
    finally { planDeleting.current = false; setBusy(false); }
  }
  const queryPlans = state.config.queryPlans ?? [];
  const planReferences = (id) => state.config.tasks.filter((item) => item.queryPlanId === id);
  const selectedPlan = task ? queryPlans.find((item) => item.id === task.queryPlanId) : null;
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
  function requestDeletion(rows) {
    if (busy || !rows.length) return;
    setDeleteError("");
    setDeletion(rows);
  }
  const deleteBlocked = deletion?.map((row) => {
    const current = state.runs.find((run) => run.id === row.id);
    return current ? deletionReason(current) : "所选记录已不在当前列表中，请取消后刷新并重新选择";
  }).find(Boolean);
  async function confirmDeletion() {
    if (busy || deleting.current || !deletion?.length || deleteBlocked) return;
    deleting.current = true;
    setBusy(true);
    setDeleteError("");
    setError("");
    setNotice("");
    try {
      const ids = deletion.map((run) => run.id);
      const result = await call(ids.length === 1 ? "run.delete" : "run.deleteMany",
        ids.length === 1 ? { id: ids[0] } : { ids });
      const removed = new Set(result.deletedIds);
      stateEpoch.current++;
      setState((value) => ({
        ...value,
        runs: value.runs.filter((run) => !removed.has(run.id)),
        deliveries: value.deliveries.filter((row) => !removed.has(row.runId)),
      }));
      setSelectedRunIds((current) => current.filter((id) => !removed.has(id)));
      if (report && removed.has(report.run.id)) {
        setReport(null);
        setRaw(null);
      }
      setDeletion(null);
      setNotice(`已删除 ${result.deletedCount} 条巡检记录及关联的本地报告、投递记录`);
      try {
        await refresh();
      } catch (e) {
        setError(`删除已成功，但刷新列表失败：${e.message}`);
      }
    } catch (e) {
      setDeleteError(e.message);
    } finally {
      deleting.current = false;
      setBusy(false);
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
  const showRuns = (rows, selectable = false) => {
    const eligible = rows.filter((run) => !deletionReason(run));
    const selected = eligible.filter((run) => selectedRunIds.includes(run.id));
    return (
    <div>
      {selectable && (
        <div className="ops-run-selection">
          <div>
            <strong>已选 {selected.length} 条</strong>
            <small>当前列表显示最近 {rows.length} 条；全选仅选择当前列表中可删除的记录。</small>
          </div>
          <div className="ops-actions">
            <Button disabled={busy || !selected.length} onClick={() => setSelectedRunIds([])}>清空选择</Button>
            <Button danger disabled={busy || !selected.length} onClick={() => requestDeletion(selected)}>
              批量删除{selected.length ? `（${selected.length}）` : ""}
            </Button>
          </div>
        </div>
      )}
      <div className="ops-table-wrap">
      <table>
        <thead>
          <tr>
            {selectable && (
              <th className="ops-selection-cell">
                <SelectionCheckbox
                  aria-label="全选当前列表中可删除的巡检记录"
                  checked={eligible.length > 0 && selected.length === eligible.length}
                  partial={selected.length > 0 && selected.length < eligible.length}
                  disabled={busy || !eligible.length}
                  onChange={(event) => setSelectedRunIds(event.target.checked ? eligible.map((run) => run.id) : [])}
                />
              </th>
            )}
            <th>巡检任务 / 时间窗</th>
            <th>告警</th>
            <th>分析状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((run) => (
            <tr key={run.id}>
              {selectable && (
                <td className="ops-selection-cell">
                  <input
                    type="checkbox"
                    aria-label={`选择巡检记录：${run.task.name}，${run.id}`}
                    title={deletionReason(run) ?? undefined}
                    checked={!deletionReason(run) && selectedRunIds.includes(run.id)}
                    disabled={busy || !!deletionReason(run)}
                    onChange={(event) => setSelectedRunIds((ids) => event.target.checked
                      ? [...new Set([...ids, run.id])] : ids.filter((id) => id !== run.id))}
                  />
                </td>
              )}
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
                  <Button disabled={busy} onClick={() => openReport(run.id)}>查看报告</Button>
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
                  <Button
                    danger
                    disabled={busy || !!deletionReason(run)}
                    title={deletionReason(run) ?? undefined}
                    onClick={() => requestDeletion([run])}
                  >删除</Button>
                </div>
                {deletionReason(run) && <small className="ops-delete-blocked">{deletionReason(run)}</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <Empty>尚无巡检记录。先添加告警源和任务，再运行一次。</Empty>
      )}
      </div>
    </div>
    );
  };

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
          ["dictionary", "MCP 数据字典"],
          ["plans", "查询方案"],
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
      {tab === "plans" && (
        <section className="ops-section">
          <div className="ops-section-title">
            <div><h2>查询方案</h2><p>集中维护取证步骤、MCP 用途和查询参数，巡检任务选择已有方案。</p></div>
            <Button primary disabled={busy} onClick={() => act(() => editPlan())}>新建方案</Button>
          </div>
          {task && <div className="ops-plan-return ops-actions">
            <span>巡检任务草稿已保留，维护方案后可继续配置。</span>
            <Button onClick={() => setTab("tasks")}>返回任务草稿</Button>
          </div>}
          {queryPlans.map((plan) => {
            const references = planReferences(plan.id);
            return <article className="ops-task-card ops-plan-card" key={plan.id}>
              <div>
                <div className="ops-card-top"><h3>{plan.name}</h3><Badge status="ok">修订 {plan.revision}</Badge></div>
                <p>{planNames[plan.config.id] ?? plan.config.id} · 查询超时 {plan.config.queryTimeoutSeconds} 秒 · 资产缓存 {plan.config.assetCacheSeconds} 秒 · 补查 {plan.config.maxSupplementaryCalls} 次</p>
                <small>被 {references.length} 个任务引用{references.length ? `：${references.map((item) => item.name).join("、")}` : "，可删除"}</small>
                <small>更新于 {time(plan.updatedAt)}；修改用于后续新批次，已排队和已有报告保留快照。</small>
              </div>
              <div className="ops-actions">
                <Button disabled={busy} onClick={() => act(() => editPlan(plan))}>编辑方案</Button>
                <Button disabled={busy} onClick={() => act(() => editPlan(plan, true))}>复制</Button>
                <Button danger disabled={busy || references.length > 0}
                  title={references.length ? "方案被任务引用，请先为引用任务更换方案" : "删除未被任务引用的方案"}
                  onClick={() => { setPlanDeleteError(""); setPlanDeletion(plan); }}>删除方案</Button>
              </div>
            </article>;
          })}
          {!queryPlans.length && <Empty>先新建一个查询方案，再在巡检任务中选择它。</Empty>}
        </section>
      )}
      {tab === "dictionary" && <DictionarySettings entries={state.config.mcpDictionary ?? []}
        plans={queryPlans} call={call} workspace={state.config.tasks[0]?.workspace}
        onChanged={async () => { stateEpoch.current++; await refresh(); }} />}
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
                  查询方案：{queryPlans.find((plan) => plan.id === t.queryPlanId)?.name ?? "方案不可用，请重新选择"}
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
          {showRuns(state.runs, true)}
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
      {planDraft && (
        <div className="ops-overlay">
          <form className="ops-dialog ops-wide" aria-label={planDraft.id ? "编辑查询方案" : "新建查询方案"}
            onSubmit={async (e) => {
              e.preventDefault();
              const value = await act(async () => {
                const result = await call("queryPlan.save", planDraft);
                stateEpoch.current++;
                return result;
              }, "查询方案已保存，后续新批次将使用本次配置");
              if (value) setPlanDraft(null);
            }}>
            <div className="ops-section-title">
              <div><h2>{planDraft.id ? "编辑" : "新建"}查询方案</h2>
                <p>{planDraft.id ? `当前修订 ${planDraft.revision}` : "填写名称，检查取证配置后保存。"}</p></div>
              <Button disabled={busy} onClick={() => setPlanDraft(null)}>关闭</Button>
            </div>
            {error && <div role="alert" className="ops-notice ops-error">{error}</div>}
            <Field title="方案名称"><input required maxLength={200} value={planDraft.name}
              onChange={(e) => setPlanDraft((value) => ({ ...value, name: e.target.value }))} /></Field>
            {planDraft.id && <div className="ops-notice">
              被 {planReferences(planDraft.id).length} 个任务引用{planReferences(planDraft.id).length
                ? `：${planReferences(planDraft.id).map((item) => item.name).join("、")}` : ""}。
              <small>保存后影响这些任务的后续新批次；排队、执行中的巡检和旧报告保留各自快照。</small>
            </div>}
            <QueryPlanSettings value={planDraft.config} tools={tools} dictionary={state.config.mcpDictionary ?? []}
              onChange={(config) => setPlanDraft((value) => ({ ...value, config }))} />
            <div className="ops-sticky-footer"><button className="ops-button ops-primary" disabled={busy}>保存方案</button></div>
          </form>
        </div>
      )}
      {task && tab === "tasks" && (
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
                  hint="超量自动分批，在同一分析会话内完成；单条原文超限会报错，不会静默截断。"
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
            <Field title="选择查询方案" hint="任务只保存方案引用；每次加入队列时固定当时的方案修订。">
              <select required value={task.queryPlanId} onChange={(e) => setTaskField("queryPlanId", e.target.value)}>
                <option value="">请选择查询方案</option>
                {!!task.queryPlanId && !selectedPlan && <option value={task.queryPlanId}>原方案当前不可用，请重新选择</option>}
                {queryPlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · 修订 {plan.revision}</option>)}
              </select>
            </Field>
            {selectedPlan ? <div className="ops-notice">
              {planNames[selectedPlan.config.id] ?? selectedPlan.config.id} · 查询超时 {selectedPlan.config.queryTimeoutSeconds} 秒 · 资产缓存 {selectedPlan.config.assetCacheSeconds} 秒 · 补查 {selectedPlan.config.maxSupplementaryCalls} 次
              <small>工具绑定与取证步骤在“查询方案”页统一维护。</small>
            </div> : <p className="ops-footnote">请先选择一个可用方案；没有合适的方案时，可前往管理页新建或复制。</p>}
            <div className="ops-actions ops-plan-link"><Button onClick={() => setTab("plans")}>管理查询方案</Button><small>当前任务草稿会保留。</small></div>
            <Field title="报告补充要求（Markdown）" hint="补充业务背景、结论格式或人工判定习惯；取证步骤在独立的查询方案页维护。">
              <textarea
                rows="8"
                value={task.instructions}
                onChange={(e) => setTaskField("instructions", e.target.value)}
              />
            </Field>
            <div className="ops-sticky-footer">
              <button className="ops-button ops-primary" disabled={busy || !selectedPlan}>
                保存任务
              </button>
            </div>
          </form>
        </div>
      )}
      {deletion && (
        <DeleteRunsDialog
          rows={deletion}
          busy={busy}
          error={deleteError}
          blocked={deleteBlocked}
          onCancel={() => setDeletion(null)}
          onConfirm={confirmDeletion}
        />
      )}
      {planDeletion && <DeleteQueryPlanDialog plan={planDeletion} references={planReferences(planDeletion.id)}
        busy={busy} error={planDeleteError} onCancel={() => setPlanDeletion(null)} onConfirm={confirmPlanDeletion} />}
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
            {report.run.task.queryPlanRef && <div className="ops-notice">
              本次查询方案：<strong>{report.run.task.queryPlanRef.name}</strong> · 修订 {report.run.task.queryPlanRef.revision}
              <small>这是加入队列时保存的方案快照，不随方案库后续修改而变化。</small>
            </div>}
            <QueryEvidence value={report.run.queryEvidence} runId={report.run.id} onDownload={download} />
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
                        第 {output.version} 版 · {output.stage} · {output.kind === "local-format-repair" ? "本地格式修正（未调用 AI）" : output.kind === "format-repair" ? "AI 格式修正（旧版本）" : "原始分析"}
                        {" · "}{output.error ? "校验未通过" : "校验通过"}
                        {Number.isFinite(output.elapsedMs) && ` · 耗时 ${output.elapsedMs < 1000 ? `${output.elapsedMs} 毫秒` : `${Math.round(output.elapsedMs / 1000)} 秒`}`}
                      </summary>
                      {output.sessionId && <p>会话：{output.sessionId}</p>}
                      {Number.isInteger(output.toolCalls) && <p>本轮累计补查：{output.toolCalls} 次</p>}
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
