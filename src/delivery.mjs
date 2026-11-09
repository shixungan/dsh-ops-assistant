import { coverageWarnings } from "./coverage.mjs";

const dateFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const date = (value) => dateFormat.format(new Date(value));
const time = (value) => timeFormat.format(new Date(value));
const take = (value, length) => value.slice(0, Math.max(0, length)).replace(/[\uD800-\uDBFF]$/, "");
const plain = (value) => String(value ?? "")
  .replace(/\[(\d{1,3}(?:\.\d{1,3}){3})\]\(https?:\/\/\1\/?\)/g, "$1")
  .replace(/\s+/g, " ").trim();
const escape = (value) => value.replace(/[\\`*_\[\]<>]/g, "\\$&");

// One bounded Markdown message. The DSH-IM host renders this as a native card
// on Feishu; do not retry as plain text when the original send is uncertain.
export function deliveryText(run, maxChars = 3500) {
  let shortened = false;
  const text = (value, limit) => {
    const valueText = plain(value);
    if (valueText.length > limit) shortened = true;
    return escape(valueText.length > limit ? `${take(valueText, limit - 1)}…` : valueText);
  };
  const complete = run.status === "completed" && !!run.report;
  const incidents = complete ? run.report.incidents ?? [] : [];
  const sameDay = date(run.start) === date(run.end);
  const window = `${date(run.start)} ${time(run.start)} — ${sameDay ? "" : `${date(run.end)} `}${time(run.end)}`;
  const sourceCounts = run.sources.map((s) => `${s.name} ${s.count ?? 0} 条`).join(" · ");
  const header = [
    `**${complete ? "🔔" : "⚠️"} 运维巡检**`,
    `${window}（北京时间）`,
    ...(run.task?.name ? [`任务：${text(run.task.name, 60)}`] : []),
    `告警 **${run.alerts.length}** 条${complete ? ` · 事件 **${incidents.length}** 个 · AI 分析完成` : ""}`,
    `来源：${text(sourceCounts, 220)}`,
  ].join("\n");

  const sections = [];
  if (complete) {
    sections.push(`**分析结论**\n${text(run.report.summary, 420)}`);
    const eventLines = incidents.slice(0, 3).map((incident, index) => {
      const ids = new Set(incident.alertIds);
      const alerts = run.alerts.filter((alert) => ids.has(alert.alertId));
      const hosts = [...new Set(alerts.map((alert) => alert.host).filter(Boolean))];
      const levels = [...new Set(alerts.map((alert) => alert.severity).filter((v) => v != null))];
      const times = alerts.map((alert) => alert.eventTime ?? alert.first).filter(Number.isFinite);
      const first = times.length ? times.reduce((a, b) => Math.min(a, b)) : null;
      const details = [
        ...(first != null ? [`记录时间 ${date(first) === date(run.start) ? "" : `${date(first)} `}${time(first)}`] : []),
        ...(levels.length ? [`原始等级 ${levels.join("、")}`] : []),
        `${alerts.length} 条告警`,
      ];
      return [
        `**${index + 1}. ${text(incident.title, 80)}**`,
        ...(hosts.length ? [`- 资产：${text(hosts.join("、"), 110)}`] : []),
        `- ${text(details.join(" · "), 110)}`,
        `- 判断：${text(incident.assessment, 180)}`,
        ...(incident.unknowns.length ? [`- 待核实：${text(incident.unknowns.join("；"), 130)}`] : []),
      ].join("\n");
    });
    if (incidents.length > 3) {
      shortened = true;
      eventLines.push(`另有 ${incidents.length - 3} 个事件，详见完整报告。`);
    }
    if (eventLines.length) sections.push(`**重点事件**\n${eventLines.join("\n\n")}`);
    const actions = [...new Set(incidents.flatMap((incident) => incident.actions).map(plain).filter(Boolean))];
    if (actions.length > 3) shortened = true;
    if (actions.length) sections.push(`**建议动作（未执行）**\n${actions.slice(0, 3).map((action) => `- ${text(action, 120)}`).join("\n")}`);
  } else {
    sections.push(`**AI 分析未完成，仅发送数据汇总**\n原因：${text(run.error ?? run.stage, 240)}`);
    const counts = new Map();
    for (const alert of run.alerts) {
      const key = [alert.host || "资产未识别", alert.title || "未命名告警"].join(" · ");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const rows = [...counts].sort((a, b) => b[1] - a[1]);
    if (rows.length > 5) shortened = true;
    sections.push(`**告警概览**\n${rows.slice(0, 5).map(([label, count]) => `- ${text(label, 130)}：${count} 条`).join("\n")}`);
  }

  const warnings = coverageWarnings(run.sources.map((source) => {
    const name = plain(source.name);
    if (name.length > 50) shortened = true;
    return { ...source, name: name.length > 50 ? `${take(name, 49)}…` : name };
  }));
  const coverage = warnings.length ? [
    "**⚠ 数据覆盖提醒**",
    ...warnings.slice(0, 3).map((warning) => `- ${text(warning, 150)}`),
    ...(warnings.length > 3 ? [`- 另有 ${warnings.length - 3} 个来源覆盖不足，详见本地报告。`] : []),
    "所选来源的时间窗尚未完整覆盖，不能据此判定无异常。",
  ].join("\n") : "";
  const footer = `**📄 完整报告与告警原文**\nDSH → 运维管理 → 分析报告\n批次：${text(run.id, 100)}`;
  const suffix = [coverage, footer].filter(Boolean).join("\n\n");
  const marker = "[消息摘要已缩短，详见完整报告]";
  const budget = Math.max(0, maxChars - header.length - suffix.length - marker.length - 8);
  let body = sections.join("\n\n");
  if (body.length > budget) {
    shortened = true;
    // Cut at a paragraph boundary so we do not leave unfinished Markdown.
    const prefix = take(body, budget);
    body = prefix.slice(0, Math.max(0, prefix.lastIndexOf("\n\n")));
  }
  const message = [header, body, shortened ? marker : "", suffix].filter(Boolean).join("\n\n");
  return message.length <= maxChars ? message : take(message, maxChars);
}
