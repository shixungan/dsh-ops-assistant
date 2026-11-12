import { randomUUID } from "node:crypto";
import { normalizeQueryPlan } from "./query-plan.mjs";
const text = (v, label, max = 200) => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new Error(`${label}不能为空且长度不得超过 ${max}`);
  return v.trim();
};
const integer = (v, min, max, label) => {
  if (!Number.isInteger(v) || v < min || v > max)
    throw new Error(`${label}须为 ${min}—${max} 的整数`);
  return v;
};
export function sourceConfig(input, existing) {
  if (!["zabbix", "nightingale", "alertmanager"].includes(input.type))
    throw new Error("不支持的告警源类型");
  const url = new URL(text(input.url, "地址", 2000));
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("地址须为 HTTP(S)，不要包含密码、查询参数或片段");
  const normalizedUrl = url.href.replace(/\/$/, "");
  const changedIdentity = existing &&
    (existing.url !== normalizedUrl || existing.type !== input.type);
  return {
    id: existing?.id ?? randomUUID(),
    name: text(input.name, "名称"),
    type: input.type,
    url: normalizedUrl,
    enabled: input.enabled !== false,
    pollIntervalSeconds: integer(
      input.pollIntervalSeconds ?? existing?.pollIntervalSeconds ?? 60,
      15, 3600, "采集间隔秒数",
    ),
    revision: (existing?.revision ?? 0) + (changedIdentity ? 1 : 0),
    authMode:
      input.type === "nightingale"
        ? "user-token"
        : input.authMode === "body"
          ? "body"
          : "bearer",
  };
}
export function deliveryConfig(input) {
  const targets = (input.targets ?? []).map((t) => ({
    botId: text(t.botId, "机器人 ID"),
    targetId: text(t.targetId, "投递目标 ID"),
    ...(typeof t.channel === "string"
      ? { channel: text(t.channel, "渠道", 100) }
      : {}),
    ...(typeof t.targetName === "string"
      ? { targetName: text(t.targetName, "目标名称", 500) }
      : {}),
  }));
  if (targets.length > 10) throw new Error("最多选择 10 个投递目标");
  const mode = input.deliveryMode ?? "off";
  if (!["off", "manual", "auto"].includes(mode))
    throw new Error("无效投递模式");
  if (mode !== "off" && !targets.length)
    throw new Error("请选择机器人及投递目标");
  return {
    deliveryMode: mode,
    targets,
    sendDataOnFailure: input.sendDataOnFailure !== false,
  };
}
export function taskConfig(input, sources, existing) {
  const sourceIds = [...new Set(input.sourceIds ?? [])];
  if (
    !sourceIds.length ||
    sourceIds.some((id) => !sources.some((s) => s.id === id && s.enabled))
  )
    throw new Error("至少选择一个已启用的告警源");
  return {
    id: existing?.id ?? randomUUID(),
    name: text(input.name, "任务名称"),
    sourceIds,
    enabled: input.enabled === true,
    intervalMinutes: integer(input.intervalMinutes ?? 30, 5, 1440, "周期分钟"),
    timeoutMinutes: integer(input.timeoutMinutes ?? 15, 1, 60, "分析超时分钟"),
    queryPlan: normalizeQueryPlan(input.queryPlan, existing?.queryPlan),
    maxBatchChars: integer(
      input.maxBatchChars ?? 20000,
      2000,
      80000,
      "单批字符预算",
    ),
    workspace: text(input.workspace, "服务器工作目录", 2000),
    agentPreset:
      typeof input.agentPreset === "string" ? input.agentPreset.trim() : "",
    instructions:
      typeof input.instructions === "string"
        ? input.instructions.slice(0, 20000)
        : "",
    ...deliveryConfig(input),
    nextEnd: existing?.nextEnd ?? null,
    createdAt: existing?.createdAt ?? Date.now(),
  };
}
export const credentialRef = (id) => `DSH_OPS_${id.replaceAll("-", "_")}_TOKEN`;
