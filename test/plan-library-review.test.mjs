import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { createHandler } from "../src/host.mjs";
import { normalizeQueryPlan } from "../src/query-plan.mjs";
import { migratePlanLibrary } from "../src/plan-library.mjs";

const source = { id: "source", name: "夜莺", enabled: true, type: "nightingale", url: "https://n9e.invalid" };
const taskInput = { name: "业务巡检", sourceIds: [source.id], workspace: "/ops", deliveryMode: "off" };
const config = (instructions) => normalizeQueryPlan({ instructions, assetCacheSeconds: 7, maxSupplementaryCalls: 1 });

function fixture(t, getIm = () => undefined) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.saveSettings({ sources: [source], tasks: [] });
  const engine = new Engine({ store, credentials: {}, getIm });
  // These tests inspect enqueue/retry boundaries without starting any work.
  engine.drain = () => {};
  const handler = createHandler({ store, engine, credentials: {}, getIm });
  return { store, engine, handler };
}

test("real legacy settings migrate once without losing task controls or unrelated settings", (t) => {
  const { store } = fixture(t);
  const old = {
    sources: [source], extraSetting: { retained: true },
    tasks: [
      { ...taskInput, id: "one", enabled: true, createdAt: 10, nextEnd: 123, targets: [{ botId: "b", targetId: "g" }], queryPlan: config("保留规则一") },
      { ...taskInput, id: "two", enabled: false, createdAt: 20, nextEnd: 456, queryPlan: config("保留规则二") },
    ],
  };
  store.db.prepare("INSERT OR REPLACE INTO settings VALUES (?,?)").run("config", JSON.stringify(old));
  const first = store.getSettings();
  const persisted = store.db.prepare("SELECT data FROM settings WHERE id=?").get("config").data;
  assert.deepEqual(store.getSettings(), first);
  assert.equal(store.db.prepare("SELECT data FROM settings WHERE id=?").get("config").data, persisted);
  assert.deepEqual(first.extraSetting, old.extraSetting);
  for (const original of old.tasks) {
    const migrated = first.tasks.find((task) => task.id === original.id);
    const plan = first.queryPlans.find((entry) => entry.id === migrated.queryPlanId);
    assert.deepEqual(plan.config, original.queryPlan);
    const { queryPlan, ...unchanged } = original;
    const { queryPlanId, ...saved } = migrated;
    assert.deepEqual(saved, unchanged);
  }
  assert.notEqual(first.tasks[0].queryPlanId, first.tasks[1].queryPlanId);
});

test("restoring legacy rules repeatedly never reuses an edited migrated collision", () => {
  const original = { ...taskInput, id: "restored-task", queryPlan: config("原始规则") };
  const first = migratePlanLibrary({ sources: [source], tasks: [original] }, { now: 1 });
  first.queryPlans.find((entry) => entry.id === first.tasks[0].queryPlanId).config = config("第一次人工修改");
  const second = migratePlanLibrary({ ...first, tasks: [original] }, { now: 2 });
  const secondId = second.tasks[0].queryPlanId;
  assert.deepEqual(second.queryPlans.find((entry) => entry.id === secondId).config, original.queryPlan);
  second.queryPlans.find((entry) => entry.id === secondId).config = config("第二次人工修改");
  const third = migratePlanLibrary({ ...second, tasks: [original] }, { now: 3 });
  assert.deepEqual(third.queryPlans.find((entry) => entry.id === third.tasks[0].queryPlanId).config, original.queryPlan);
  assert.deepEqual(migratePlanLibrary(third, { now: 4 }), third);
  assert.ok(third.queryPlans.some((entry) => entry.config.instructions === "第一次人工修改"));
  assert.ok(third.queryPlans.some((entry) => entry.config.instructions === "第二次人工修改"));
});

test("explicitly emptied libraries stay empty and older settings writers preserve the current library", async (t) => {
  const { store, handler } = fixture(t);
  const plan = await handler("queryPlan.save", { name: "自定义", config: config("规则") });
  store.saveSettings({ sources: [source], tasks: [] });
  assert.deepEqual(store.getSettings().queryPlans.find((entry) => entry.id === plan.id), plan);
  store.saveSettings({ sources: [source], tasks: [], queryPlans: [] });
  assert.deepEqual(store.getSettings().queryPlans, []);
  store.saveSettings({ sources: [source], tasks: [] });
  assert.deepEqual(store.getSettings().queryPlans, []);
});

test("two saves based on the same plan revision cannot overwrite each other", async (t) => {
  const { store, handler } = fixture(t);
  const plan = await handler("queryPlan.save", { name: "并发方案", config: config("初始") });
  const results = await Promise.allSettled([
    handler("queryPlan.save", { ...plan, config: config("第一个提交") }),
    handler("queryPlan.save", { ...plan, config: config("第二个提交") }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /修改|刷新/);
  const saved = store.getSettings().queryPlans.find((entry) => entry.id === plan.id);
  assert.equal(saved.revision, plan.revision + 1);
  assert.equal(saved.config.instructions, "第一个提交");
});

function pausedIm() {
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  const im = {
    send() { throw new Error("must not send"); },
    listBots: () => paused,
    listTargets: async () => [{ targetId: "group", name: "运维" }],
  };
  return { im, release: () => release([{ botId: "bot", channel: "feishu" }]) };
}
const delivery = { deliveryMode: "manual", targets: [{ botId: "bot", targetId: "group" }] };

test("a plan deleted during target validation cannot become a dangling task reference", async (t) => {
  const waiting = pausedIm(), { store, handler } = fixture(t, () => waiting.im);
  const plan = await handler("queryPlan.save", { name: "即将删除", config: config("规则") });
  const saving = handler("task.save", { ...taskInput, ...delivery, queryPlanId: plan.id });
  const rejected = assert.rejects(saving, /现有查询方案|不存在/);
  await handler("queryPlan.delete", { id: plan.id, revision: plan.revision });
  waiting.release();
  await rejected;
  assert.equal(store.getSettings().tasks.length, 0);
  assert.equal(store.getSettings().queryPlans.some((entry) => entry.id === plan.id), false);
});

test("a plan edited during target validation remains current and a saved task contains only its reference", async (t) => {
  const waiting = pausedIm(), { store, engine, handler } = fixture(t, () => waiting.im);
  const plan = await handler("queryPlan.save", { name: "共享方案", config: config("第一版") });
  const saving = handler("task.save", { ...taskInput, ...delivery, queryPlanId: plan.id });
  const edited = await handler("queryPlan.save", { ...plan, config: config("最新版本") });
  waiting.release();
  const saved = await saving;
  assert.equal(Object.hasOwn(saved, "queryPlan"), false);
  assert.equal(Object.hasOwn(saved, "queryPlanRef"), false);
  assert.equal(saved.queryPlanId, edited.id);
  assert.deepEqual(store.getSettings().queryPlans.find((entry) => entry.id === edited.id), edited);
  await assert.rejects(handler("queryPlan.delete", { id: edited.id }), /引用/);
  const queued = engine.enqueue(saved, 1000, 2000);
  assert.equal(queued.task.queryPlanRef.revision, edited.revision);
  assert.deepEqual(queued.task.queryPlan, edited.config);
});

test("queued and retried reports retain plan snapshots even after unreferenced library entries are deleted", async (t) => {
  const { store, engine, handler } = fixture(t);
  const plan = await handler("queryPlan.save", { name: "原方案", config: config("入队时规则") });
  let task = await handler("task.save", { ...taskInput, queryPlanId: plan.id });
  const queued = engine.enqueue(task, 1000, 2000), before = structuredClone(queued.task);
  const edited = await handler("queryPlan.save", { ...plan, name: "新方案名称", config: config("后来规则") });
  const later = engine.enqueue(task, 2000, 3000);
  assert.deepEqual(later.task.queryPlan, edited.config);
  assert.equal(later.task.queryPlanRef.revision, edited.revision);
  task = await handler("task.save", { ...task, queryPlanId: "builtin-general-evidence" });
  await handler("queryPlan.delete", { id: edited.id, revision: edited.revision });
  assert.deepEqual(store.run(queued.id).task, before);
  const completed = { ...store.run(queued.id), status: "completed", report: { summary: "old" }, sources: [{ id: source.id }] };
  store.putRun(completed);
  engine.retry(queued.id);
  assert.deepEqual(store.run(queued.id).task, before);
  assert.equal(store.getSettings().tasks[0].queryPlanId, task.queryPlanId);
});

test("legacy report retry never consults or rewrites the current plan library", (t) => {
  const { store, engine } = fixture(t);
  const oldTask = { ...taskInput, id: "historic-task", queryPlan: config("历史内嵌规则"), timeoutMinutes: 15, intervalMinutes: 30 };
  const historic = { id: "historic-report", taskId: oldTask.id, task: oldTask, start: 1, end: 2, status: "completed", sources: [{ id: source.id }], alerts: [], sessions: [], version: 1 };
  store.putRun(historic);
  store.saveSettings({ sources: [source], tasks: [], queryPlans: [] });
  assert.deepEqual(store.run(historic.id).task, oldTask);
  engine.retry(historic.id);
  assert.deepEqual(store.run(historic.id).task, oldTask);
  assert.deepEqual(store.getSettings().queryPlans, []);
});
