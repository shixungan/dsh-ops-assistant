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
  return async function analyze(prompt, task, signal, onSession) {
    signal.throwIfAborted();
    const created = await ctx.sessionController.create({
      cwd: task.workspace,
      ...(task.agentPreset ? { agentPreset: task.agentPreset } : {}),
    });
    const sessionId = created.sessionId;
    onSession(sessionId);
    const agent = ctx.agents.get(sessionId);
    if (!agent?.ctx?.tools?.guard || !agent.ctx.tools.restrict)
      throw new Error("DSH rc.5 的 Agent 工具策略接口不可用");
    const allow = new Set(task.allowedTools ?? []);
    // run_code is DSH's PTC transport; every nested tool also passes the guard.
    agent.ctx.tools.restrict({ allow: [...allow] });
    agent.ctx.tools.guard((exec) =>
      exec.name === "run_code" || allow.has(exec.name)
        ? undefined
        : "运维任务未授权此工具。仅可使用任务明确选择的查询工具。",
    );
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
          ctx.sessionController.cancel({ sessionId });
        } catch {
          /* The session may have just ended. */
        }
        finish(new Error("分析被取消或超时，未生成完整报告"));
      };
      signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
      else
        Promise.resolve(
          ctx.sessionController.prompt(
            {
              sessionId,
              requestId: randomUUID(),
              mode: "queue",
              content: [{ type: "text", text: prompt }],
              clientTimeZone: "Asia/Shanghai",
            },
            signal,
          ),
        ).catch(finish);
    });
    return await result;
  };
}
