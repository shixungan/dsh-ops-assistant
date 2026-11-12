import { randomUUID } from "node:crypto";
import { createQueryRuntime } from "./query-runtime.mjs";

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
  return analyze;
}
