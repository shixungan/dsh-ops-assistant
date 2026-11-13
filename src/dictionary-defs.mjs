// Shared browser/server definitions. Recipes describe data, never executable code.
export const DICTIONARY_PURPOSES = [
  { id: "assets", name: "资产与接入映射", role: "postgres" },
  { id: "paths", name: "交换机候选路径", role: "neo4j" },
  { id: "events", name: "窗口设备事件", role: "postgres" },
  { id: "knowledge", name: "错误码与文档", role: "knowledge" },
  { id: "memory", name: "已确认历史经验", role: "memory" },
  { id: "reference", name: "仅保存数据说明", role: null },
  { id: "tool", name: "MCP 原生查询", role: null },
];
export const EXECUTABLE_PURPOSES = DICTIONARY_PURPOSES.filter((p) => p.role).map((p) => p.id);
export const ASSET_COLUMNS = ["ip_address", "asset_name", "asset_resource_id", "asset_type", "asset_idc", "ip_vrf", "ip_mapping_ambiguous", "terminal_location_ambiguous", "switch_hostname", "switch_mgmt_ip", "switch_idc", "switch_role", "physical_if_name", "logical_if_name", "cmdb_observed_at", "arp_observed_at", "fdb_observed_at"];
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function keys(value, allowed, label) {
  if (!plain(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label}包含无效字段`);
}
function identifier(value, label, table = false) {
  const part = "[A-Za-z_][A-Za-z0-9_]{0,62}";
  if (typeof value !== "string" || !new RegExp(`^${part}${table ? `(?:\\.${part})?` : ""}$`).test(value)) throw new Error(`${label}须为有效标识符，不能包含 SQL/Cypher 表达式`);
  return value;
}
export function defaultDictionaryRecipe(purpose) {
  if (purpose === "tool") return { arguments: {} };
  if (purpose === "assets") return { table: "public.cmdb_online_ip_switch_port_current", columns: Object.fromEntries(ASSET_COLUMNS.map((field) => [field, field])) };
  if (purpose === "events") return { sources: [
    { kind: "interface", table: "public.switch_if_up_down_info", hostColumn: "switch_hostname", idColumn: "id", eventColumn: "event", detailColumn: "event_cause", timeColumn: "observed_at", interfaceColumn: "interface", timeType: "timestamp" },
    { kind: "device", table: "public.switch_ip_up_down_info", hostColumn: "switch_hostname", idColumn: "id", eventColumn: "event", detailColumn: "event_cause", timeColumn: "observed_at", interfaceColumn: "interface", timeType: "timestamp" },
    { kind: "syslog", table: "public.switch_message_info", hostColumn: "host_info", idColumn: "id", eventColumn: "event", detailColumn: "event_cause", timeColumn: "inserted_at", interfaceColumn: "", timeType: "timestamp" },
  ] };
  if (purpose === "paths") return { nodeLabel: "Switch", relationType: "CONNECTED_TO", hostnameProperty: "hostname", activeProperty: "active", idcProperty: "idc", lastSeenProperty: "last_seen_at", lastCheckedProperty: "last_checked_at", portsProperty: "ports", logicalPortsProperty: "logical_ports" };
  if (["knowledge", "memory"].includes(purpose)) return { queryKey: "query", limitKey: "", fixedArgs: {} };
  return {};
}
export function normalizeDictionaryRecipe(purpose, input) {
  if (!DICTIONARY_PURPOSES.some((p) => p.id === purpose)) throw new Error("不支持的数据用途");
  const recipe = input === undefined ? defaultDictionaryRecipe(purpose) : input;
  if (purpose === "tool") {
    keys(recipe, ["arguments"], "MCP 参数模板");
    return { arguments: normalizeNativeArguments(recipe.arguments) };
  }
  if (purpose === "assets") {
    keys(recipe, ["table", "columns"], "资产模板"); keys(recipe.columns, ASSET_COLUMNS, "资产字段映射");
    const columns = {};
    for (const field of ASSET_COLUMNS) if (recipe.columns[field]) columns[field] = identifier(recipe.columns[field], field);
    if (!columns.ip_address || !columns.switch_hostname) throw new Error("资产模板必须映射 ip_address 和 switch_hostname");
    return { table: identifier(recipe.table, "资产表", true), columns };
  }
  if (purpose === "events") {
    keys(recipe, ["sources"], "事件模板");
    if (!Array.isArray(recipe.sources) || !recipe.sources.length || recipe.sources.length > 4) throw new Error("事件模板须包含 1—4 个数据表");
    const sources = recipe.sources.map((source) => {
      keys(source, ["kind", "table", "hostColumn", "idColumn", "eventColumn", "detailColumn", "timeColumn", "interfaceColumn", "timeType"], "事件来源");
      if (!["interface", "device", "syslog", "custom"].includes(source.kind)) throw new Error("无效事件类型");
      if (!["timestamp", "unix-seconds", "unix-millis"].includes(source.timeType)) throw new Error("请选择事件时间类型");
      const out = { kind: source.kind, table: identifier(source.table, "事件表", true), timeType: source.timeType };
      for (const field of ["hostColumn", "idColumn", "eventColumn", "timeColumn"]) out[field] = identifier(source[field], field);
      for (const field of ["detailColumn", "interfaceColumn"]) out[field] = source[field] ? identifier(source[field], field) : "";
      return out;
    });
    return { sources };
  }
  if (purpose === "paths") {
    const required = ["nodeLabel", "relationType", "hostnameProperty"];
    const optional = ["activeProperty", "idcProperty", "lastSeenProperty", "lastCheckedProperty", "portsProperty", "logicalPortsProperty"];
    keys(recipe, [...required, ...optional], "拓扑模板");
    return Object.fromEntries([...required, ...optional].map((key) => [key, optional.includes(key) && !recipe[key] ? "" : identifier(recipe[key], key)]));
  }
  if (["knowledge", "memory"].includes(purpose)) {
    keys(recipe, ["queryKey", "limitKey", "fixedArgs"], "检索模板");
    if (!["query", "keyword", "query_text"].includes(recipe.queryKey)) throw new Error("检索参数须为 query、keyword 或 query_text");
    if (![undefined, "", "limit", "top_k"].includes(recipe.limitKey)) throw new Error("检索数量参数须为 limit 或 top_k");
    const fixedArgs = recipe.fixedArgs ?? {};
    if (!plain(fixedArgs) || Object.keys(fixedArgs).length > 12) throw new Error("固定检索参数最多 12 个");
    const out = {};
    const scalar = (v) => v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 300);
    for (const [key, value] of Object.entries(fixedArgs)) {
      identifier(key, "固定参数");
      const canonical = key.toLowerCase().replaceAll("_", "");
      if (["query", "keyword", "querytext", "limit", "topk", "maxresults", "maxresult", "pagesize", "size", "count", "offset", "page", "maxcount", "maxitems", "numresults", "proto", "constructor", "prototype"].includes(canonical) || /token|password|secret|credential|authorization|api_?key/i.test(key)) throw new Error("固定参数不能覆盖检索词/数量或包含凭据");
      if (!scalar(value) && !(Array.isArray(value) && value.length <= 12 && value.every(scalar))) throw new Error("固定参数只能使用短文本、数值、布尔值或有限数组");
      out[key] = value;
    }
    return { queryKey: recipe.queryKey, limitKey: recipe.limitKey ?? "", fixedArgs: out };
  }
  keys(recipe, [], "参考说明"); return {};
}
export function normalizeDictionaryBindings(input = {}) {
  keys(input, EXECUTABLE_PURPOSES, "数据字典引用");
  return Object.fromEntries(EXECUTABLE_PURPOSES.map((purpose) => {
    const id = input[purpose] ?? "";
    if (typeof id !== "string" || id.length > 160 || /[\x00-\x1f]/.test(id)) throw new Error("数据字典引用无效");
    return [purpose, id];
  }));
}
export function dictionaryToolCompatible(purpose, tool) {
  if (purpose === "tool") return nativeToolCompatibility(tool).compatible;
  const n = String(tool?.name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const p = (tool?.parameters ?? tool?.inputSchema ?? tool?.schema ?? {}).properties ?? {};
  if (["assets", "events"].includes(purpose)) return n.endsWith("executesql") && p.sql?.type === "string";
  if (purpose === "paths") return n.endsWith("readcypher") && p.query?.type === "string";
  if (["knowledge", "memory"].includes(purpose)) return /search/.test(n) && !/delete|write|update|create|save|remove|addmemory/.test(n) && ["query", "keyword", "query_text"].some((key) => p[key]?.type === "string");
  return purpose === "reference";
}

export function normalizeDictionaryIds(value) {
  if (!Array.isArray(value) || value.length > 20 || value.some((id) => typeof id !== "string" || !id || id.length > 160 || /[\x00-\x1f]/.test(id))) throw new Error("数据字典引用须为最多 20 个有效条目 ID");
  if (new Set(value).size !== value.length) throw new Error("数据字典引用不能重复");
  return [...value];
}
export function dictionaryEntryIds(plan = {}) {
  return Object.hasOwn(plan, "dictionaryIds") ? normalizeDictionaryIds(plan.dictionaryIds)
    : [...new Set(Object.values(normalizeDictionaryBindings(plan.dictionaryBindings)).filter(Boolean))];
}
const unsafeArgument = (key) => /^(?:__proto__|constructor|prototype|sql|cypher|command|commands|cmd|script|code|shell|executable)$/i.test(key)
  || /^(?:sqlquery|querysql|cypherquery|querycypher|shellcommand|pythoncode|javascriptcode|powershellscript)$/i.test(key.replace(/[_-]/g, ""))
  || /token|password|secret|credential|authorization|api_?key/i.test(key);
const expressionDescription = (text) => /\b(?:sql|cypher)\s+(?:query|statement|command|expression)\b|\b(?:execute|run)\b.{0,30}\b(?:sql|cypher|code|script|shell)\b|(?:SQL|Cypher)\s*(?:查询|语句|表达式)|(?:执行|运行).{0,12}(?:代码|脚本|命令)/i.test(String(text ?? ""));
export function normalizeNativeArguments(value) {
  if (!plain(value)) throw new Error("MCP 参数须为 JSON 对象");
  let count = 0;
  function visit(item, depth) {
    if (++count > 300 || depth > 8) throw new Error("MCP 参数嵌套或数量超限");
    if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string") {
      if (item.length > 4000 || /\x00/.test(item)) throw new Error("MCP 参数文本过长或包含无效字符");
      return item;
    }
    if (Array.isArray(item)) {
      if (item.length > 32) throw new Error("MCP 参数数组最多 32 项");
      return item.map((child) => visit(child, depth + 1));
    }
    if (!plain(item) || Object.keys(item).length > 40) throw new Error("MCP 参数对象格式无效或字段过多");
    const out = {};
    for (const [key, child] of Object.entries(item)) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(key) || unsafeArgument(key)) throw new Error("原生参数不能包含脚本、SQL、命令或凭据字段");
      out[key] = visit(child, depth + 1);
    }
    return out;
  }
  const normalized = visit(value, 0);
  if (JSON.stringify(normalized).length > 16000) throw new Error("MCP 参数总长度不能超过 16000 字符");
  return normalized;
}
export function nativeToolCompatibility(tool) {
  if (!tool || typeof tool.name !== "string") return { compatible: false, note: "工具当前不可用，请读取实际 MCP 参数" };
  const name = tool.name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const flat = name.replace(/[^a-z0-9]/g, "");
  if (/(?:^|[_\-.])(delete|remove|write|update|create|save|insert|drop|alter|execute|exec|run|shell|bash|powershell|send|publish|restart|stop|kill)(?:$|[_\-.])/.test(name)
      || /executesql|readcypher|writecypher/.test(flat)) return { compatible: false, note: "此工具需要已有受限模板或不属于原生只读查询，不执行任意 SQL、命令或写操作" };
  const annotations = tool.annotations ?? {};
  if (annotations.readOnlyHint === false || annotations.destructiveHint === true) return { compatible: false, note: "工具声明可能修改数据，不用于巡检原生查询" };
  if (annotations.readOnlyHint !== true && !/(?:^|[_\-.])(get|read|list|search|find|lookup|trace|inspect|describe|fetch|query)(?:$|[_\-.])/.test(name)) return { compatible: false, note: "工具尚未明确为查询接口，仅保存说明；执行仍需支持的只读工具" };
  const schema = tool.parameters ?? tool.inputSchema ?? tool.schema;
  if (!plain(schema) || (schema.type && schema.type !== "object")) return { compatible: false, note: "工具参数结构不是可识别的 JSON 对象" };
  const hasUnsafe = (node, depth = 0) => depth > 12 || (plain(node) && (Object.keys(node.properties ?? {}).some(unsafeArgument)
    || Object.values(node.properties ?? {}).some((property) => expressionDescription(property?.description))
    || Object.values(node).some((v) => typeof v === "object" && v !== null && hasUnsafe(v, depth + 1))))
    || (Array.isArray(node) && node.some((v) => hasUnsafe(v, depth + 1)));
  if (expressionDescription(tool.description) || hasUnsafe(schema)) return { compatible: false, note: "工具参数包含 SQL、脚本、命令或凭据，需继续使用受限模板" };
  return { compatible: true, note: "参数可用于原生查询；实际调用仍遵循 DSH 工具权限与审批策略" };
}
