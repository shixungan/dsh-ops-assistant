import { randomUUID } from "node:crypto";
import { createQueryRuntime } from "./query-runtime.mjs";
import { compileDictionaryQuery, assertDictionaryArguments, dictionaryFingerprint, validateDictionaryRows } from "./dictionary-query.mjs";
import { parseEvidenceRows } from "./query-evidence.mjs";
import { nativeResult } from "./native-query.mjs";

// rc.5 durable assistant/message stream contract. Do not collect reasoning or
// provisional stream deltas; only the final committed assistant message is used.
export function assistantText(stream) {
  if (!Array.isArray(stream))
    throw new Error("DSH assistant stream 格式不匹配");
  return stream
    .map((row) =>
      row.type === "text-chunks"
        ? row.texts.join("")
        : row.type === "chunk" && row.chunk?.type === "text-delta"
          ? row.chunk.text
          : "",
    )
    .join("");
}

export function createDshAnalyzer(ctx, options = {}) {
  // Only an in-process context can reuse an owned Agent, never a supplied id.
  const sessions = new WeakMap();
  const attachQueries = createQueryRuntime(ctx, options);
  function acquire(task) {
    const context = task.analysisContext && typeof task.analysisContext === "object"
      ? task.analysisContext : {};
    let record = sessions.get(context);
    if (!record) {
      record = { sessionId: null, active: false, failed: false, context };
      sessions.set(context, record);
      context.toolCallsUsed = 0;
    }
    if (record.active) throw new Error("本次巡检会话仍在执行，不能并发提交分析");
    if (record.failed) throw new Error("本次巡检会话已中断，请重新分析以创建新的会话");
    record.active = true;
    return record;
  }
  async function ensure(record, task, signal, onSession = () => {}) {
    signal.throwIfAborted();
    if (!record.sessionId) {
      const created = await ctx.sessionController.create({
        cwd: task.workspace,
        ...(task.agentPreset ? { agentPreset: task.agentPreset } : {}),
      });
      record.sessionId = created.sessionId;
      onSession(record.sessionId);
      if (ctx.sessionController.rename && typeof record.context.title === "string" && record.context.title.trim()) {
        try {
          await ctx.sessionController.rename({ sessionId: record.sessionId, title: record.context.title.trim().slice(0,120) });
        } catch { /* Optional title service does not affect execution. */ }
      }
      const agent = ctx.agents.get(record.sessionId);
      if (!agent?.ctx?.tools?.guard || !agent.ctx.tools.restrict)
        throw new Error("DSH Agent 工具策略接口不可用");
      record.agent = agent;
      record.queries = await attachQueries(agent, task, record.context);
    } else {
      if (ctx.agents.get(record.sessionId) !== record.agent)
        throw new Error("本次巡检会话已退出，请重新分析以创建新的受限会话");
      onSession(record.sessionId);
    }
    record.queries.formatOnly = task.formatOnly === true;
    signal.throwIfAborted();
  }
  async function analyze(prompt, task, signal, onSession) {
    signal.throwIfAborted();
    const record = acquire(task);
    try {
      await ensure(record, task, signal, onSession);
      record.queries.running = true;
      const sessionId = record.sessionId;
      signal.throwIfAborted();
      let finalText = "";
      let done = false;
      let removeListener;
      let removeAbort;
      const result = new Promise((resolve, reject) => {
        const finish = (error) => {
          if (done) return;
          done = true;
          removeListener?.();
          removeAbort?.();
          if (error) reject(error);
          else if (!finalText.trim()) reject(new Error("DSH 完成但没有最终文本"));
          else resolve(finalText);
        };
        removeListener = ctx.on("session/event", (session, event) => {
          if (session.id !== sessionId) return;
          try {
            if (event.type === "assistant/message")
              finalText = assistantText(event.data.stream);
            // A tool call invalidates preceding conversational text as a final answer.
            if (event.type === "tool/call") finalText = "";
            if (event.type === "turn/end")
              finish(
                event.data.reason?.kind === "completed"
                  ? null
                  : new Error(
                      `DSH 分析未正常完成：${event.data.reason?.kind ?? "unknown"}`,
                    ),
              );
          } catch (error) {
            finish(error);
          }
        });
        const abort = () => {
          try {
            Promise.resolve(ctx.sessionController.cancel({ sessionId })).catch(() => {});
          } catch {
            /* The session may have just ended. */
          }
          finish(new Error("分析被取消或超时，未生成完整报告"));
        };
        signal.addEventListener("abort", abort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) abort();
        else Promise.resolve().then(() => {
          signal.throwIfAborted();
          return ctx.sessionController.prompt(
            {
              sessionId,
              requestId: randomUUID(),
              mode: "queue",
              content: [{ type: "text", text: prompt }],
              clientTimeZone: "Asia/Shanghai",
            },
            signal,
          );
        }).catch(finish);
      });
      const text = await result;
      if (record.queries.stopError) throw record.queries.stopError;
      return text;
    } catch (error) {
      record.failed = true;
      throw error;
    } finally {
      if (record.queries) record.queries.running = false;
      record.active = false;
    }
  }
  analyze.prepare = async (run, task, signal, onSession, onProgress) => {
    signal.throwIfAborted();
    if (!run.alerts.length) return null;
    const record = acquire(task);
    try {
      await ensure(record, task, signal, onSession);
      return await record.queries.prepare(run, signal, onProgress);
    } catch (error) {
      record.failed = true;
      throw error;
    } finally {
      record.active = false;
    }
  };
  analyze.validateDictionary = async (entry, { workspace, agentPreset, sample = {} }, inputSignal) => {
    const started = Date.now(), control = new AbortController();
    const signal = inputSignal ? AbortSignal.any([inputSignal, control.signal]) : control.signal;
    const record = { sessionId: null, active: true, context: { title: `MCP字典验证 · ${entry.name}`, toolCallsUsed: 0 } };
    let fingerprint = "", timer;
    try {
      signal.throwIfAborted();
      if (typeof workspace !== "string" || !workspace.trim()) throw new Error("请选择字典验证工作目录");
      let args = compileDictionaryQuery(entry, sample, { validation: true });
      // This manual operation never submits a model prompt. Its separately named
      // session keeps the normal DSH policy/audit context for the bounded query.
      const task = { workspace, agentPreset, dictionaryValidationEntry: entry, queryPlan: { maxSupplementaryCalls: 0 } };
      timer = setTimeout(() => control.abort(new Error("字典验证超过15秒")),15000);
      await ensure(record, task, signal);
      const tool = record.queries.schemas.find((t) => t.name === entry.tool);
      args = compileDictionaryQuery(entry, sample, { validation: true, tool });
      assertDictionaryArguments(entry, tool, args);
      fingerprint = dictionaryFingerprint(tool);
      const result = await record.queries.invoke(entry.tool, args, signal);
      signal.throwIfAborted();
      if (record.queries.stopError) throw record.queries.stopError;
      let rows, fields, native;
      if (entry.purpose === "tool") {
        native = nativeResult(result); rows = native.rows; fields = native.fields;
        if (native.partial) throw new Error("验证结果过长或包含未显示的内容，请缩小参数范围后重新验证");
      } else if (["knowledge", "memory"].includes(entry.purpose)) {
        const text = result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (!text) rows = [];
        else {
          try { rows = parseEvidenceRows(result); }
          catch {
            let value;
            try { value = JSON.parse(text); } catch { /* Non-JSON text is a supported search result. */ }
            const list = value && typeof value === "object" && !Array.isArray(value)
              ? [value.results, value.items, value.matches, value.hits].find(Array.isArray) : null;
            if (value?.error) throw new Error("检索工具返回错误内容，未标记验证成功");
            rows = list ? list.map((item) => item && typeof item === "object" ? item : { text: String(item) }) : (value && typeof value === "object" && !Object.keys(value).length ? [] : [{ text }]);
          }
        }
        fields = rows.length ? Object.keys(rows[0]).slice(0,40) : [];
      } else {
        rows = parseEvidenceRows(result);
        validateDictionaryRows(entry.purpose, rows);
        fields = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0,40);
      }
      if (entry.purpose !== "tool" && rows.length > 5) throw new Error("工具返回超出5条验证样例上限，请核对数量参数与工具行为");
      return { status: rows.length ? "verified" : "empty", toolFingerprint: fingerprint, checkedAt: Date.now(), elapsedMs: Date.now()-started,
        rowCount: native?.rowCount ?? rows.length, fields, sessionId: record.sessionId,
        message: rows.length ? entry.purpose === "tool" ? "原生参数校验及可读响应通过；返回业务含义需按条目说明核对，未保存查询原文。" : "有限样例查询及必需返回字段通过；字段业务含义和历史适用性仍需核对，未保存实际返回数据。" : "查询执行成功但样例为空；尚未验证返回行字段与业务含义，运行时将继续检查。" };
    } catch (error) {
      return { status: "failed", toolFingerprint: fingerprint, checkedAt: Date.now(), elapsedMs: Date.now()-started, rowCount: 0, fields: [], sessionId: record.sessionId,
        message: String(signal.aborted ? signal.reason?.message ?? "字典验证已取消" : error.message).slice(0,400) };
    } finally {
      clearTimeout(timer);
      if (record.queries) { record.queries.concluded = true; record.queries.running = false; record.queries.formatOnly = true; record.queries.permits.clear(); }
      record.active = false;
    }
  };
  return analyze;
}
