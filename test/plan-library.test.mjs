import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { createHandler } from "../src/host.mjs";
import { taskConfig } from "../src/config.mjs";
import { migratePlanLibrary, defaultQueryPlans } from "../src/plan-library.mjs";
import { normalizeQueryPlan } from "../src/query-plan.mjs";

const source = { id: "n9e", enabled: true };
const fields = { name: "巡检", sourceIds: [source.id], workspace: "/ops" };
const legacy = { ...fields, id: "task-a", queryPlan: normalizeQueryPlan({ instructions: "先看同路径" }), createdAt: 25, nextEnd: 60000, targets: [{ botId: "bot", targetId: "room" }], allowedTools: ["bash"], maxToolCalls: 40 };

function fixture(t) {
  const store = new Store(":memory:");
  const engine = new Engine({ store, credentials: {}, getIm: () => null });
  engine.drain = () => {};
  t.after(() => store.close());
  store.saveSettings({ sources: [source], tasks: [] });
  const handler = createHandler({ store, engine, credentials: {}, getIm: () => null });
  return { store, engine, handler };
}

test("legacy embedded plans migrate independently and idempotently without losing task settings", () => {
  const settings = { sources: [source], tasks: [legacy, { ...legacy, id: "task-b", name: "第二项" }], custom: { retained: true } };
  const result = migratePlanLibrary(settings, { now: 100 });
  assert.equal(result.queryPlans.length, 4);
  assert.notEqual(result.tasks[0].queryPlanId, result.tasks[1].queryPlanId);
  for (const task of result.tasks) {
    assert.deepEqual(result.queryPlans.find((plan) => plan.id === task.queryPlanId).config, legacy.queryPlan);
    assert.equal(Object.hasOwn(task, "queryPlan"), false);
    assert.equal(Object.hasOwn(task, "allowedTools"), false);
    assert.equal(task.createdAt, 25); assert.equal(task.nextEnd, 60000);
    assert.deepEqual(task.targets, legacy.targets);
  }
  assert.deepEqual(result.custom, settings.custom);
  assert.deepEqual(migratePlanLibrary(result, { now: 200 }), result);
  assert.equal(settings.tasks[0].queryPlanId, undefined);
  const modified = structuredClone(result);
  const first = modified.queryPlans.find((plan) => plan.id === result.tasks[0].queryPlanId);
  first.config.instructions = "已有的独立编辑";
  modified.tasks[0] = legacy;
  const restored = migratePlanLibrary(modified, { now: 300 });
  assert.notEqual(restored.tasks[0].queryPlanId, first.id);
  assert.equal(restored.queryPlans.find((plan) => plan.id === first.id).config.instructions, "已有的独立编辑");
  assert.deepEqual(migratePlanLibrary({ sources: [], tasks: [], queryPlans: [] }).queryPlans, []);
});

test("library CRUD requires current revisions and refuses referenced or unknown plan deletion", async (t) => {
  const { store, handler } = fixture(t);
  await assert.rejects(handler("queryPlan.save", { name: "  " }), /名称/);
  await assert.rejects(handler("queryPlan.save", { name: "invalid", config: { queryTimeoutSeconds: -1 } }), /超时/);
  const created = await handler("queryPlan.save", { name: "网络方案", config: { instructions: "本业务" } });
  const task = await handler("task.save", { ...fields, queryPlanId: created.id });
  assert.equal(task.queryPlan, undefined);
  await assert.rejects(handler("queryPlan.delete", { id: created.id }), /引用/);
  await assert.rejects(handler("queryPlan.save", { id: created.id, name: "改名" }), /刷新/);
  const updated = await handler("queryPlan.save", { ...created, name: "更新方案" });
  assert.equal(updated.revision, 2); assert.equal(updated.createdAt, created.createdAt);
  await assert.rejects(handler("queryPlan.save", { ...created, name: "过期编辑" }), /刷新/);
  await assert.rejects(handler("queryPlan.delete", { id: created.id, revision: 1 }), /刷新/);
  const state = await handler("state");
  assert.equal(state.config.queryPlans.find((plan) => plan.id === created.id).name, "更新方案");
  assert.equal(state.config.tasks[0].queryPlanId, created.id);
  await handler("task.save", { ...task, queryPlanId: "builtin-general-evidence" });
  assert.deepEqual(await handler("queryPlan.delete", { id: created.id, revision: 2 }), { deleted: true, id: created.id });
  await assert.rejects(handler("task.save", { ...task, queryPlanId: created.id }), /现有查询方案/);
  assert.equal(store.getSettings().tasks[0].queryPlanId, "builtin-general-evidence");
});

test("new runs freeze library revisions while queued and historical retries retain their exact snapshot", async (t) => {
  const { store, engine, handler } = fixture(t);
  const first = await handler("queryPlan.save", { name: "原方案", config: { instructions: "旧规则", assetCacheSeconds: 0 } });
  const task = await handler("task.save", { ...fields, queryPlanId: first.id });
  const queued = engine.enqueue(task, 1000, 2000);
  assert.deepEqual(queued.task.queryPlanRef, { id: first.id, name: "原方案", revision: 1 });
  const second = await handler("queryPlan.save", { ...first, name: "新方案", config: { ...first.config, instructions: "新规则" } });
  assert.equal(store.run(queued.id).task.queryPlan.instructions, "旧规则");
  assert.equal(engine.enqueue(task, 2000, 3000).task.queryPlanRef.revision, 2);
  await handler("task.save", { ...task, queryPlanId: "builtin-network-ping" });
  await handler("queryPlan.delete", { id: first.id, revision: second.revision });
  const old = store.run(queued.id); old.status = "completed"; store.putRun(old);
  assert.equal(engine.retry(old.id).task.queryPlan.instructions, "旧规则");
  assert.equal(store.run(old.id).task.queryPlanRef.revision, 1);
  assert.throws(() => engine.enqueue(task, 3000, 4000), /不存在/);
});

test("store persists migration and preserves its library across partial settings writes and relocation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ops-plan-library-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "before.sqlite"));
  try {
    store.db.prepare("INSERT OR REPLACE INTO settings VALUES (?,?)").run("config", JSON.stringify({ sources: [source], tasks: [legacy] }));
    const migrated = store.getSettings();
    assert.deepEqual(JSON.parse(store.db.prepare("SELECT data FROM settings WHERE id='config'").get().data), migrated);
    store.saveSettings({ sources: [source], tasks: migrated.tasks });
    assert.deepEqual(store.getSettings().queryPlans, migrated.queryPlans);
    await store.relocate(join(directory, "after.sqlite"), () => {});
    assert.deepEqual(store.getSettings(), migrated);
    store.saveSettings({ sources: [], tasks: [], queryPlans: [] });
    store.saveSettings({ sources: [source], tasks: [] });
    assert.deepEqual(store.getSettings().queryPlans, []);
  } finally { store.close(); }
  const reopened = new Store(join(directory, "after.sqlite"));
  try { assert.deepEqual(reopened.getSettings().queryPlans, []); }
  finally { reopened.close(); }
});

test("task configuration accepts only existing references and does not reset them on unrelated edits", () => {
  const plans = defaultQueryPlans();
  const task = taskConfig({ ...fields, queryPlanId: plans[1].id }, [source], undefined, plans);
  assert.equal(taskConfig({ ...fields, name: "新任务名" }, [source], task, plans).queryPlanId, plans[1].id);
  assert.throws(() => taskConfig({ ...fields, queryPlanId: "unknown" }, [source], undefined, plans), /现有查询方案/);
  assert.throws(() => taskConfig({ ...fields, queryPlan: {} }, [source], undefined, plans), /任务只选择/);
});
