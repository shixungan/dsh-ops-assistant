import { createHash, randomUUID } from "node:crypto";
import { QUERY_PLANS, normalizeQueryPlan } from "./query-plan.mjs";
import { freezeDictionary } from "./mcp-dictionary.mjs";

export const DEFAULT_QUERY_PLAN_ID = "builtin-network-ping";

export function defaultQueryPlans(now = 0) {
  return QUERY_PLANS.map((plan) => ({
    id: `builtin-${plan.id}`, name: plan.name, revision: 1,
    config: normalizeQueryPlan({ id: plan.id }), createdAt: now, updatedAt: now,
  }));
}

// Only settings are migrated. Runs retain the exact snapshot that produced them.
export function migratePlanLibrary(settings, { now = Date.now() } = {}) {
  const result = structuredClone(settings);
  if (!Object.hasOwn(result, "queryPlans")) result.queryPlans = defaultQueryPlans(now);
  if (!Array.isArray(result.queryPlans)) throw new Error("查询方案库格式无效");
  if (!Array.isArray(result.tasks)) result.tasks = [];
  const ids = new Set();
  for (const plan of result.queryPlans) {
    if (typeof plan.id !== "string" || !plan.id || ids.has(plan.id)) throw new Error("查询方案 ID 无效或重复");
    ids.add(plan.id);
  }
  result.tasks = result.tasks.map((original) => {
    const { queryPlan, queryPlanRef, allowedTools, maxToolCalls, ...task } = original;
    if (!task.queryPlanId && queryPlan !== undefined) {
      const config = normalizeQueryPlan(queryPlan);
      const digest = createHash("sha256").update(String(task.id)).digest("hex").slice(0, 24);
      const base = `migrated-${digest}`;
      const restored = `${base}-${createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12)}`;
      let id = base, suffix = 0;
      let existing = result.queryPlans.find((plan) => plan.id === id);
      // A legacy task can be restored after its migrated plan was edited. Keep
      // both configurations instead of silently replacing the restored rules.
      while (existing && JSON.stringify(existing.config) !== JSON.stringify(config)) {
        id = suffix++ ? `${restored}-${suffix}` : restored;
        existing = result.queryPlans.find((plan) => plan.id === id);
      }
      if (!existing) result.queryPlans.push({
        id, name: `${task.name || "巡检任务"} · 原查询方案`.slice(0, 200), revision: 1,
        config, createdAt: now, updatedAt: now,
      });
      task.queryPlanId = id;
    } else if (!task.queryPlanId) {
      // This branch is for tasks from releases before query plans existed.
      // Explicitly deleting an unused seed does not recreate it on reads.
      if (!result.queryPlans.some((plan) => plan.id === DEFAULT_QUERY_PLAN_ID))
        result.queryPlans.push(defaultQueryPlans(now)[0]);
      task.queryPlanId = DEFAULT_QUERY_PLAN_ID;
    }
    return task;
  });
  return result;
}

export function queryPlanEntry(input, existing, { now = Date.now() } = {}) {
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200)
    throw new Error("方案名称不能为空且长度不得超过 200");
  if (existing && input.revision !== existing.revision)
    throw new Error("查询方案已被修改，请刷新后重试");
  return {
    id: existing?.id ?? randomUUID(), name: input.name.trim(), revision: (existing?.revision ?? 0) + 1,
    config: normalizeQueryPlan(input.config, existing?.config),
    createdAt: existing?.createdAt ?? now, updatedAt: now,
  };
}

export function freezeTaskQueryPlan(task, plans, dictionary = []) {
  const plan = plans.find((item) => item.id === task.queryPlanId);
  if (!plan) throw new Error("任务引用的查询方案不存在，请重新选择");
  const snapshot = structuredClone(task);
  snapshot.queryPlan = normalizeQueryPlan(plan.config);
  snapshot.queryPlanRef = { id: plan.id, name: plan.name, revision: plan.revision };
  snapshot.queryDictionary = freezeDictionary(snapshot.queryPlan, dictionary);
  return snapshot;
}
