import { randomUUID } from "node:crypto";

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

export function createDshAnalyzer(ctx) {
  // Only an in-process execution context can reuse an owned Session. Never
  // accept a persisted/user-supplied Session id or share it across inspections.
  const sessions = new WeakMap();
  return async function analyze(prompt, task, signal, onSession) {
    signal.throwIfAborted();
    const context = task.analysisContext && typeof task.analysisContext === "object"
      ? task.analysisContext : {};
    let record = sessions.get(context);
    if (!record) {
      const requestedLimit = task.maxToolCalls ?? 8;
      record = {
        sessionId: null, active: false, failed: false, calls: new Set(),
        callLimit: Number.isInteger(requestedLimit) && requestedLimit >= 0 && requestedLimit <= 50
          ? requestedLimit : 8,
        allow: new Set((task.formatOnly ? [] : task.allowedTools ?? [])
          .filter((name) => name !== "run_code")),
      };
      sessions.set(context, record);
      context.toolCallsUsed = 0;
      context.callLimit = record.callLimit;
    }
    if (record.active) throw new Error("本次巡检会话仍在执行，不能并发提交分析");
    if (record.failed) throw new Error("本次巡检会话已中断，请重新分析以创建新的会话");
    record.active = true;
    try {
      if (!record.sessionId) {
        const created = await ctx.sessionController.create({
          cwd: task.workspace,
          ...(task.agentPreset ? { agentPreset: task.agentPreset } : {}),
        });
        record.sessionId = created.sessionId;
        onSession(record.sessionId);
        if (ctx.sessionController.rename && typeof context.title === "string" && context.title.trim()) {
          try {
            await ctx.sessionController.rename({
              sessionId: record.sessionId, title: context.title.trim().slice(0, 120),
            });
          } catch {
            // Older/lean Hosts may omit the title service. Analysis still works.
          }
        }
        const agent = ctx.agents.get(record.sessionId);
        if (!agent?.ctx?.tools?.guard || !agent.ctx.tools.restrict)
          throw new Error("DSH Agent 工具策略接口不可用");
        record.agent = agent;
        // These policies stay attached to the owned Agent, including when a
        // user later opens it. Install only once; repeated restrictions would
        // accumulate intersections across the run's sequential prompts.
        agent.ctx.tools.restrict({ allow: [...record.allow] });
        agent.ctx.tools.guard((exec) => {
          if (record.formatOnly)
            return "格式修正会话不允许调用工具，只能整理已有回复。";
          if (exec.name !== "run_code" && !record.allow.has(exec.name))
            return "运维任务未授权此工具。仅可使用任务明确选择的查询工具。";
          // PTC shares rootCallId among its inner calls. Count each actual
          // authorized execution, using the pipeline's unique token instead.
          const key = exec.token ?? exec.callId ?? exec;
          if (exec.name !== "run_code" && record.calls.has(key)) return undefined;
          if (record.calls.size >= record.callLimit)
            return `本次巡检已用完 ${record.callLimit} 次查询预算。停止调用工具，依据已有证据直接输出最终 JSON；未验证的内容写入 unknowns。`;
          if (exec.name !== "run_code") {
            record.calls.add(key);
            context.toolCallsUsed = record.calls.size;
          }
          return undefined;
        });
      } else {
        if (ctx.agents.get(record.sessionId) !== record.agent)
          throw new Error("本次巡检会话已退出，请重新分析以创建新的受限会话");
        onSession(record.sessionId);
      }
      record.formatOnly = task.formatOnly === true;
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
      return await result;
    } catch (error) {
      record.failed = true;
      throw error;
    } finally {
      record.active = false;
    }
  };
}
