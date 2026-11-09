import { collectSource, collectAlertmanager, pollAlertmanager } from "./collectors.mjs";

const INITIAL_WINDOW = 30 * 60000;
const OVERLAP = 2 * 60000;
const revision = (source) => source.revision ?? 0;
const observationSource = (source) => ({
  ...source,
  id: revision(source) ? `${source.id}@${revision(source)}` : source.id,
});

export function ensureIngestion(source, store, now) {
  let state = store.ingestionState(source.id);
  if (!state || state.sourceRevision !== revision(source)) {
    const start = Math.max(0, Math.floor(now / 1000) * 1000 - INITIAL_WINDOW);
    state = {
      sourceRevision: revision(source),
      coverageStart: start,
      coveredUntil: start,
      status: "pending",
      note: "等待后台采集；首次读取最近 30 分钟",
      at: null,
      successAt: null,
    };
    store.putIngestionState(source.id, state);
  }
  return state;
}

export async function ingestSource(source, store, options, now, isCurrent = () => true) {
  options.signal?.throwIfAborted();
  if (!isCurrent()) return;
  const state = ensureIngestion(source, store, now);
  const at = Math.floor(now / 1000) * 1000;
  // Catch up in bounded windows. Never skip an incomplete window on retry.
  const end = Math.min(at, state.coveredUntil + INITIAL_WINDOW);
  const start = Math.max(state.coverageStart, state.coveredUntil - OVERLAP);
  const current = () => {
    options.signal?.throwIfAborted();
    return isCurrent();
  };
  try {
    if (source.type === "alertmanager") {
      const localSource = observationSource(source);
      // Stage observations so a source edited/disabled during HTTP cannot write stale data.
      const pending = [];
      await pollAlertmanager(localSource, {
        observations: (id) => store.observations(id),
        observe: (...args) => pending.push(args),
      }, options, at);
      if (!current()) return;
      for (const args of pending) store.observe(...args);
      store.putIngestionState(source.id, {
        ...state, status: "ok", at, successAt: at, coveredUntil: at,
        note: "后台快照已保存；Alertmanager 不保证轮询间隔内的完整事件历史",
      });
      return;
    }
    if (end <= start) return;
    const result = await collectSource(source, start, end, store, options);
    if (!current()) return;
    const alerts = result.alerts.map((alert) => ({
      ...alert,
      alertId: revision(source)
        ? `${source.id}:${revision(source)}:${alert.nativeId}`
        : alert.alertId,
      sourceRevision: revision(source),
      eventTime: alert.eventTime ?? alert.first,
    }));
    store.commitIngestion(source.id, alerts, {
      ...state,
      status: result.status,
      at,
      note: result.note,
      ...(result.status === "ok" ? { coveredUntil: end, successAt: at } : {}),
    });
  } catch (error) {
    if (isCurrent()) store.putIngestionState(source.id, {
      ...state, status: "failed", at,
      note: `后台采集失败：${error.message}；保留采集进度，下次重试`,
    });
  }
}

export function localSourceInfo(source, store) {
  const saved = store.ingestionState(source.id);
  const state = saved?.sourceRevision === revision(source) ? saved : null;
  return {
    ...state,
    status: state?.status ?? "pending",
    ok: state?.status === "ok",
    count: source.type === "alertmanager"
      ? store.observations(observationSource(source).id).length
      : store.ingestionInfo(source.id).count,
  };
}

export function collectLocalSource(source, start, end, store) {
  if (source.type === "alertmanager") {
    const result = collectAlertmanager(observationSource(source), start, end, store);
    result.alerts = result.alerts.map((alert) => ({ ...alert, sourceId: source.id }));
    result.coverage = { kind: "snapshot" };
    return result;
  }
  const state = store.ingestionState(source.id);
  const alerts = store.alerts(source.id, start, end)
    .filter((alert) => (alert.sourceRevision ?? 0) === revision(source))
    .map((alert) => source.type === "zabbix"
      ? { ...alert, phase: "窗口内问题事件（恢复信息截至后台最近采集）" }
      : alert);
  const covered = state?.sourceRevision === revision(source) &&
    state.coverageStart <= start && state.coveredUntil >= end;
  const current = state?.sourceRevision === revision(source) ? state : null;
  const coverage = {
    kind: covered ? "complete"
      : current?.status === "failed" ? "failed"
      : current?.status === "partial" ? "partial"
      : current?.successAt == null ? "initial" : "gap",
    coveredFrom: current?.coverageStart ?? null,
    coveredUntil: current?.successAt != null ? current.coveredUntil : null,
    missingHeadSeconds: current?.successAt != null
      ? Math.max(0, Math.ceil((Math.min(end, current.coverageStart) - start) / 1000)) : null,
    missingTailSeconds: current?.successAt != null
      ? Math.max(0, Math.ceil((end - Math.max(start, current.coveredUntil)) / 1000)) : null,
  };
  const coverageNote = state?.sourceRevision === revision(source) && state.successAt != null
    ? `已采集至 ${new Date(state.coveredUntil).toISOString()}，窗口末尾尚差 ${Math.max(0, Math.ceil((end - state.coveredUntil) / 1000))} 秒；首次覆盖从 ${new Date(state.coverageStart).toISOString()} 开始。`
    : "此来源尚无已完成的采集窗口。";
  return {
    alerts,
    status: covered ? "ok" : "partial",
    coverage,
    note: covered
      ? "从本地告警库按事件时间读取本次窗口；范围受上游保留期及账号权限约束"
      : `从本地告警库读取；后台采集尚未覆盖完整窗口。${coverageNote}${state?.note ?? "尚未开始采集"}`,
  };
}
