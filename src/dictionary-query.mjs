import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { normalizeDictionaryRecipe, dictionaryToolCompatible, dictionaryEntryIds } from "./dictionary-defs.mjs";
import { nativeArguments, assertNativeSchema } from "./native-query.mjs";

const stable = (v) => JSON.stringify(v, (_, x) => x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);
export function dictionaryFingerprint(tool) {
  return createHash("sha256").update(stable({ name: tool.name, description: tool.description ?? "",
    input: tool.parameters ?? tool.inputSchema ?? tool.schema ?? {}, output: tool.outputSchema ?? tool.output?.schema ?? {},
    ...(tool.annotations ? { annotations: tool.annotations } : {}) })).digest("hex");
}
const ident = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) throw new Error("字典标识符无效");
  return `"${value}"`;
};
const table = (value) => {
  if (typeof value !== "string" || value.split(".").length > 2) throw new Error("字典表名无效");
  return value.split(".").map(ident).join(".");
};
const literal = (value) => "E'" + String(value).replaceAll("\\", "\\\\").replaceAll("'", "''") + "'";
const names = (values, limit, validate) => {
  if (!Array.isArray(values) || !values.length || values.length > limit || values.some((v) => typeof v !== "string" || !v || v.length > 200 || /[\x00-\x1f]/.test(v) || (validate && !validate(v)))) throw new Error("字典查询对象为空、无效或超限");
  return [...new Set(values)];
};
const temporal = new Set(["cmdb_observed_at", "arp_observed_at", "fdb_observed_at"]);

// A recipe is declarative: only bounded SELECT / MATCH shapes are generated.
export function compileDictionaryQuery(entry, sample, { validation = false, tool } = {}) {
  if (entry.purpose === "tool") return nativeArguments(entry, sample, { validation });
  const r = normalizeDictionaryRecipe(entry.purpose, entry.recipe), limit = validation ? 5 : entry.purpose === "assets" ? 257 : entry.purpose === "paths" ? 17 : 101;
  if (entry.purpose === "assets") {
    const ips = names(sample.ips, validation ? 2 : 64, isIP);
    const fields = Object.entries(r.columns).filter(([, value]) => value).map(([key, value]) => `${key === "ip_address" ? `host(${ident(value)}::inet)` : `${ident(value)}${key === "switch_mgmt_ip" || temporal.has(key) ? "::text" : ""}`} AS ${ident(key)}`);
    return { sql: `SELECT ${fields.join(", ")} FROM ${table(r.table)} WHERE ${ident(r.columns.ip_address)} IN (${ips.map(literal).join(",")}) ORDER BY ${ident(r.columns.ip_address)} LIMIT ${limit}` };
  }
  if (entry.purpose === "events") {
    const hosts = names(sample.hosts, validation ? 2 : 128);
    if (!Number.isSafeInteger(sample.start) || !Number.isSafeInteger(sample.end) || sample.start >= sample.end || (validation && sample.end - sample.start > 3600000)) throw new Error("字典事件时间窗无效；验证最多一小时");
    const queries = r.sources.map((s) => {
      const t = ident(s.timeColumn), from = s.timeType === "timestamp" ? `${literal(new Date(sample.start).toISOString())}::timestamptz` : sample.start / (s.timeType === "unix-seconds" ? 1000 : 1);
      const to = s.timeType === "timestamp" ? `${literal(new Date(sample.end).toISOString())}::timestamptz` : sample.end / (s.timeType === "unix-seconds" ? 1000 : 1);
      const timestamp = s.timeType === "timestamp" ? `${t}::timestamptz` : `to_timestamp(${t}::double precision${s.timeType === "unix-millis" ? " / 1000.0" : ""})`;
      const detail = s.detailColumn ? `${ident(s.detailColumn)}::text` : "NULL::text";
      return `SELECT ${literal(s.kind)} AS kind, ${ident(s.idColumn)}::text AS id, ${ident(s.hostColumn)}::text AS host, ${s.interfaceColumn ? `${ident(s.interfaceColumn)}::text` : "NULL::text"} AS interface, LEFT(${ident(s.eventColumn)}::text,300) AS event, LEFT(${detail},800) AS detail, ${timestamp} AS event_time, (length(${ident(s.eventColumn)}::text)>300 OR coalesce(length(${detail})>800,false)) AS text_truncated FROM ${table(s.table)} WHERE ${ident(s.hostColumn)} IN (${hosts.map(literal).join(",")}) AND ${t} >= ${from} AND ${t} < ${to} ORDER BY ${t},${ident(s.idColumn)} LIMIT ${limit}`;
    });
    return { sql: `SELECT kind,id,host,interface,event,detail,event_time::text AS event_time,text_truncated FROM (${queries.map((q) => `(${q})`).join(" UNION ALL ")}) AS window_events ORDER BY event_time,kind,id LIMIT ${limit}` };
  }
  if (entry.purpose === "paths") {
    if (!Array.isArray(sample.pairs) || !sample.pairs.length || sample.pairs.length > (validation ? 1 : 16)) throw new Error("字典路径端点对无效或超限");
    const pairs = sample.pairs.map((p) => { names([p?.src, p?.dst], 2); return { src: p.src, dst: p.dst }; });
    const cy = (v) => { ident(v); return `\`${v}\``; };
    const property = (owner, field, stringify = false) => field ? `${stringify ? "toString(" : ""}${owner}.${cy(field)}${stringify ? ")" : ""}` : "null";
    return { query: `UNWIND $pairs AS pair MATCH (a:${cy(r.nodeLabel)} {${cy(r.hostnameProperty)}: pair.src}), (b:${cy(r.nodeLabel)} {${cy(r.hostnameProperty)}: pair.dst}) OPTIONAL MATCH p = shortestPath((a)-[:${cy(r.relationType)}*0..8]-(b))${r.activeProperty ? ` WHERE all(r IN relationships(p) WHERE r.${cy(r.activeProperty)} = true)` : ""} RETURN pair.src AS src, pair.dst AS dst, CASE WHEN p IS NULL THEN [] ELSE [n IN nodes(p) | {hostname:n.${cy(r.hostnameProperty)}, idc:${property("n",r.idcProperty)}, last_seen_at:${property("n",r.lastSeenProperty,true)}, last_checked_at:${property("n",r.lastCheckedProperty,true)}}] END AS switches, CASE WHEN p IS NULL THEN [] ELSE [r IN relationships(p) | {ports:${property("r",r.portsProperty)}, logical_ports:${property("r",r.logicalPortsProperty)}, last_seen_at:${property("r",r.lastSeenProperty,true)}, last_checked_at:${property("r",r.lastCheckedProperty,true)}}] END AS links LIMIT ${limit}`, params: { pairs } };
  }
  if (["knowledge", "memory"].includes(entry.purpose)) {
    if (typeof sample.query !== "string" || !sample.query.trim() || sample.query.length > 1000) throw new Error("字典验证检索词不能为空且最多1000字");
    const args = { ...r.fixedArgs, [r.queryKey]: sample.query, ...(r.limitKey ? { [r.limitKey]: 3 } : {}) };
    const props = (tool?.parameters ?? tool?.inputSchema ?? tool?.schema ?? {}).properties ?? {};
    for (const key of ["limit", "top_k", "topK", "max_results"]) if (["number", "integer"].includes(props[key]?.type)) args[key] = 3;
    return args;
  }
  throw new Error("说明条目不提供执行能力");
}

export function assertDictionaryArguments(entry, tool, args) {
  if (!tool || !dictionaryToolCompatible(entry.purpose, tool)) throw new Error("字典工具不存在或参数结构不兼容");
  if (entry.purpose === "tool") return assertNativeSchema(args, tool.parameters ?? tool.inputSchema ?? tool.schema ?? {});
  const s = tool.parameters ?? tool.inputSchema ?? tool.schema ?? {}, p = s.properties ?? {};
  if ((s.required ?? []).some((key) => !Object.hasOwn(args,key))) throw new Error("字典工具要求未配置的必填参数");
  for (const [key,value] of Object.entries(args)) {
    if (!p[key]) { if (s.additionalProperties === false) throw new Error("字典参数不在工具结构中"); continue; }
    const type = p[key].type;
    if (type === "string" && typeof value !== "string" || type === "integer" && !Number.isInteger(value) || type === "number" && typeof value !== "number" || type === "object" && (!value || typeof value !== "object" || Array.isArray(value)) || type === "array" && !Array.isArray(value) || type === "boolean" && typeof value !== "boolean") throw new Error("字典参数类型与工具不一致");
  }
}

export function validateDictionaryRows(purpose, rows) {
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("字典返回记录结构不符，请重新验证");
  if (rows.some((r) => purpose === "assets" ? !isIP(r.ip_address ?? "") || !Object.hasOwn(r,"switch_hostname") || (r.switch_hostname !== null && typeof r.switch_hostname !== "string")
    : purpose === "events" ? typeof r.kind !== "string" || typeof r.event_time !== "string" || !Number.isFinite(Date.parse(r.event_time)) || typeof r.host !== "string" || typeof r.id !== "string" || !Object.hasOwn(r,"event") || (r.event !== null && typeof r.event !== "string")
    : purpose === "paths" ? typeof r.src !== "string" || typeof r.dst !== "string" || !Array.isArray(r.switches) || !Array.isArray(r.links) || r.switches.some((n) => typeof n?.hostname !== "string") || r.links.some((link) => !link || typeof link !== "object" || Array.isArray(link)) : false)) throw new Error("字典返回字段不符，请核对数据结构并重新验证");
}

export function resolveDictionary(task, schemas) {
  const entries = {}, byId = {}, evidence = [], plan = task.queryPlan ?? {};
  const selectedOnly = Object.hasOwn(plan, "dictionaryIds"); let budget = 10000;
  const ids = selectedOnly ? dictionaryEntryIds(plan) : [...new Set(Object.values(plan.dictionaryBindings ?? {}).filter(Boolean))];
  for (const id of ids) {
    const entry = task.queryDictionary?.find((x) => x.id === id);
    const purpose = entry?.purpose ?? Object.entries(plan.dictionaryBindings ?? {}).find(([,v])=>v===id)?.[0];
    const tool = schemas.find((t) => t.name === entry?.tool);
    let status = "ready", note = "验证有效；当前结果仍需按本轮范围查询，业务含义以数据说明为准";
    if (!entry) { status = "unavailable"; note = "字典引用不存在"; }
    else if (purpose === "reference") { status = "reference"; note = "仅提供参考说明，不具有工具执行能力"; }
    else if (!["verified", "empty"].includes(entry.validation?.status) || entry.validation.revision !== entry.revision) { status = "unverified"; note = "字典尚未验证或已修改，请在字典页重新验证"; }
    else if (!tool || !dictionaryToolCompatible(purpose,tool) || dictionaryFingerprint(tool) !== entry.validation.toolFingerprint) { status = "schema_changed"; note = "字典工具不可用或工具定义已变化，请重新验证"; }
    else if (entry.validation.status === "empty") note = "验证查询执行成功但样例为空，返回字段和业务语义尚未采样；本轮仍检查实际返回结构";
    const resolved = { entry, tool: status === "ready" ? entry.tool : "", status, note };
    byId[id] = resolved;
    if (!selectedOnly && ["tool","reference"].includes(purpose)) {
      for (const [slot,boundId] of Object.entries(plan.dictionaryBindings ?? {})) if (boundId===id) entries[slot] = {
        entry, tool: "", status: "skipped", skip: true,
        note: purpose === "tool" ? "此条目已使用 MCP 原生参数，按需通过 entryId 补查；未执行旧自动取证模板" : "此条目仅提供说明，未执行旧自动取证模板",
      };
    }
    if (purpose && !["tool", "reference"].includes(purpose)) {
      if (entries[purpose]) { entries[purpose] = { entry: null, tool: "", status: "unavailable", note: "同一种旧自动取证模板存在多个引用，未选择其中任意一个" }; }
      else entries[purpose] = resolved;
    }
    const row = { id, name: entry?.name ?? id, revision: entry?.revision, purpose, tool: entry?.tool ?? "", status, note, checkedAt: entry?.validation?.checkedAt };
    if (["ready","reference"].includes(status)) for (const key of ["description","dataObjects","inputs","outputs","relationships","timeSemantics","limitations","document"]) {
      const value = String(entry[key] ?? ""), length = Math.max(0,Math.min(1200,budget));
      row[key] = value.slice(0,length); budget -= row[key].length;
      if (value.length > length) row.documentationTruncated = true;
    }
    if (purpose === "tool" && status === "ready") {
      row.lookup = { entryId: id };
      const template = JSON.stringify(entry.recipe?.arguments ?? {});
      row.parameterTemplate = template.slice(0, Math.min(1200,Math.max(0,budget))); budget -= row.parameterTemplate.length;
      if (row.parameterTemplate.length < template.length) row.documentationTruncated = true;
    }
    evidence.push(row);
  }
  return { entries, byId, evidence, selectedOnly };
}
