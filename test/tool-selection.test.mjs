import test from "node:test";
import assert from "node:assert/strict";
import { taskConfig } from "../src/config.mjs";
import { createHandler } from "../src/host.mjs";
import { Store } from "../src/store.mjs";
import { defaultQueryPlans } from "../src/plan-library.mjs";

const sources = [{ id: "n9e", enabled: true }];
const task = { name: "巡检", sourceIds: ["n9e"], workspace: "/opt/ops" };

test("legacy task saves replace hand-picked tool permissions with a default query plan", () => {
  const legacy = { ...task, id: "existing", enabled: true, nextEnd: 123, createdAt: 100, allowedTools: ["bash", "schedule_create", "read_logs"], maxToolCalls: 40 };
  const saved = taskConfig(legacy, sources, legacy);
  assert.equal(saved.id, "existing");
  assert.equal(saved.enabled, true);
  assert.equal(saved.nextEnd, 123);
  assert.equal(saved.createdAt, 100);
  assert.equal(saved.queryPlanId, "builtin-network-ping");
  assert.equal(Object.hasOwn(saved, "queryPlan"), false);
  assert.equal(Object.hasOwn(saved, "allowedTools"), false);
  assert.equal(Object.hasOwn(saved, "maxToolCalls"), false);
  assert.equal(legacy.allowedTools[0], "bash");
});

test("tool discovery exposes compatible purpose bindings and invalid plans preserve saved tasks", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const saved = taskConfig({ ...task, allowedTools: ["read_metrics"] }, sources);
  store.saveSettings({ sources, tasks: [saved] });
  const pg = { name: "postgresql-switch-info-execute_sql", parameters: { properties: { sql: { type: "string" } } } };
  const graph = { name: "neo4j_readonly-read-cypher", parameters: { properties: { query: { type: "string" } } } };
  const memory = { name: "mcp__memos__search_memory", parameters: { properties: { query: { type: "string" } } } };
  const tools = [...["read_metrics", "session_trace", "subagent", "schedule_create", "bash", "run_code"].map((name) => ({ name, description: name })), pg, graph, memory];
  const handler = createHandler({ store, engine: {}, credentials: {}, getIm: () => null, getTools: () => tools });
  assert.deepEqual((await handler("tools.list")).map(({ name, roles }) => ({ name, roles })), [
    { name: pg.name, roles: ["postgres"] }, { name: graph.name, roles: ["neo4j"] }, { name: memory.name, roles: ["memory"] },
  ]);
  await assert.rejects(handler("task.save", { ...saved, queryPlanId: "missing" }), /现有查询方案/);
  await assert.rejects(handler("task.save", { ...saved, queryPlan: { id: "network-ping" } }), /任务只选择/);
  assert.deepEqual(store.getSettings().tasks, [saved]);
  const updated = await handler("task.save", { ...saved, allowedTools: ["bash"], queryPlanId: "builtin-general-evidence" });
  assert.equal(updated.queryPlanId, "builtin-general-evidence");
  assert.equal(Object.hasOwn(updated, "allowedTools"), false);
});

test("ordinary task edits preserve its query plan unless explicitly replaced", () => {
  const plans = defaultQueryPlans();
  const initial = taskConfig({ ...task, queryPlanId: "builtin-general-evidence" }, sources, undefined, plans);
  assert.equal(taskConfig({ ...task, name: "新名称" }, sources, initial, plans).queryPlanId, initial.queryPlanId);
  assert.equal(taskConfig({ ...task, queryPlanId: "builtin-network-ping" }, sources, initial, plans).queryPlanId, "builtin-network-ping");
});

test("polling state omits query evidence while report detail retains it", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const queryEvidence = { plan: { id: "network-ping", version: 1 }, queries: [{ id: "assets", status: "ok" }], evidence: [{ rows: [{ asset_name: "synthetic-asset" }] }] };
  const run = { id: "run", taskId: "task", start: 1000, end: 2000, status: "completed", alerts: [], queryEvidence, report: { summary: "summary", coveredIds: [] } };
  store.putRun(run);
  const engine = { report: (id) => ({ run: store.run(id), markdown: "report" }) };
  const handler = createHandler({ store, engine, credentials: {}, getIm: () => null });
  const state = await handler("state");
  assert.equal(Object.hasOwn(state.runs[0], "queryEvidence"), false);
  assert.deepEqual((await handler("run.get", { id: "run" })).run.queryEvidence, queryEvidence);
});
