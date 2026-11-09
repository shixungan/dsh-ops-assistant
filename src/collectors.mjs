import { createHash } from "node:crypto";

const hash = (raw) =>
  createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 20);
const sec = (v) => (Number.isFinite(Number(v)) ? Number(v) * 1000 : null);
const when = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const overlaps = (first, last, start, end) =>
  first !== null && first < end && (last === null || last >= start);
const phase = (first, last, start, end) =>
  last !== null && last >= start && last < end
    ? first >= start
      ? "窗口内触发并恢复"
      : "窗口内恢复"
    : first >= start
      ? "窗口内新增"
      : "持续告警";

export async function requestJson(
  url,
  { token, authMode = "bearer", signal, body, fetcher = fetch } = {},
) {
  const response = await fetcher(url, {
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(30000),
    ]),
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token
        ? authMode === "user-token"
          ? { "X-User-Token": token }
          : { Authorization: `Bearer ${token}` }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`监控接口 HTTP ${response.status}`);
  // Bound one response independently of the collector's pagination budget.
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error("单次接口响应超过 16 MiB");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function collectZabbix(source, start, end, options) {
  const events = [];
  let cursor = "0";
  let partial = false;
  const rpc = async (method, params) => {
    const data = await requestJson(source.url, {
      ...options,
      token: source.authMode === "body" ? undefined : options.token,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
        ...(source.authMode === "body" ? { auth: options.token } : {}),
      },
    });
    if (data.error)
      throw new Error(
        `Zabbix ${method} 返回错误 ${data.error.code}；请检查权限和接口版本`,
      );
    if (!Array.isArray(data.result)) throw new Error("Zabbix 响应格式不符");
    return data.result;
  };
  for (let p = 0; p < 100; p++) {
    options.signal?.throwIfAborted();
    const rows = await rpc("event.get", {
      output: "extend",
      source: 0,
      object: 0,
      value: 1,
      problem_time_from: Math.floor(start / 1000),
      problem_time_till: Math.ceil(end / 1000) - 1,
      selectTags: "extend",
      sortfield: "eventid",
      sortorder: "ASC",
      eventid_from: cursor,
      limit: 500,
    });
    events.push(...rows);
    if (rows.length < 500) break;
    const next = (BigInt(rows.at(-1).eventid) + 1n).toString();
    if (BigInt(next) <= BigInt(cursor))
      throw new Error("Zabbix 分页游标未前进");
    cursor = next;
    if (p === 99) partial = true;
  }
  const recovery = new Map();
  const ids = [
    ...new Set(events.map((e) => e.r_eventid).filter((id) => id && id !== "0")),
  ];
  for (let i = 0; i < ids.length; i += 500)
    for (const r of await rpc("event.get", {
      output: "extend",
      eventids: ids.slice(i, i + 500),
    }))
      recovery.set(r.eventid, r);
  const alerts = events
    .map((raw) => {
      const restored = recovery.get(raw.r_eventid);
      const first = sec(raw.clock);
      const last = restored ? sec(restored.clock) : null;
      return {
        alertId: `${source.id}:${raw.eventid}`,
        sourceId: source.id,
        sourceName: source.name,
        sourceType: source.type,
        nativeId: String(raw.eventid),
        title: raw.name ?? `Trigger ${raw.objectid}`,
        host:
          raw.tags?.find((t) =>
            ["host", "hostname", "instance"].includes(t.tag),
          )?.value ?? `trigger:${raw.objectid}`,
        severity: String(raw.severity),
        first,
        last,
        phase: phase(first, last, start, end),
        raw,
        ...(restored ? { recoveryRaw: restored } : {}),
      };
    })
    .filter((a) => overlaps(a.first, a.last, start, end));
  const missingRecovery = events.some(
    (e) => e.r_eventid && e.r_eventid !== "0" && !recovery.has(e.r_eventid),
  );
  return {
    alerts,
    status: partial || missingRecovery ? "partial" : "ok",
    note: partial
      ? "达到 50,000 条上限，结果不完整"
      : missingRecovery
        ? "部分恢复事件无法读取，恢复时间未知"
        : "按问题与时间窗相交查询；范围受平台保留期和 API 账号权限约束",
  };
}

export async function collectNightingale(source, start, end, options) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new Error("夜莺查询时间窗无效");
  const all = new Map();
  let partial = false;
  let total = null;
  // v9.1 history filters last_eval_time with inclusive second boundaries.
  // Read this run's [start, end) records only; do not reconstruct lifecycles.
  const queryStart = Math.ceil(start / 1000);
  const queryEnd = Math.ceil(end / 1000) - 1;
  const scopeNote =
    "仅查询本时间窗内的历史告警记录（按 last_eval_time）；排除恢复记录，不判断当前是否恢复，范围受平台保留期和账号权限约束";
  if (queryStart > queryEnd)
    return { alerts: [], status: "ok", note: scopeNote };
  for (let p = 1; p <= 100; p++) {
    options.signal?.throwIfAborted();
    const url = new URL(`${source.url}/api/n9e/alert-his-events/list`);
    for (const [k, v] of Object.entries({
      stime: queryStart,
      etime: queryEnd,
      is_recovered: 0,
      severity: -1,
      limit: 500,
      p,
    }))
      url.searchParams.set(k, String(v));
    const result = await requestJson(url, { ...options, authMode: "user-token" });
    if (
      !result ||
      result.err ||
      !Array.isArray(result.dat?.list) ||
      !Number.isSafeInteger(result.dat.total) ||
      result.dat.total < 0
    )
      throw new Error("夜莺历史接口格式不符，请核对版本、Token 与权限");
    if (total !== null && total !== result.dat.total) partial = true;
    total = result.dat.total;
    let added = 0;
    for (const raw of result.dat.list) {
      const validId =
        typeof raw?.id === "number"
          ? Number.isSafeInteger(raw.id) && raw.id > 0
          : typeof raw?.id === "string" && /^[1-9]\d*$/.test(raw.id);
      if (
        !validId ||
        ![0, 1, "0", "1", false, true].includes(raw.is_recovered) ||
        !["number", "string"].includes(typeof raw.last_eval_time) ||
        !Number.isSafeInteger(Number(raw.last_eval_time)) ||
        Number(raw.last_eval_time) <= 0
      )
        throw new Error(
          "夜莺历史事件格式不符，缺少有效的 id、last_eval_time 或 is_recovered",
        );
      const id = String(raw.id);
      if (!all.has(id)) added++;
      all.set(id, raw);
    }
    if (all.size >= total) break;
    if (result.dat.list.length === 0 || added === 0 || p === 100) {
      partial = true;
      break;
    }
  }
  const alerts = [...all.values()]
    .filter(
      (raw) =>
        Number(raw.is_recovered) === 0 &&
        sec(raw.last_eval_time) >= start &&
        sec(raw.last_eval_time) < end,
    )
    .map((raw) => {
      const first = sec(raw.first_trigger_time || raw.trigger_time);
      // History lists expose tags as ["key=value"], unlike current events.
      const tags = Object.fromEntries(
        (Array.isArray(raw.tags) ? raw.tags : [])
          .filter((tag) => typeof tag === "string" && tag.indexOf("=") > 0)
          .map((tag) => [
            tag.slice(0, tag.indexOf("=")).trim(),
            tag.slice(tag.indexOf("=") + 1),
          ]),
      );
      return {
        alertId: `${source.id}:${raw.id}`,
        sourceId: source.id,
        sourceName: source.name,
        sourceType: source.type,
        nativeId: String(raw.id),
        title: raw.rule_name ?? `Rule ${raw.rule_id}`,
        host:
          raw.target_ident ||
          raw.tags_map?.ident ||
          tags.ident ||
          raw.tags_map?.instance ||
          tags.instance ||
          "未知资产",
        severity: String(raw.severity),
        first,
        eventTime: sec(raw.last_eval_time),
        last: null,
        phase: "窗口内告警记录（未查询恢复状态）",
        raw,
      };
    });
  return {
    alerts,
    status: partial ? "partial" : "ok",
    note: partial
      ? `${scopeNote}；窗口内分页达到上限、列表发生变化或分页不完整，不可视为全量`
      : scopeNote,
  };
}

export async function pollAlertmanager(
  source,
  store,
  options,
  now = Date.now(),
) {
  const url = new URL(`${source.url}/api/v2/alerts`);
  for (const key of ["active", "silenced", "inhibited", "unprocessed"])
    url.searchParams.set(key, "true");
  const rows = await requestJson(url, options);
  if (!Array.isArray(rows)) throw new Error("Alertmanager 返回格式不符");
  const old = new Map(store.observations(source.id).map((r) => [r.key, r]));
  for (const raw of rows) {
    const key = `${raw.fingerprint ?? hash(raw.labels)}:${raw.startsAt}`;
    const prev = old.get(key);
    store.observe(source.id, key, {
      key,
      raw,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      first: when(raw.startsAt),
      last:
        when(raw.endsAt) !== null && when(raw.endsAt) <= now
          ? when(raw.endsAt)
          : null,
    });
  }
  return rows.length;
}

export function collectAlertmanager(source, start, end, store) {
  const alerts = store
    .observations(source.id)
    .filter((r) => r.lastSeen >= start && r.firstSeen < end)
    .map((r) => ({
      alertId: `${source.id}:${r.key}`,
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      nativeId: r.key,
      title: r.raw.labels?.alertname ?? "Alertmanager alert",
      host: r.raw.labels?.instance ?? r.raw.labels?.host ?? "未知资产",
      severity: r.raw.labels?.severity ?? "unknown",
      first: r.first,
      last: r.last,
      phase:
        r.last === null
          ? "轮询观测到；最终恢复状态未知"
          : phase(r.first, r.last, start, end),
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      raw: r.raw,
    }));
  return {
    alerts,
    status: "partial",
    note: "Alertmanager 为每分钟快照观测，短暂告警和停机期间记录可能遗漏；消失不等于恢复，不承诺完整历史",
  };
}

export async function collectSource(source, start, end, store, options) {
  if (source.type === "zabbix")
    return collectZabbix(source, start, end, options);
  if (source.type === "nightingale")
    return collectNightingale(source, start, end, options);
  return collectAlertmanager(source, start, end, store);
}
