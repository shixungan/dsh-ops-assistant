import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Engine } from "../src/engine.mjs";
import { Store } from "../src/store.mjs";
import { taskConfig } from "../src/config.mjs";
import { createHandler } from "../src/host.mjs";

const now = 3600000;
const source = {
  id: "n9e", name: "测试夜莺", type: "nightingale", enabled: true,
  url: "https://n9e.invalid", pollIntervalSeconds: 60, revision: 0,
};
const alert = {
  alertId: "n9e:1", sourceId: source.id, sourceName: source.name,
  sourceType: source.type, nativeId: "1", host: "test-host", title: "测试告警",
  eventTime: now - 10000, first: now - 10000, sourceRevision: 0,
  raw: { id: 1, rule_name: "测试告警" },
};
const report = {
  summary: "检测到告警，根因待验证", coveredIds: [alert.alertId],
  incidents: [{ title: "测试事件", alertIds: [alert.alertId], assessment: "待验证",
    evidence: ["告警原文"], unknowns: ["缺少指标"], actions: ["查询指标"] }],
};
const ingestion = {
  sourceRevision: 0, status: "ok", coverageStart: 0,
  coveredUntil: now, successAt: now, at: now,
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture(t) {
  const store = new Store(":memory:");
  const task = taskConfig({
    name: "测试巡检", sourceIds: [source.id], intervalMinutes: 30,
    workspace: "/opt/ops", deliveryMode: "manual",
    targets: [{ botId: "bot", targetId: "group" }],
  }, [source]);
  store.saveSettings({ sources: [source], tasks: [task] });
  store.commitIngestion(source.id, [alert], ingestion);
  const sent = [];
  const engine = new Engine({
    store, now: () => now, coverageWaitMs: 0,
    credentials: { resolve: async () => ({ value: "TEST_TOKEN" }) },
    fetcher: async () => { throw new Error("unexpected upstream request"); },
    analyze: async () => JSON.stringify(report),
    getIm: () => ({ send: async (...args) => { sent.push(args); return { sent: true }; } }),
  });
  t.after(async () => { await engine.close(); store.close(); });
  let sequence = 0;
  const saveRun = (id, overrides = {}) => {
    const end = now + ++sequence * 1000;
    const run = {
      id, taskId: task.id, task, start: end - 1800000, end, version: 2,
      status: "completed", stage: "分析完成", alerts: [alert],
      sources: [{ id: source.id, name: source.name, status: "ok", count: 1 }],
      sessions: [`session-${id}`], report,
      analysisOutputs: [{ version: 1, originalText: "旧版 AI 回复" },
        { version: 2, originalText: "本版 AI 回复" }],
      ...overrides,
    };
    store.putRun(run);
    return run;
  };
  const saveDelivery = (id, runId, overrides = {}) => {
    const row = {
      id, runId, version: 1, status: "pending", attempts: 0,
      botId: "bot", targetId: id, text: `测试通知 ${id}`, alertCount: 1,
      ...overrides,
    };
    store.putDelivery(row);
    return row;
  };
  const handler = createHandler({ store, engine, credentials: {}, getIm: () => undefined });
  return { store, task, engine, sent, saveRun, saveDelivery, handler };
}

test("deleting a run removes its snapshots and every delivery version but preserves source history and tasks", (t) => {
  const f = fixture(t);
  const removed = f.saveRun("removed");
  const kept = f.saveRun("kept", { taskId: "another-task" });
  const settings = f.store.getSettings();
  const observation = { raw: { alert: "retained source snapshot" } };
  f.store.observe(source.id, "snapshot", observation);
  const statuses = ["pending", "accepted", "failed", "unknown", "skipped"];
  for (let index = 0; index < 250; index++)
    f.saveDelivery(`removed-${index}`, removed.id, { version: index + 1, status: statuses[index % statuses.length] });
  const unrelated = f.saveDelivery("kept-delivery", kept.id);
  assert.equal(f.store.deliveries().length, 200);

  assert.deepEqual(f.engine.deleteRuns([removed.id]), { deletedIds: [removed.id], deletedCount: 1 });
  assert.equal(f.store.run(removed.id), null);
  assert.equal(f.store.window(removed.taskId, removed.start, removed.end), null);
  assert.deepEqual(f.store.run(kept.id), kept);
  assert.deepEqual(f.store.deliveries(), [unrelated]);
  for (let index = 0; index < 250; index++) assert.equal(f.store.delivery(`removed-${index}`), null);
  assert.deepEqual(f.store.getSettings(), settings);
  assert.deepEqual(f.store.alerts(source.id, 0, now), [alert]);
  assert.deepEqual(f.store.ingestionState(source.id), ingestion);
  assert.deepEqual(f.store.observations(source.id), [observation]);
  assert.deepEqual(f.sent, []);
});

test("batch deletion deduplicates ids and supports completed, failed, cancelled, and interrupted records", (t) => {
  const f = fixture(t);
  const statuses = ["completed", "failed", "cancelled", "interrupted"];
  for (const status of statuses) {
    f.saveRun(status, { status });
    f.saveDelivery(`d-${status}`, status, { status: "accepted" });
  }
  assert.deepEqual(f.engine.deleteRuns([...statuses, "completed"]), {
    deletedIds: statuses, deletedCount: statuses.length,
  });
  assert.deepEqual(f.store.runs(), []);
  assert.deepEqual(f.store.deliveries(), []);
});

test("a database failure rolls back both earlier deletions and associated deliveries", (t) => {
  const f = fixture(t);
  const first = f.saveRun("first"), second = f.saveRun("second");
  const firstDelivery = f.saveDelivery("first-delivery", first.id);
  const secondDelivery = f.saveDelivery("second-delivery", second.id);
  f.store.db.exec(`CREATE TRIGGER fail_second_delete BEFORE DELETE ON runs
    WHEN OLD.id = 'second' BEGIN SELECT RAISE(ABORT, 'simulated deletion failure'); END;`);
  assert.throws(() => f.engine.deleteRuns([first.id, second.id]), /simulated deletion failure/);
  assert.deepEqual(f.store.run(first.id), first);
  assert.deepEqual(f.store.run(second.id), second);
  assert.deepEqual(f.store.delivery(firstDelivery.id), firstDelivery);
  assert.deepEqual(f.store.delivery(secondDelivery.id), secondDelivery);
  f.store.db.exec("DROP TRIGGER fail_second_delete");
  assert.equal(f.engine.deleteRuns([first.id, second.id]).deletedCount, 2);
});

test("invalid, oversized, missing, and partly missing selections delete nothing", (t) => {
  const f = fixture(t);
  const run = f.saveRun("kept");
  const delivery = f.saveDelivery("kept-delivery", run.id);
  const invalid = [undefined, null, "kept", {}, [], [null], [3], [""], [" "],
    [" kept"], ["kept "], ["x".repeat(201)], Array(101).fill("kept"),
    ["missing"], [run.id, "missing"]];
  for (const ids of invalid) {
    assert.throws(() => f.engine.deleteRuns(ids));
    assert.deepEqual(f.store.run(run.id), run);
    assert.deepEqual(f.store.delivery(delivery.id), delivery);
  }
});

test("a mixed batch is refused in full while any record is queued, running, or in an unsupported state", async (t) => {
  for (const status of ["queued", "collecting", "analyzing", "unknown", undefined]) {
    await t.test(String(status), (t) => {
      const f = fixture(t);
      const done = f.saveRun("done"), active = f.saveRun("active", { status });
      f.saveDelivery("done-delivery", done.id);
      assert.throws(() => f.engine.deleteRuns([done.id, active.id]));
      assert.deepEqual(f.store.run(done.id), done);
      // SQLite JSON drops undefined properties, so compare with the persisted snapshot.
      assert.equal(f.store.run(active.id).status, status);
      assert.ok(f.store.delivery("done-delivery"));
      assert.ok(f.engine.runDeletionReason(active));
    });
  }
});

test("in-memory execution guards and sending rows outside the UI page prevent deletion", (t) => {
  const f = fixture(t);
  const run = f.saveRun("protected");
  f.engine.current = { id: run.id, control: new AbortController() };
  assert.throws(() => f.engine.deleteRuns([run.id]), /执行/);
  f.engine.current = null;
  f.engine.queue.push(run.id);
  assert.throws(() => f.engine.deleteRuns([run.id]), /执行/);
  f.engine.queue = [];
  f.engine.delivering.add(run.id);
  assert.throws(() => f.engine.deleteRuns([run.id]), /投递/);
  f.engine.delivering.clear();
  f.saveDelivery("old-sending", run.id, { status: "sending" });
  for (let index = 0; index < 205; index++)
    f.saveDelivery(`unrelated-${index}`, "unrelated", { status: "accepted" });
  assert.ok(!f.store.deliveries().some((row) => row.id === "old-sending"));
  assert.throws(() => f.engine.deleteRuns([run.id]), /投递/);
  f.store.putDelivery({ ...f.store.delivery("old-sending"), status: "accepted" });
  f.engine.sending.add("old-sending");
  assert.throws(() => f.engine.deleteRuns([run.id]), /投递/);
  f.engine.sending.clear();
  assert.equal(f.engine.deleteRuns([run.id]).deletedCount, 1);
});

test("queued work must be cancelled before its run can be deleted", (t) => {
  const f = fixture(t);
  f.engine.busy = true;
  const run = f.engine.manual(f.task.id);
  assert.equal(f.store.run(run.id).status, "queued");
  assert.throws(() => f.engine.deleteRuns([run.id]), /执行/);
  f.engine.cancel(run.id);
  assert.equal(f.store.run(run.id).status, "cancelled");
  assert.equal(f.engine.deleteRuns([run.id]).deletedCount, 1);
  assert.deepEqual(f.engine.queue, []);
  f.engine.busy = false;
  f.engine.drain();
  assert.equal(f.store.run(run.id), null);
});

test("multi-target delivery blocks deletion through the final send, then permits local cleanup", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const run = f.saveRun("multi", { task: { ...f.task, targets: [
    { botId: "bot", targetId: "first" }, { botId: "bot", targetId: "second" },
  ] } });
  const entered = [deferred(), deferred()], release = [deferred(), deferred()];
  const sent = [];
  f.engine.getIm = () => ({ send: async (_bot, target) => {
    const index = sent.length;
    sent.push(target);
    entered[index].resolve();
    await release[index].promise;
    return { sent: true };
  } });
  const delivery = f.engine.deliver(run.id);
  try {
    await entered[0].promise;
    assert.throws(() => f.engine.deleteRuns([run.id]), /投递/);
    assert.match((await f.handler("state")).runs[0].deleteBlockedReason, /投递/);
    release[0].resolve();
    await entered[1].promise;
    assert.throws(() => f.engine.deleteRuns([run.id]), /投递/);
    assert.equal(f.store.deliveries().length, 2);
  } finally {
    release.forEach((gate) => gate.resolve());
    await delivery;
  }
  assert.deepEqual(sent, ["first", "second"]);
  assert.equal(f.engine.runDeletionReason(f.store.run(run.id)), null);
  assert.equal(f.engine.deleteRuns([run.id]).deletedCount, 1);
  assert.deepEqual(f.store.deliveries(), []);
});

test("a scheduler's cached pending delivery cannot send or resurrect a deleted run", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const first = f.saveRun("first"), removed = f.saveRun("removed");
  // deliveries() is newest-first: the tick reads both, then awaits first's send.
  const stale = f.saveDelivery("removed-delivery", removed.id);
  f.saveDelivery("first-delivery", first.id);
  const entered = deferred(), release = deferred(), sent = [];
  f.engine.getIm = () => ({ send: async (_bot, target) => {
    sent.push(target);
    entered.resolve();
    await release.promise;
    return { sent: true };
  } });
  const tick = f.engine.tick();
  try {
    await entered.promise;
    assert.equal(f.engine.deleteRuns([removed.id]).deletedCount, 1);
  } finally {
    release.resolve();
    await tick;
    await f.engine.pollPromise;
  }
  await f.engine.sendDelivery(stale);
  assert.deepEqual(sent, ["first-delivery"]);
  assert.equal(f.store.run(removed.id), null);
  assert.equal(f.store.delivery(stale.id), null);
  await assert.rejects(f.engine.retryDelivery(stale.id), /无法重试/);
});

test("a stale pending snapshot cannot resend a delivery that was already accepted", async (t) => {
  const f = fixture(t);
  const run = f.saveRun("run");
  const stale = f.saveDelivery("delivery", run.id);
  await f.engine.sendDelivery(stale);
  await f.engine.sendDelivery(stale);
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.delivery(stale.id).status, "accepted");
});

test("single and batch RPCs remove reports while retained tasks and alert history remain usable", async (t) => {
  const f = fixture(t);
  f.saveRun("single");
  f.saveRun("first");
  f.saveRun("second");
  assert.equal((await f.handler("state")).runs[0].deleteBlockedReason, null);
  assert.deepEqual(await f.handler("run.delete", { id: "single" }), {
    deletedIds: ["single"], deletedCount: 1,
  });
  assert.deepEqual(await f.handler("run.deleteMany", { ids: ["first", "second"] }), {
    deletedIds: ["first", "second"], deletedCount: 2,
  });
  for (const method of ["run.get", "run.alerts", "run.retry", "run.deliver"])
    await assert.rejects(f.handler(method, { id: "single" }));
  assert.deepEqual((await f.handler("state")).runs, []);
  const next = await f.handler("task.run", { id: f.task.id });
  await f.engine.drainPromise;
  assert.equal(f.store.run(next.id).status, "completed");
  assert.deepEqual(f.store.run(next.id).alerts.map((item) => item.alertId), [alert.alertId]);
  assert.equal(f.store.getSettings().tasks[0].id, f.task.id);
  assert.deepEqual(f.sent, []);
});

test("cancelled RPCs and migration or shutdown guards preserve selected records", async (t) => {
  const f = fixture(t);
  f.saveRun("run");
  const control = new AbortController();
  control.abort(new Error("request cancelled"));
  await assert.rejects(f.handler("run.delete", { id: "run" }, control.signal), /request cancelled/);
  await assert.rejects(f.handler("run.deleteMany", { ids: ["run"] }, control.signal), /request cancelled/);
  const gate = deferred();
  const handler = createHandler({
    store: f.store, engine: f.engine, credentials: {}, getIm: () => undefined,
    storage: { info: () => ({}), move: () => gate.promise },
  });
  const moving = handler("storage.save", { dataDir: "/new-data" });
  try {
    await assert.rejects(handler("run.delete", { id: "run" }), /迁移/);
    await assert.rejects(handler("run.deleteMany", { ids: ["run"] }), /迁移/);
    assert.ok(f.store.run("run"));
  } finally {
    gate.resolve({});
    await moving;
  }
  f.engine.paused = true;
  assert.throws(() => f.engine.deleteRuns(["run"]), /停止或迁移/);
  f.engine.paused = false;
  await f.engine.close();
  assert.throws(() => f.engine.deleteRuns(["run"]), /停止或迁移/);
  assert.ok(f.store.run("run"));
});

test("deleted runs and deliveries stay deleted after reopening the database", () => {
  const root = resolve(tmpdir());
  const directory = mkdtempSync(join(root, "dsh-ops-delete-"));
  const path = join(directory, "ops.sqlite");
  let store;
  try {
    store = new Store(path);
    store.putRun({ id: "removed", taskId: "task", start: 0, end: 1, status: "completed" });
    store.putRun({ id: "kept", taskId: "task", start: 1, end: 2, status: "completed" });
    store.putDelivery({ id: "removed-delivery", runId: "removed", status: "pending" });
    store.commitIngestion(source.id, [alert], ingestion);
    store.deleteRuns(["removed"]);
    store.close();
    store = new Store(path);
    assert.equal(store.run("removed"), null);
    assert.equal(store.delivery("removed-delivery"), null);
    assert.equal(store.runs().length, 1);
    assert.equal(store.runs()[0].id, "kept");
    assert.deepEqual(store.alerts(source.id, 0, now), [alert]);
    assert.deepEqual(store.ingestionState(source.id), ingestion);
  } finally {
    store?.close();
    const target = resolve(directory);
    assert.ok(target.startsWith(root + sep) && target !== root);
    rmSync(target, { recursive: true, force: true });
  }
});
