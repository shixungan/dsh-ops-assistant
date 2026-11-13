import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";
import { normalizeQueryPlan, resolveQueryBindings } from "./query-plan.mjs";
import { createEvidenceCollector } from "./query-evidence.mjs";
import { resolveDictionary, compileDictionaryQuery, assertDictionaryArguments } from "./dictionary-query.mjs";

const stable = (v) => JSON.stringify(v, (_, value) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
const textResult = (value) => [{ type: "text", text: JSON.stringify(value) }];
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const errorText = (error) => String(error?.message ?? error).slice(0, 400);
const MAX_LOOKUP_CHARACTERS = 6000;
function alertPath(alert) {
  const raw = plain(alert.raw) ? alert.raw : {}, labels = { ...(plain(raw.labels) ? raw.labels : {}) };
  for (const tag of [...(Array.isArray(raw.original_tags) ? raw.original_tags : []), ...(Array.isArray(raw.tags) ? raw.tags : [])]) {
    if (typeof tag !== "string") continue;
    const split = tag.indexOf("=");
    if (split > 0) labels[tag.slice(0, split)] = tag.slice(split + 1);
  }
  const valid = (value) => typeof value === "string" && isIP(value) ? value : "";
  const src = valid(labels.srcip ?? raw.srcip), dst = valid(labels.dstip ?? raw.dstip ?? labels.target ?? raw.target);
  return src && dst ? `${src}→${dst}` : src || dst;
}
const defaultSdk = async () => {
  const [tools, pipeline] = await Promise.all([import("@deepseek-ai/dsh-tools"), import("@deepseek-ai/dsh-tools/pipeline")]);
  return { ...tools, ...pipeline };
};

// Fixed queries use the owning Agent's complete DSH policy pipeline, including
// approvals, cancellation and post-execute policies. The model is only shown
// the small scoped lookup tool; raw SQL/Cypher are never model capabilities.
export function createQueryRuntime(ctx, { loadSdk = defaultSdk } = {}) {
  const active = new AsyncLocalStorage();
  const definitions = new WeakMap();
  let definitionId = 0;
  const collector = createEvidenceCollector({ invoke: (name, args, signal) => {
    const record = active.getStore();
    if (!record) throw new Error("查询缺少巡检执行上下文");
    return record.invoke(name, args, signal);
  } });
  return async function attach(agent, task, context) {
    const plan = normalizeQueryPlan(task.queryPlan);
    const schemas = ctx.tools?.schemas?.(agent) ?? [];
    const resolved = resolveQueryBindings(plan, schemas);
    const dictionary = resolveDictionary(task, schemas);
    const permits = new Map();
    const record = {
      plan, schemas, resolved, dictionary, context, permits, running: false, formatOnly: task.formatOnly === true,
      evidence: null, run: null, notify: null, stopError: null, concluded: false, pendingLookups: new Set(),
    };
    const rawNames = task.dictionaryValidationEntry
      ? [task.dictionaryValidationEntry.tool]
      : [...new Set([...Object.values(resolved.bindings), ...Object.values(dictionary.entries).map((d) => d.tool)].filter(Boolean))];
    const globalNames = new Set((ctx.tools?.schemas?.() ?? []).map((t) => t.name));
    agent.ctx.tools.restrict({ allow: rawNames.filter((n) => globalNames.has(n)) });
    // Unlike the removed task allowlist, raw calls only execute when the plugin
    // issued that exact immutable query. Guessing a tool or call id grants nothing.
    agent.ctx.tools.guard((exec) => {
      if (exec.agent !== agent || typeof exec.token !== "symbol") return "查询不属于当前巡检会话";
      if (record.formatOnly || record.stopError || record.concluded) return "本轮查询已结束或仅允许格式修正";
      const permit = permits.get(exec.callId);
      if (permit && exec.name === permit.name && stable(exec.arguments) === permit.args) {
        if (permit.token !== undefined && permit.token !== exec.token) return "固定查询许可已使用";
        permit.token = exec.token;
        return undefined;
      }
      if (exec.name === "ops_lookup" && record.running && plan.maxSupplementaryCalls > 0) return undefined;
      return "巡检仅允许查询方案生成的固定请求；不开放任意工具、SQL、系统命令或新会话。";
    });
    const scopes = rawNames.map((name) => {
      const definition = ctx.tools?.get?.(name, agent);
      if (definition && typeof definition === "object") {
        if (!definitions.has(definition)) definitions.set(definition, ++definitionId);
        return [name, definitions.get(definition)];
      }
      return [name, schemas.find((s) => s.name === name)];
    });
    record.cacheScope = stable([task.agentPreset ?? "", task.queryPlanRef ?? null, task.queryDictionary ?? null, scopes]);
    // Lean/old test Hosts can still analyze raw alerts without loading a new
    // runtime. A configured MCP binding must never silently bypass the SDK.
    let sdk, pipeline;
    if (rawNames.length || agent.ctx.tools.setExecutor) {
      try { sdk = await loadSdk(); }
      catch (error) { throw new Error("查询方案需要 DSH >= 0.2.2-rc.1 提供的工具执行接口，请升级并重启 DSH", { cause: error }); }
      pipeline = new sdk.ToolExecutionPipeline(agent.ctx);
      if (!agent.ctx.tools.register || !agent.ctx.tools.setExecutor) throw new Error("DSH 不支持巡检查询方案工具，请升级并重启");
      agent.ctx.tools.register({
        name: "ops_lookup",
        description: "仅补查本批次同资产的已确认历史(memory)，或解释原告警中具体错误码(knowledge)。不接受SQL、工具名或任意检索词。普通ping无需查手册；历史结果只能作为待验证线索。",
        parameters: { type: "object", properties: { kind: { type: "string", enum: ["memory", "knowledge"] } }, required: ["kind"], additionalProperties: false },
        output: { schema: { type: "object", additionalProperties: true }, render: (_args, value) => textResult(value) },
        execute: (args, exec) => lookup(record, args, exec),
      });
      agent.ctx.tools.setExecutor({
        describe: (defs) => ({ schemas: defs.filter((d) => d.name === "ops_lookup" && (context.toolCallsUsed ?? 0) < plan.maxSupplementaryCalls && !record.formatOnly && !record.stopError && !record.concluded).map((d) => sdk.projectToolSchema(d, false)), knownNames: ["ops_lookup"] }),
        execute: (input) => {
          if (input.agent !== agent) throw new Error("查询不属于当前巡检会话");
          return sdk.executeToolBatch(input, pipeline, () => 1);
        },
      });
    }
    const forwardControl = (messages, concluded, outer) => {
      if (messages?.length) {
        const deliver = outer ? outer.deferContext?.bind(outer) : agent.inject?.bind(agent);
        if (!deliver) {
          record.stopError = new Error("查询执行政策要求额外上下文，但当前 DSH 无法保留；已停止本轮分析");
          throw record.stopError;
        }
        try { for (const message of messages) deliver(message); }
        catch (error) {
          record.stopError = new Error("查询政策上下文传递失败；已停止本轮分析", { cause: error });
          throw record.stopError;
        }
      }
      if (concluded) {
        record.concluded = true;
        if (outer && typeof outer.concludeTurn === "function") outer.concludeTurn();
        else {
          record.stopError = new Error("查询执行政策要求结束本轮，已停止后续分析");
          throw record.stopError;
        }
      }
    };
    record.invoke = async (name, args, signal, outer) => {
      if (record.stopError) throw record.stopError;
      if (record.formatOnly || record.concluded) throw new Error("本轮不再允许查询");
      if (!sdk || !rawNames.includes(name)) throw new Error("查询方案未找到可用执行接口");
      if (outer && (outer.agent !== agent || typeof outer.token !== "symbol")) throw new Error("补查缺少所属会话的执行上下文");
      if (outer) signal = AbortSignal.any([signal, outer.signal]);
      signal.throwIfAborted();
      const callId = randomUUID();
      permits.set(callId, { name, args: stable(args) });
      try {
        let result, hadAdditionalContexts = false;
        if (outer) {
          // Unlike a root batch, this preserves the enclosing execution identity
          // for policy and audit observers while retaining every pipeline stage.
          const prepared = await pipeline.prepare({
            callId, name, arguments: args, signal, agent, toolSet: outer.toolSet,
            parent: outer.token, rootCallId: outer.rootCallId ?? outer.callId,
          });
          const outcome = prepared.kind === "dispatch" ? await pipeline.dispatch(prepared.exec) : prepared;
          result = await pipeline.complete(prepared.exec, outcome);
          hadAdditionalContexts = Boolean(result.additionalContexts?.length);
          forwardControl(result.additionalContexts, result.concludesTurn === true, outer);
        } else {
          let batch;
          try {
            batch = await sdk.executeToolBatch({
              calls: [{ type: "tool-call", id: callId, name, arguments: JSON.stringify(args) }], signal, agent,
            }, pipeline, () => 1);
          } catch (error) {
            if (error?.partial) forwardControl(error.partial.additionalContexts, error.partial.concluded === true);
            throw error;
          }
          hadAdditionalContexts = Boolean(batch.additionalContexts?.length);
          forwardControl(batch.additionalContexts, batch.concluded === true);
          result = batch.results?.find((row) => row.callId === callId)?.result;
        }
        signal.throwIfAborted();
        if (!result || result.isError) throw new Error(result?.error?.message ?? "MCP 查询执行失败");
        if (!Array.isArray(result.content)) throw new Error("MCP 查询缺少最终可见内容");
        // A post-policy may redact content while retaining the execution-local
        // canonical value. Re-rendering value here would undo that redaction.
        return { content: result.content, cacheable: !hadAdditionalContexts && !record.concluded };
      } finally { permits.delete(callId); }
    };
    record.prepare = async (run, signal, notify) => {
      if (record.stopError) throw record.stopError;
      signal.throwIfAborted();
      record.run = run; record.notify = notify;
      record.evidence = await active.run(record, () => collector({
        run, task: { ...task, queryPlan: plan, queryCacheScope: record.cacheScope }, schemas, signal,
      }));
      if (task.queryPlanRef) record.evidence.selection = structuredClone(task.queryPlanRef);
      // The collector records ordinary query failures. A policy termination or
      // context delivery failure instead invalidates the entire analysis turn.
      if (record.stopError) throw record.stopError;
      signal.throwIfAborted();
      return record.evidence;
    };
    return record;
  };
}

async function lookup(record, args, exec) {
  exec.signal.throwIfAborted();
  if (!plain(args) || !["memory", "knowledge"].includes(args.kind) || Object.keys(args).some((key) => key !== "kind")) throw new Error("无效补查用途");
  if (!record.run || !record.evidence || !record.running || record.formatOnly || record.concluded) throw new Error("只能在当前巡检分析中补查");
  if (record.stopError) throw record.stopError;
  const { kind } = args, { plan, context } = record;
  const id = `lookup-${kind}`;
  const existing = record.evidence.evidence.find((e) => e.id === id);
  if (existing) return { ...existing, reused: true };
  if (record.pendingLookups.has(kind)) throw new Error("同一用途的补查正在执行，请等待已有结果");
  const used = Number.isInteger(context.toolCallsUsed) && context.toolCallsUsed >= 0 ? context.toolCallsUsed : 0;
  if (used >= plan.maxSupplementaryCalls) return { status: "unavailable", note: "补查次数已用完，请依据已有证据完成分析" };
  const selected = record.dictionary.entries[kind];
  const tool = selected ? selected.tool : record.resolved.bindings[kind];
  const purpose = kind === "memory" ? "同资产历史案例" : "原告警错误码解释";
  const before = Date.now();
  context.toolCallsUsed = used + 1;
  record.pendingLookups.add(kind);
  const control = new AbortController();
  let status = "ok", rows = [], note = "", timer, invoked = false;
  try {
    if (!tool) throw new Error(selected?.note ?? "未发现唯一兼容工具，请在查询方案中指定该用途");
    const alerts = record.run.alerts ?? [];
    const codes = [...new Set(alerts.flatMap((a) => `${a.title ?? ""} ${a.raw?.description ?? ""} ${a.raw?.rule_note ?? ""}`.match(/\b(?:[A-Z][A-Z0-9_]{1,24}[-_/]\d{2,10}|ERR_[A-Z0-9_]{2,40}|0x[0-9A-Fa-f]{4,12})\b/g) ?? []))].slice(0,5);
    const entities = [...new Set(alerts.map((a) => a.host).filter((host) => typeof host === "string")
      .map((host) => host.trim()).filter((host) => host && host.length <= 200 && !/[\x00-\x1f\x7f]/.test(host)))].sort().slice(0,8);
    const paths = [...new Set(alerts.map(alertPath).filter(Boolean))].sort().slice(0,8);
    if (kind === "knowledge" && !codes.length) throw new Error("原告警没有可定位的具体错误码，跳过手册检索");
    if (kind === "memory" && !entities.length && !paths.length) throw new Error("缺少明确资产或路径标识，跳过宽泛历史搜索");
    // Include the original directed endpoints: a shared probe alone does not
    // make historical incidents on different destination paths related.
    const query = kind === "knowledge" ? codes.join(" ") : `${paths.join(" ")} ${entities.join(" ")} 已确认 故障原因`;
    const definition = record.schemas.find((t) => t.name === tool);
    const schema = definition?.parameters ?? definition?.inputSchema ?? definition?.schema ?? {};
    const props = schema.properties ?? {};
    const key = ["query", "keyword", "query_text"].find((k) => props[k]?.type === "string");
    if (!key) throw new Error("补查工具检索参数不兼容");
    const input = selected ? compileDictionaryQuery(selected.entry, { query: query.slice(0,1000) }, { tool: definition }) : { [key]: query.slice(0,1000) };
    if (selected) assertDictionaryArguments(selected.entry, definition, input);
    else {
      for (const k of ["limit", "top_k", "topK", "max_results"]) if (["integer", "number"].includes(props[k]?.type)) input[k] = 3;
      if ((schema.required ?? []).some((k) => !Object.hasOwn(input,k))) throw new Error("补查工具还要求未配置的参数，未猜测账号或知识库范围");
    }
    const signal = AbortSignal.any([exec.signal, control.signal]);
    timer = setTimeout(() => control.abort(new Error(`查询超过 ${plan.queryTimeoutSeconds} 秒`)), plan.queryTimeoutSeconds * 1000);
    invoked = true;
    const result = await record.invoke(tool, input, signal, exec);
    signal.throwIfAborted();
    const blocks = result.content.filter((block) => block?.type === "text" && typeof block.text === "string");
    const content = blocks.map((block) => block.text).join("\n");
    if (!content.trim()) throw new Error("补查未返回可用文本，未将其解释为没有历史或文档");
    const shortened = content.length > MAX_LOOKUP_CHARACTERS, omittedBlocks = blocks.length !== result.content.length;
    status = shortened || omittedBlocks ? "partial" : "ok";
    rows = [{ text: content.slice(0, MAX_LOOKUP_CHARACTERS) }];
    note = [kind === "memory" ? "历史案例不是本次根因证据，须核验来源与时间" : "文档解释不代表本次故障已验证",
      shortened ? "结果过长已截断" : "", omittedBlocks ? "含非文本内容，未纳入本次证据" : ""].filter(Boolean).join("；");
  } catch (error) {
    exec.signal.throwIfAborted();
    if (record.stopError) throw record.stopError;
    status = control.signal.aborted ? "timeout" : invoked ? "failed" : "unavailable";
    note = errorText(error);
  } finally {
    clearTimeout(timer);
    record.pendingLookups.delete(kind);
  }
  const evidence = { id, purpose, status, rows, note, observedAt: Date.now() };
  if (selected?.status === "ready" && status !== "ok") {
    const dictionaryRow = record.evidence.dictionary?.find((item) => item.purpose === kind);
    if (dictionaryRow) { dictionaryRow.status = status; dictionaryRow.note = `本轮字典补查${invoked ? "结果" : "未执行"}：${note}`; }
  }
  record.evidence.evidence.push(evidence);
  record.evidence.queries.push({ id, purpose, tool: tool ?? "", status, elapsedMs: Date.now()-before, rowCount: rows.length,
    resultBytes: rows.length ? Buffer.byteLength(JSON.stringify(rows)) : 0, cacheHit: false, note,
    ...["failed", "timeout"].includes(status) ? { error: note } : {},
  });
  record.notify?.(record.evidence);
  return evidence;
}
