const dateFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const date = (value) => dateFormat.format(new Date(value));
const time = (value) => timeFormat.format(new Date(value));
const plain = (value) => String(value ?? "")
  .replace(/\[(\d{1,3}(?:\.\d{1,3}){3})\]\(https?:\/\/\1\/?\)/g, "$1")
  .replace(/\s+/g, " ").trim();
const escape = (value) => value.replace(/[\\`*_\[\]<>#!|~]/g, "\\$&");

// A prefix can drop a later negation. New analyses are written briefly;
// legacy long fields stay intact in the local report, never cut mid-sentence.
function text(value, limit, fallback = "") {
  const output = escape(plain(value));
  return output && output.length <= limit ? output : escape(fallback);
}

function windowText(run) {
  if (![run.start, run.end].every(Number.isFinite)) return "时间窗未提供";
  const sameDay = date(run.start) === date(run.end);
  return `${date(run.start)} ${time(run.start)} — ${sameDay ? "" : `${date(run.end)} `}${time(run.end)}（北京时间）`;
}

function recordText(alerts, start) {
  const times = alerts.map((alert) => alert.eventTime ?? alert.first).filter(Number.isFinite);
  const first = times.length ? times.reduce((a, b) => Math.min(a, b)) : null;
  const stamp = first == null ? "" :
    `记录时间 ${Number.isFinite(start) && date(first) === date(start) ? "" : `${date(first)} `}${time(first)} · `;
  return `${stamp}${alerts.length} 条告警`;
}

function eventRows(run, complete) {
  if (complete) {
    const alerts = new Map(run.alerts.map((alert) => [alert.alertId, alert]));
    return (run.report.incidents ?? []).map((incident) => ({
      ...incident,
      alerts: [...new Set(incident.alertIds ?? [])].map((id) => alerts.get(id)).filter(Boolean),
    }));
  }
  const groups = new Map();
  for (const alert of run.alerts) {
    const key = JSON.stringify([alert.title ?? "", alert.host ?? ""]);
    if (!groups.has(key)) groups.set(key, { title: alert.title || "未命名告警", alerts: [] });
    groups.get(key).alerts.push(alert);
  }
  return [...groups.values()];
}

function correlationText(run, limit) {
  if (plain(run.report.correlation)) {
    return text(run.report.correlation, limit, "关联结论较长，请按巡检 ID 查阅；此处不作简化推断。");
  }
  if (run.alerts.length === 1) return "仅 1 条告警，无跨事件关联依据。";
  return "旧报告未单列事件关联分析，请按巡检 ID 查阅原分析。";
}

// One bounded Markdown card. No model calls, session creation or report writes.
// Delivery idempotency and empty-window silence remain enforced by Engine.
export function deliveryText(run, maxChars = 3500) {
  const complete = run.status === "completed" && !!run.report;
  const events = eventRows(run, complete);
  const hasGap = (run.sources ?? []).some((source) => source.status !== "ok");
  const footer = `巡检 ID：${escape(plain(run.id))}`;

  function render(brief = false) {
    const limits = brief
      ? { summary: 120, title: 60, assessment: 100, unknowns: 70, correlation: 110, action: 65 }
      : { summary: 260, title: 110, assessment: 260, unknowns: 140, correlation: 240, action: 110 };
    const shown = events.slice(0, brief ? 1 : 3);
    const conclusion = complete
      ? text(run.report.summary, limits.summary, "结论较长，请按巡检 ID 查看完整判断。")
      : `分析未完成，当前仅确认收到 ${run.alerts.length} 条告警。`;
    const eventLines = shown.map((event, index) => [
      `**${index + 1}. ${text(event.title, limits.title, `事件 ${index + 1}（标题较长）`)}**`,
      recordText(event.alerts, run.start),
    ].join("\n"));
    if (events.length > shown.length) eventLines.push(`另有 ${events.length - shown.length} 个事件未展开。`);
    if (!events.length) eventLines.push("未收到可展示的告警事件。");
    const analysis = complete
      ? shown.map((event, index) => {
        const unknowns = [...new Set((event.unknowns ?? []).map(plain).filter(Boolean))];
        return [
          `**${index + 1}.** ${text(event.assessment, limits.assessment, "分析内容较长，请按巡检 ID 查阅。")}`,
          ...(unknowns.length ? [`待核实：${text(unknowns.join("；"), limits.unknowns, "仍有未验证事项，尚不能形成完整判断。")}`] : []),
        ].join("\n");
      }).join("\n\n") || "暂无可分析事件。"
      : "暂无有效分析结果，故障原因与影响尚未确认。";
    const actions = complete
      ? [...new Set(events.flatMap((event) => event.actions ?? []).map(plain).filter(Boolean))]
      : ["核对告警对应资产和监控指标。", "重试本次巡检分析。"];
    // Never turn a conditional action into an unconditional one by clipping.
    const actionRows = actions.slice(0, 3).map((action, index) =>
      `${index + 1}. ${text(action, limits.action, "该项建议较长，请按巡检 ID 查阅后执行。")}`);
    if (!actions.length) actionRows.push("暂无进一步建议。");
    if (actions.length > 3) actionRows.push(`另有 ${actions.length - 3} 项建议未展开。`);
    return [
      `**一、结论**\n${conclusion}${hasGap ? "\n本次数据不完整，结论仅针对已收到的告警。" : ""}`,
      `**二、事件**\n${text(run.task?.name, 90, "运维巡检")} · ${run.alerts.length} 条告警 · ${events.length} 个事件\n${windowText(run)}\n\n${eventLines.join("\n\n")}`,
      `**三、事件分析**\n${analysis}`,
      `**四、事件关联分析**\n${complete ? correlationText(run, limits.correlation) : "暂无有效关联结论。"}`,
      `**五、下一步建议动作**\n${actionRows.join("\n")}`,
      footer,
    ].join("\n\n");
  }

  const full = render();
  if (full.length <= maxChars) return full;
  const brief = render(true);
  if (brief.length <= maxChars) return brief;
  // Preserve headings and ID even with a caller's unusually small budget.
  const minimal = [
    "**一、结论**\n消息空间不足，未展示分析结论。",
    `**二、事件**\n${run.alerts.length} 条告警 · ${events.length} 个事件`,
    "**三、事件分析**\n未展开。",
    "**四、事件关联分析**\n未展开，不能据此判断关联。",
    "**五、下一步建议动作**\n按巡检 ID 查阅完整建议。",
    ...(hasGap ? ["本次数据不完整。"] : []),
    footer,
  ].join("\n\n");
  if (minimal.length <= maxChars) return minimal;
  throw new RangeError("消息长度预算不足，无法完整保留五段内容与巡检 ID");
}
