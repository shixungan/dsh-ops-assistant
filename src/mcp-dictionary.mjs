import { randomUUID } from "node:crypto";
import { DICTIONARY_PURPOSES, EXECUTABLE_PURPOSES, defaultDictionaryRecipe, normalizeDictionaryRecipe, dictionaryEntryIds, dictionaryToolCompatible, nativeToolCompatibility } from "./dictionary-defs.mjs";

const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const TEXT_FIELDS = ["description", "dataObjects", "inputs", "outputs", "relationships", "timeSemantics", "limitations"];
function text(value, label, max, fallback = "") {
  const out = value ?? fallback;
  if (typeof out !== "string" || out.length > max || /\x00/.test(out)) throw new Error(`${label}须为不超过 ${max} 字的文本`);
  return out.trim();
}
export function dictionaryDraft(input = {}, existing, toolDefinition) {
  if (!plain(input)) throw new Error("数据字典格式无效");
  const tool = text(input.tool, "工具名", 300, existing?.tool);
  const changedTool = Boolean(existing?.tool && tool !== existing.tool);
  const mismatchedTemplate = Boolean(existing && !["tool", "reference"].includes(existing.purpose) && toolDefinition && !dictionaryToolCompatible(existing.purpose, toolDefinition) && nativeToolCompatibility(toolDefinition).compatible);
  const changed = changedTool || mismatchedTemplate;
  const purpose = changed ? (tool ? "tool" : "reference") : input.purpose ?? (existing?.purpose === "reference" && tool ? "tool" : existing?.purpose) ?? (tool ? "tool" : "reference");
  if (!DICTIONARY_PURPOSES.some((p) => p.id === purpose)) throw new Error("不支持的数据用途");
  const name = text(input.name, "字典名称", 200, existing?.name);
  if (!name) throw new Error("字典名称不能为空");
  if (/[\x00-\x1f]/.test(tool)) throw new Error("工具名包含无效字符");
  const out = { name, purpose, tool };
  for (const key of TEXT_FIELDS) out[key] = text(input[key], key, 2000, existing?.[key]);
  out.document = text(input.document, "参考文档", 16000, existing?.document);
  const suggested = purpose === "tool" && toolDefinition ? nativeRecipeSuggestion(toolDefinition) : undefined;
  const recipe = changed ? (purpose === "tool" && plain(input.recipe?.arguments) ? input.recipe : suggested)
    : input.recipe ?? (purpose === existing?.purpose ? existing.recipe : suggested);
  out.recipe = normalizeDictionaryRecipe(purpose, recipe);
  return out;
}
export function dictionaryEntry(input, existing, { now = Date.now(), toolDefinition } = {}) {
  if (Object.hasOwn(input, "validation")) throw new Error("验证结果由服务端维护，请勿在保存内容中提交 validation");
  if (existing && input.revision !== existing.revision) throw new Error("数据字典已被修改，请刷新后重试");
  const entry = { ...dictionaryDraft(input, existing, toolDefinition), id: existing?.id ?? randomUUID(), revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now };
  if (toolDefinition) {
    entry.inputSchema = schemaSnapshot(toolDefinition.parameters ?? toolDefinition.inputSchema ?? toolDefinition.schema ?? {});
    entry.outputSchema = schemaSnapshot(toolDefinition.outputSchema ?? toolDefinition.output?.schema ?? {});
  }
  entry.validation = { status: "unverified", revision: entry.revision, checkedAt: null, message: "请核对数据含义后执行查询验证；保存修改会使原验证失效" };
  return entry;
}
export function defaultMcpDictionary(now = 0) {
  const notes = {
    assets: { dataObjects: "public.cmdb_online_ip_switch_port_current", inputs: "告警明确提供的主机 IP；每批按 IP 去重", outputs: "ip_address 是主机 IP；asset_name 是资产名；switch_hostname 是接入交换机；switch_mgmt_ip 是交换机管理 IP；physical_if_name 是接入接口。歧义字段为 true 时不能选择唯一映射。", relationships: "使用 switch_hostname 关联拓扑 Switch.hostname 和交换机事件，不能把主机 IP 当作交换机管理地址", timeSemantics: "当前采集快照；cmdb_observed_at、arp_observed_at、fdb_observed_at 为采集时间，不证明告警窗口当时状态", limitations: "同 IP 不同 VRF 或接入位置可能有多条映射；资产映射可短期缓存，在线状态不能跨轮当证据" },
    paths: { dataObjects: "Neo4j Switch 节点及 CONNECTED_TO 关系", inputs: "CMDB 归一后的源/目的交换机名称", outputs: "src、dst 为交换机名；switches 为候选路径节点；links 为链路端口及采集时间", relationships: "节点 hostname 对应资产映射 switch_hostname；路径设备用于限定窗口事件查询", timeSemantics: "当前拓扑，last_seen_at / last_checked_at 为观测或检查时间", limitations: "最多 8 跳；候选路径不是实际流量路径，active 不代表告警窗口内链路正常" },
    events: { dataObjects: "public.switch_if_up_down_info、public.switch_ip_up_down_info、public.switch_message_info", inputs: "相关交换机名称与本批次 [start,end) 时间窗", outputs: "kind、id、host、interface、event、detail、event_time；按设备名精确匹配", relationships: "host 对应资产/候选路径中的交换机 hostname", timeSemantics: "端口/设备表使用 observed_at；syslog 使用 inserted_at（入库时间）。请核对数据库时区及实际字段业务语义", limitations: "没有日志不等于链路正常；本模板不提供错误/丢弃计数及带宽利用率；窗口数据不跨轮缓存" },
    knowledge: { dataObjects: "WeKnora 或兼容只读搜索 MCP 的文档库", inputs: "原告警中具体错误码；可在固定参数中填写知识库 ID", outputs: "相关说明与来源，具体结构取决于搜索服务", relationships: "将错误码解释与本轮观测核对", timeSemantics: "文档版本/发布日期需核对设备适用版本", limitations: "文档解释不能证明本次根因；普通 ping 不进行宽泛手册检索" },
    memory: { dataObjects: "MemOS 或兼容只读搜索 MCP 的经验库", inputs: "本批次明确资产、路径和告警标题", outputs: "带来源、发生时间和确认依据的历史案例", relationships: "相同资产的案例仅作为待验证线索", timeSemantics: "历史事件时间与当前告警窗口分开，不能沿用旧恢复结论", limitations: "成功检索不等于经验已经证实；不自动写入模型推测，不复用历史在线状态" },
  };
  return EXECUTABLE_PURPOSES.map((purpose) => {
    const definition = DICTIONARY_PURPOSES.find((p) => p.id === purpose);
    const entry = dictionaryEntry({ name: definition.name, purpose, tool: "", description: `内置${definition.name}说明，请选择实际 MCP 并核对后验证`, ...notes[purpose], recipe: defaultDictionaryRecipe(purpose) }, undefined, { now });
    entry.id = `builtin-dictionary-${purpose}`;
    return entry;
  });
}
export function migrateMcpDictionary(settings, { now = Date.now() } = {}) {
  const result = structuredClone(settings);
  if (!Object.hasOwn(result, "mcpDictionary")) result.mcpDictionary = defaultMcpDictionary(now);
  if (!Array.isArray(result.mcpDictionary) || result.mcpDictionary.length > 100) throw new Error("数据字典库须为最多 100 项的列表");
  const ids = new Set();
  for (const entry of result.mcpDictionary) {
    if (typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) throw new Error("数据字典 ID 无效或重复");
    ids.add(entry.id);
  }
  return result;
}
export function validateDictionaryReferences(plan, entries, existing) {
  const ids = dictionaryEntryIds(plan), previous = dictionaryEntryIds(existing ?? {}), templates = new Set();
  for (const id of ids) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) throw new Error("请选择现有数据字典");
    if (!Object.hasOwn(plan, "dictionaryIds") && !["tool", "reference"].includes(entry.purpose) && plan.dictionaryBindings?.[entry.purpose] !== id) throw new Error("请选择用途匹配的现有数据字典");
    if (EXECUTABLE_PURPOSES.includes(entry.purpose)) {
      if (templates.has(entry.purpose)) throw new Error("同一旧版自动取证步骤只能选择一个模板条目；原生 MCP 条目可以选择多个");
      templates.add(entry.purpose);
    }
    if (entry.purpose !== "reference" && !previous.includes(id) && (!["verified", "empty"].includes(entry.validation?.status) || entry.validation?.revision !== entry.revision)) throw new Error("新引用的数据字典须先通过查询验证");
  }
}
export function freezeDictionary(plan, entries) {
  const ids = dictionaryEntryIds(plan);
  // Missing entries remain missing in the snapshot; runtime records the gap and
  // never silently substitutes the old template for an explicit reference.
  return structuredClone(ids.map((id) => entries.find((entry) => entry.id === id)).filter(Boolean));
}
function schemaSnapshot(value) {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > 64000) throw new Error("工具参数结构超过保存上限");
  return JSON.parse(serialized);
}
export function nativeRecipeSuggestion(tool) {
  const schema = tool.parameters ?? tool.inputSchema ?? tool.schema ?? {}, args = {};
  const aliases = { srcip: "srcip", sourceip: "srcip", dstip: "dstip", destinationip: "dstip", ip: "ip", ipaddress: "ip", host: "host", hostname: "host" };
  const example = (s, depth = 0) => {
    if (depth > 4) return null;
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
    if (s.type === "object") return Object.fromEntries((s.required ?? []).filter((key) => s.properties?.[key]).slice(0, 15).map((key) => [key, example(s.properties[key], depth + 1)]));
    if (s.type === "array") return [];
    if (s.type === "boolean") return false;
    if (["integer", "number"].includes(s.type)) return Number.isFinite(s.minimum) ? s.minimum : 0;
    return "";
  };
  for (const [key, definition] of Object.entries(schema.properties ?? {}).slice(0, 40)) {
    const alias = aliases[key.toLowerCase().replaceAll("_", "")];
    if (alias) args[key] = `{{alert.${alias}}}`;
    else if ((schema.required ?? []).includes(key)) args[key] = example(definition);
  }
  // Unavailable/script tools can still be described; never generate executable
  // parameter recipes for them merely because their schema contains defaults.
  return nativeToolCompatibility(tool).compatible ? { arguments: args } : { arguments: {} };
}
export function describeDictionaryTool(tool) {
  if (!tool) throw new Error("MCP 工具当前不可用，请检查完整工具名和连接");
  const compatibility = nativeToolCompatibility(tool);
  return { tool: tool.name, description: String(tool.description ?? "").slice(0, 4000),
    inputSchema: schemaSnapshot(tool.parameters ?? tool.inputSchema ?? tool.schema ?? {}), outputSchema: schemaSnapshot(tool.outputSchema ?? tool.output?.schema ?? {}),
    recipe: nativeRecipeSuggestion(tool), nativeCompatible: compatibility.compatible, compatibilityNote: compatibility.note,
    compatible: compatibility.compatible, reason: compatibility.note };
}
export function discoverDictionary(tools) {
  return tools.slice(0, 500).map(describeDictionaryTool);
}
export function importDictionary(textInput) {
  if (typeof textInput !== "string" || !textInput.trim() || textInput.length > 64000) throw new Error("导入文档须为 1—64000 字文本");
  const trimmed = textInput.trim();
  let parsed;
  if (/^[\[{]/.test(trimmed)) {
    try { parsed = JSON.parse(trimmed); } catch { throw new Error("导入 JSON 格式无效"); }
  } else if (/^```(?:json|mcp-dictionary)\s*\n[\s\S]*\n```$/.test(trimmed)) {
    try { parsed = JSON.parse(trimmed.replace(/^```[^\n]*\n/, "").replace(/\n```$/, "")); } catch { throw new Error("导入 JSON 代码块格式无效"); }
  }
  if (parsed !== undefined) {
    if (!plain(parsed) && !Array.isArray(parsed)) throw new Error("导入 JSON 须为字典对象或数组");
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : [parsed];
    if (!entries.length || entries.length > 20) throw new Error("一次最多导入 20 个字典草稿");
    // Only editable fields are extracted. Never accept imported IDs or trust.
    return { drafts: entries.map((entry) => dictionaryDraft(entry)) };
  }
  if (trimmed.length > 16000) throw new Error("单篇 Markdown 文档最多 16000 字");
  const fields = { "用途": "purpose", "工具": "tool", "描述": "description", "数据对象": "dataObjects", "输入": "inputs", "输出": "outputs", "关联关系": "relationships", "时间口径": "timeSemantics", "限制": "limitations", "查询模板": "recipe", "调用参数": "arguments" };
  const draft = { name: /^#\s+(.+)$/m.exec(trimmed)?.[1]?.trim() ?? "导入数据说明", document: trimmed };
  const sections = [...trimmed.matchAll(/^##\s+([^\n]+)\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/gm)];
  for (const section of sections) {
    const key = fields[section[1].trim()]; if (!key) continue;
    const value = section[2].trim();
    if (key === "recipe" || key === "arguments") {
      try { const parsed = JSON.parse(value.replace(/^```(?:json)?\s*\n/, "").replace(/\n```$/, "")); draft.recipe = key === "arguments" ? { arguments: parsed } : parsed; }
      catch { throw new Error("查询模板须为声明式 JSON；不会执行文档内 SQL 或代码"); }
    } else draft[key] = value;
  }
  return { drafts: [dictionaryDraft(draft)] };
}
export function checkedValidation(result, entry, { now = Date.now() } = {}) {
  if (!plain(result) || !["verified", "empty", "failed"].includes(result.status)) throw new Error("查询验证返回格式无效");
  if (["verified", "empty"].includes(result.status) && (!/^[a-f0-9]{64}$/.test(result.toolFingerprint ?? "") || !Number.isSafeInteger(result.rowCount) || result.rowCount < (result.status === "verified" ? 1 : 0))) throw new Error("查询验证缺少结构指纹或可核验结果");
  return {
    status: result.status, revision: entry.revision, checkedAt: now,
    toolFingerprint: typeof result.toolFingerprint === "string" ? result.toolFingerprint.slice(0, 100) : "",
    elapsedMs: Math.max(0, Math.min(Number(result.elapsedMs) || 0, 86400000)),
    rowCount: Math.max(0, Math.min(Number(result.rowCount) || 0, 1000)),
    fields: Array.isArray(result.fields) ? result.fields.filter((v) => typeof v === "string").slice(0, 64).map((v) => v.slice(0, 100)) : [],
    message: text(result.message, "验证说明", 2000),
    ...(typeof result.sessionId === "string" ? { sessionId: result.sessionId.slice(0, 200) } : {}),
  };
}
