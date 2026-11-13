import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { QUERY_PLANS, normalizeQueryPlan, resolveQueryBindings } from "./query-plan.mjs";
import { resolveDictionary, compileDictionaryQuery, assertDictionaryArguments, validateDictionaryRows } from "./dictionary-query.mjs";

const MAX_IPS = 64, MAX_ASSETS = 256, MAX_PAIRS = 16, MAX_EVENTS = 100;
const sqlString = (value) => "'" + String(value).replaceAll("'", "''").replaceAll("\\", "\\\\") + "'";
const sqlList = (values) => values.map((value) => `E${sqlString(value)}`).join(",");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const boundedText = (value, max = 1200) => typeof value === "string" ? value.slice(0, max) : value;
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Some PostgreSQL MCP servers serialize rows as Python literals. This small
// parser accepts data only (no eval, calls, attributes, comprehensions or tags).
function literalData(source) {
  let at = 0;
  const whitespace = () => { while (/\s/.test(source[at] ?? "") && at < source.length) at++; };
  const parse = (depth = 0) => {
    if (depth > 24) throw new Error("查询结果嵌套过深");
    whitespace();
    const char = source[at++];
    if (char === "'" || char === '"') {
      let result = "", ended = false;
      while (at < source.length) {
        let c = source[at++];
        if (c === char) { ended = true; break; }
        if (c === "\\") {
          c = source[at++];
          const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "\\": "\\", "'": "'", '"': '"', "/": "/" };
          if (Object.hasOwn(escapes, c)) c = escapes[c];
          else if (c === "u" || c === "x") {
            const len = c === "u" ? 4 : 2, code = source.slice(at, at + len);
            if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(code)) throw new Error("无效字符串转义");
            c = String.fromCharCode(parseInt(code, 16)); at += len;
          } else throw new Error("不支持的字符串转义");
        }
        result += c;
      }
      if (!ended) throw new Error("未闭合的字符串");
      return result;
    }
    if (char === "[" || char === "{") {
      const out = char === "[" ? [] : {}, close = char === "[" ? "]" : "}";
      whitespace(); if (source[at] === close) { at++; return out; }
      while (at < source.length) {
        const first = parse(depth + 1);
        if (char === "{") {
          whitespace(); if (typeof first !== "string" || source[at++] !== ":") throw new Error("无效对象");
          Object.defineProperty(out, first, { value: parse(depth + 1), enumerable: true, configurable: true });
        } else out.push(first);
        whitespace(); const next = source[at++];
        if (next === close) return out;
        if (next !== ",") throw new Error("无效数据分隔符");
        whitespace(); if (source[at] === close) { at++; return out; }
      }
      throw new Error("未闭合的数据");
    }
    at--;
    const match = /^(?:True|False|None|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at));
    if (!match) throw new Error("查询结果不是支持的数据格式");
    at += match[0].length;
    return ({ True: true, False: false, None: null, true: true, false: false, null: null })[match[0]] ?? (match[0] === "None" || match[0] === "null" ? null : Number(match[0]));
  };
  const result = parse(); whitespace();
  if (at !== source.length) throw new Error("查询结果含额外文本");
  return result;
}

export function parseEvidenceRows(input) {
  if (input?.isError) throw new Error("MCP 查询返回错误");
  let value = input;
  for (let i = 0; i < 8; i++) {
    if (typeof value === "string") {
      if (value.length > 2000000) throw new Error("查询结果超过 2 MB 上限");
      try { value = JSON.parse(value); } catch { value = literalData(value.trim()); }
      continue;
    }
    if (Array.isArray(value)) {
      if (!value.length) return [];
      if (value.every((v) => v?.type === "text" && typeof v.text === "string")) {
        if (value.length === 1) { value = value[0].text; continue; }
        return value.flatMap((v) => parseEvidenceRows(v.text));
      }
      if (!value.every(plain)) throw new Error("查询结果不是记录数组");
      return value;
    }
    if (plain(value)) {
      if (value.structuredContent !== undefined) { value = value.structuredContent; continue; }
      if (value.rows !== undefined) { value = value.rows; continue; }
      if (value.result !== undefined) { value = value.result; continue; }
      if (value.data !== undefined) { value = value.data; continue; }
      if (value.content !== undefined) { value = value.content; continue; }
    }
    break;
  }
  throw new Error("无法识别 MCP 查询记录，未将其当作空结果");
}

const ASSET_FIELDS = ["ip_address", "asset_name", "asset_resource_id", "asset_type", "asset_idc", "ip_vrf", "ip_mapping_ambiguous", "terminal_location_ambiguous", "switch_hostname", "switch_mgmt_ip", "switch_idc", "switch_role", "physical_if_name", "logical_if_name", "cmdb_observed_at", "arp_observed_at", "fdb_observed_at"];
export function assetQuery(ips) {
  if (!ips.length || ips.some((ip) => !isIP(ip)) || ips.length > MAX_IPS) throw new Error("无效资产 IP 范围");
  return { sql: `SELECT host(ip_address::inet) AS ip_address, asset_name, asset_resource_id, asset_type, asset_idc, ip_vrf, ip_mapping_ambiguous, terminal_location_ambiguous, switch_hostname, switch_mgmt_ip::text AS switch_mgmt_ip, switch_idc, switch_role, physical_if_name, logical_if_name, cmdb_observed_at::text AS cmdb_observed_at, arp_observed_at::text AS arp_observed_at, fdb_observed_at::text AS fdb_observed_at FROM public.cmdb_online_ip_switch_port_current WHERE ip_address IN (${ips.map((ip) => `E${sqlString(ip)}::inet`).join(",")}) ORDER BY ip_address, switch_hostname, asset_resource_id LIMIT ${MAX_ASSETS + 1}` };
}
export function pathQuery(pairs) {
  return {
    query: `UNWIND $pairs AS pair MATCH (a:Switch {hostname: pair.src}), (b:Switch {hostname: pair.dst}) OPTIONAL MATCH p = shortestPath((a)-[:CONNECTED_TO*0..8]-(b)) WHERE all(r IN relationships(p) WHERE r.active = true) RETURN pair.src AS src, pair.dst AS dst, CASE WHEN p IS NULL THEN [] ELSE [n IN nodes(p) | {hostname:n.hostname, idc:n.idc, last_seen_at:toString(n.last_seen_at), last_checked_at:toString(n.last_checked_at)}] END AS switches, CASE WHEN p IS NULL THEN [] ELSE [r IN relationships(p) | {ports:r.ports, logical_ports:r.logical_ports, last_seen_at:toString(r.last_seen_at), last_checked_at:toString(r.last_checked_at)}] END AS links LIMIT 17`,
    params: { pairs },
  };
}
export function eventQuery(hosts, start, end) {
  if (!hosts.length || hosts.length > 128 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) throw new Error("无效窗口事件范围");
  const from = sqlString(new Date(start).toISOString()), to = sqlString(new Date(end).toISOString()), names = sqlList(hosts);
  return { sql: `SELECT * FROM ((SELECT 'interface' AS kind, id::text AS id, switch_hostname AS host, interface, event, LEFT(event_cause,800) AS detail, observed_at AS event_time, (length(event_cause)>800) AS text_truncated FROM public.switch_if_up_down_info WHERE switch_hostname IN (${names}) AND observed_at >= ${from}::timestamptz AND observed_at < ${to}::timestamptz ORDER BY observed_at,id LIMIT ${MAX_EVENTS + 1}) UNION ALL (SELECT 'device' AS kind, id::text AS id, switch_hostname AS host, interface, event, LEFT(event_cause,800) AS detail, observed_at AS event_time, (length(event_cause)>800) AS text_truncated FROM public.switch_ip_up_down_info WHERE switch_hostname IN (${names}) AND observed_at >= ${from}::timestamptz AND observed_at < ${to}::timestamptz ORDER BY observed_at,id LIMIT ${MAX_EVENTS + 1}) UNION ALL (SELECT 'syslog' AS kind, id::text AS id, host_info AS host, NULL::text AS interface, LEFT(event,300) AS event, LEFT(event_cause,800) AS detail, inserted_at AS event_time, (length(event)>300 OR length(event_cause)>800) AS text_truncated FROM public.switch_message_info WHERE host_info IN (${names}) AND inserted_at >= ${from}::timestamptz AND inserted_at < ${to}::timestamptz ORDER BY inserted_at,id LIMIT ${MAX_EVENTS + 1})) AS window_events ORDER BY event_time,kind,id LIMIT ${MAX_EVENTS + 1}`.replace("SELECT * FROM", "SELECT kind,id,host,interface,event,detail,event_time::text AS event_time,text_truncated FROM") };
}

function alertEndpoints(alert) {
  const raw = alert.raw ?? {}, labels = { ...(plain(raw.labels) ? raw.labels : {}) };
  for (const tag of [...(Array.isArray(raw.original_tags) ? raw.original_tags : []), ...(Array.isArray(raw.tags) ? raw.tags : [])]) {
    if (typeof tag !== "string") continue;
    const split = tag.indexOf("="); if (split > 0) labels[tag.slice(0, split)] = tag.slice(split + 1);
  }
  const valid = (v) => typeof v === "string" && isIP(v) ? v : null;
  const src = valid(labels.srcip ?? raw.srcip), dst = valid(labels.dstip ?? raw.dstip ?? labels.target);
  const ips = [...new Set([src, dst, valid(labels.ip), valid(labels.ip_address), valid(raw.ip_address), valid(alert.host)].filter(Boolean))];
  return { src, dst, ips };
}
const clone = (value) => structuredClone(value);

export function createEvidenceCollector({ invoke, now = Date.now }) {
  const cache = new Map();
  return async function collect({ run, task, schemas = [], signal, onProgress }) {
    const started = now(), plan = normalizeQueryPlan(task.queryPlan), resolved = resolveQueryBindings(plan, schemas);
    const dictionary = resolveDictionary(task, schemas);
    const result = { plan: { ...plan, name: QUERY_PLANS.find((p) => p.id === plan.id).name }, bindings: dictionary.selectedOnly ? {} : resolved.bindings, evidence: [], queries: [], elapsedMs: 0,
      ...(dictionary.evidence.length ? { dictionary: dictionary.evidence } : {}) };
    if (!run.alerts?.length) return result;
    // Explicit selection means only these entries. Native tools are available
    // for bounded AI lookups; do not prefetch unrelated legacy databases.
    if (dictionary.selectedOnly && !Object.keys(dictionary.entries).some((id) => ["assets","paths","events"].includes(id))) {
      result.elapsedMs = now() - started;
      return result;
    }
    const add = (id, purpose, status, rows, note, extra = {}) => {
      const evidence = { id, purpose, status, rows, note, ...extra }; result.evidence.push(evidence); return evidence;
    };
    const query = async (id, purpose, role, args, limit, cacheable = false, sample = {}) => {
      signal?.throwIfAborted();
      const selected = dictionary.entries[id];
      if (selected?.skip || dictionary.selectedOnly && !selected) return add(id, purpose, "skipped", [], selected?.note ?? "本方案未选择此自动取证条目");
      const tool = selected ? selected.tool : dictionary.selectedOnly ? "" : resolved.bindings[role], before = now();
      onProgress?.({ stage: purpose });
      if (!tool) {
        const note = selected?.note ?? (dictionary.selectedOnly ? "本方案未选择此自动取证条目" : resolved.issues.find((v) => v.role === role)?.note ?? "未配置对应查询工具");
        result.queries.push({ id, purpose, tool: "", status: "unavailable", elapsedMs: 0, rowCount: 0, resultBytes: 0, cacheHit: false, note });
        return add(id, purpose, "unavailable", [], note);
      }
      // Do not share cached evidence across tasks, workspaces, binding/plan edits.
      if (selected) {
        try {
          args = compileDictionaryQuery(selected.entry, sample);
          assertDictionaryArguments(selected.entry, schemas.find((t) => t.name === tool), args);
        } catch (error) {
          const note = `字典模板不可执行：${boundedText(error.message, 400)}`;
          const dictionaryRow = result.dictionary.find((item) => item.purpose === id);
          dictionaryRow.status = "failed";
          dictionaryRow.note = note;
          result.queries.push({ id, purpose, tool, status: "failed", elapsedMs: now()-before, rowCount: 0, resultBytes: 0, cacheHit: false, note });
          return add(id, purpose, "failed", [], note);
        }
      }
      const key = hash([task.id ?? run.id, task.workspace, task.queryCacheScope ?? null, plan, selected?.entry ?? null, tool, args]);
      const hit = cacheable && plan.assetCacheSeconds > 0 && cache.get(key);
      if (hit && hit.expires > now()) {
        const evidence = add(id, purpose, "ok", clone(hit.rows), "复用资产映射缓存；仅用于定位，不代表窗口当时在线", { observedAt: hit.observedAt, cacheHit: true });
        result.queries.push({ id, purpose, tool, status: "ok", elapsedMs: now() - before, rowCount: hit.rows.length, resultBytes: hit.bytes, cacheHit: true, note: evidence.note });
        return evidence;
      }
      const control = new AbortController(), combined = signal ? AbortSignal.any([signal, control.signal]) : control.signal;
      let timer;
      try {
        // Await the owned execution even after cancellation. A transport must
        // cooperate with the signal; do not abandon a still-running DB query.
        timer = setTimeout(() => control.abort(new Error(`查询超过 ${plan.queryTimeoutSeconds} 秒`)), plan.queryTimeoutSeconds * 1000);
        const raw = await invoke(tool, args, combined);
        combined.throwIfAborted();
        let rows = parseEvidenceRows(raw);
        if (selected) validateDictionaryRows(id, rows);
        if (rows.some((row) => id === "assets" ? !isIP(row.ip_address ?? "") || !Object.hasOwn(row, "switch_hostname")
          : id === "paths" ? typeof row.src !== "string" || typeof row.dst !== "string" || !Array.isArray(row.switches) || !Array.isArray(row.links)
          : id === "events" ? typeof row.kind !== "string" || typeof row.event_time !== "string" : false))
          throw new Error("查询记录字段与固定模板不一致，未将其当作空结果");
        let truncated = rows.length > limit || rows.some((r) => r.text_truncated === true);
        rows = rows.slice(0, limit);
        if (cacheable) rows = rows.map((row) => Object.fromEntries(ASSET_FIELDS.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]])));
        const compactRows = []; let characters = 2;
        for (const row of rows) {
          const length = JSON.stringify(row).length + 1;
          if (characters + length > 6000) { truncated = true; continue; }
          compactRows.push(row); characters += length;
        }
        rows = compactRows;
        const bytes = Buffer.byteLength(JSON.stringify(rows));
        const observedAt = now(), note = truncated ? `结果超过 ${limit} 条或 6000 字符证据预算，或日志文本过长；仅保留部分结果，覆盖不完整` : "";
        const evidence = add(id, purpose, truncated ? "partial" : "ok", rows, note, { observedAt, truncated, cacheHit: false });
        result.queries.push({ id, purpose, tool, status: evidence.status, elapsedMs: now() - before, rowCount: rows.length, resultBytes: bytes, cacheHit: false, note });
        if (cacheable && raw?.cacheable !== false && plan.assetCacheSeconds > 0 && rows.length && !truncated) {
          for (const [cacheKey, entry] of cache) if (entry.expires <= now()) cache.delete(cacheKey);
          if (cache.size >= 128) cache.delete(cache.keys().next().value);
          cache.set(key, { rows: clone(rows), observedAt, bytes, expires: now() + plan.assetCacheSeconds * 1000 });
        }
        return evidence;
      } catch (error) {
        signal?.throwIfAborted();
        const note = boundedText(error.message ?? String(error), 400);
        const status = control.signal.aborted ? "timeout" : "failed";
        if (selected) {
          const dictionaryRow = result.dictionary.find((item) => item.purpose === id);
          dictionaryRow.status = status;
          dictionaryRow.note = `本轮字典查询失败，请核对模板与数据结构后重新验证：${note}`;
        }
        result.queries.push({ id, purpose, tool, status, elapsedMs: now() - before, rowCount: 0, resultBytes: 0, cacheHit: false, note, error: note });
        return add(id, purpose, status, [], note);
      } finally { clearTimeout(timer); }
    };

    const targeted = plan.id === "network-ping" ? run.alerts.filter((a) => /ping|丢包|packet.?loss/i.test(`${a.title ?? ""} ${a.raw?.prom_ql ?? ""}`)) : run.alerts;
    const endpoints = targeted.map(alertEndpoints), ips = [...new Set(endpoints.flatMap((v) => v.ips))].sort();
    if (targeted.length !== run.alerts.length) add("scope", "告警类型覆盖", "partial", [], `${run.alerts.length - targeted.length} 条非 ping 告警未套用网络模板；仍须根据全部原文分析并标明缺少专用补查`);
    if (ips.length > MAX_IPS) add("ip-limit", "资产范围", "partial", [], `唯一 IP 超过 ${MAX_IPS} 个，超出部分未补查`);
    if (!ips.length) add("assets", "批量资产归一", "unavailable", [], "告警未提供可验证的 IP，未猜测资产；请依据原文分析并记录证据缺口");
    else {
      const assets = await query("assets", "批量资产归一", "postgres", assetQuery(ips.slice(0, MAX_IPS)), MAX_ASSETS, true, { ips: ips.slice(0, MAX_IPS) });
      assets.note = [assets.note, "资产映射为当前采集快照，不代表历史告警窗口状态；保留全部候选和歧义字段"].filter(Boolean).join("；");
      const hosts = new Set(assets.rows.map((r) => r.switch_hostname).filter((h) => typeof h === "string" && h.length <= 200));
      const mapped = (ip) => {
        const rows = assets.rows.filter((r) => r.ip_address === ip);
        if (assets.truncated || rows.some((r) => r.ip_mapping_ambiguous || r.terminal_location_ambiguous)) return [];
        return [...new Set(rows.map((r) => r.switch_hostname).filter((name) => typeof name === "string" && name.length <= 200))];
      };
      const pairs = [];
      if (plan.id === "network-ping") for (const endpoint of endpoints) {
        if (!endpoint.src || !endpoint.dst) continue;
        const left = mapped(endpoint.src), right = mapped(endpoint.dst);
        if (left.length === 1 && right.length === 1 && !pairs.some((p) => p.src === left[0] && p.dst === right[0])) pairs.push({ src: left[0], dst: right[0] });
        else add(`mapping-${result.evidence.length}`, "路径端点确认", "partial", [], "部分端点映射缺失或有歧义，未猜测唯一交换机路径");
      }
      if (pairs.length > MAX_PAIRS) add("pair-limit", "路径范围", "partial", [], `路径端点对超过 ${MAX_PAIRS} 组，超出部分未查询`);
      if (pairs.length) {
        const paths = await query("paths", "查询候选多跳路径", "neo4j", pathQuery(pairs.slice(0, MAX_PAIRS)), MAX_PAIRS, false, { pairs: pairs.slice(0, MAX_PAIRS) });
        if (paths.status !== "skipped") paths.note = [paths.note, "仅为当前拓扑候选路径（最多 8 跳），不等于真实流量路径；未查到不能证明没有链路，历史状态需另行验证"].filter(Boolean).join("；");
        for (const path of paths.rows) for (const node of Array.isArray(path.switches) ? path.switches : []) if (typeof node.hostname === "string" && node.hostname.length <= 200) hosts.add(node.hostname);
      }
      if (hosts.size) {
        if (hosts.size > 128) add("host-limit", "设备范围", "partial", [], "路径设备超过 128 个，超出部分未查询窗口事件");
        const logs = await query("events", "查询窗口设备事件", "postgres", eventQuery([...hosts].sort().slice(0, 128), run.start, run.end), MAX_EVENTS, false, { hosts: [...hosts].sort().slice(0,128), start: run.start, end: run.end });
        logs.note = [logs.note, dictionary.entries.events ? `时间口径：${dictionary.entries.events.entry?.timeSemantics ?? "未说明"}。空记录不代表无异常` : "syslog 按 host_info 精确匹配设备名；其 inserted_at 是入库时间。未覆盖接口性能指标，空记录不代表无异常"].filter(Boolean).join("；");
      } else add("events", "查询窗口设备事件", "unavailable", [], "未归一出接入设备，无法限定查询范围；未扩大到全库扫描");
    }
    result.elapsedMs = now() - started;
    return result;
  };
}
