import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { taskConfig } from "../src/config.mjs";
import { createHandler } from "../src/host.mjs";

const source = {
  id: "n9e", name: "夜莺", type: "nightingale", enabled: true,
  url: "https://n9e.invalid", pollIntervalSeconds: 60, revision: 1,
};
const event = (id, seconds) => ({
  id, rule_name: "测试告警", is_recovered: 0,
  first_trigger_time: seconds, trigger_time: seconds, last_eval_time: seconds,
  target_ident: "test-host", severity: 1,
});
const credentials = {
  resolve: async () => ({ value: "TEST_TOKEN" }),
  set: async () => {}, unset: async () => {},
};
function fixture(t, { sources = [source], coverageWaitMs = 500 } = {}) {
  const store = new Store(":memory:");
  const task = taskConfig({
    name: "半小时巡检", sourceIds: sources.map((s) => s.id),
    intervalMinutes: 30, workspace: "/opt/ops", deliveryMode: "off",
  }, sources);
  store.saveSettings({ sources, tasks: [task] });
  const clock = { now: 3600000 };
  const rows = [event(1, 3500)];
  const calls = [];
  let analyses = 0;
  const engine = new Engine({
    store, credentials, coverageWaitMs, now: () => clock.now, getIm: () => null,
    fetcher: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      const start = Number(parsed.searchParams.get("stime"));
      const end = Number(parsed.searchParams.get("etime"));
      const list = rows.filter((row) => row.last_eval_time >= start && row.last_eval_time <= end);
      return Response.json({ dat: { total: list.length, list } });
    },
    analyze: async (prompt) => {
      analyses++;
      const ids = [...new Set([...prompt.matchAll(/"alertId":"([^"]+)"/g)].map((m) => m[1]))];
      return JSON.stringify({
        summary: "存在告警，需进一步验证",
        incidents: [{ title: "测试事件", alertIds: ids, assessment: "仅已知事实",
          evidence: ["本地记录"], unknowns: ["根因未知"], actions: ["查询指标"] }],
      });
    },
  });
  t.after(async () => { await engine.close(); store.close(); });
  const handler = createHandler({ store, engine, credentials, getIm: () => null });
  return { store, task, clock, rows, calls, engine, handler, analyses: () => analyses };
}
async function ready(f) {
  await f.engine.poll();
  f.clock.now = 3630000;
}
function assertWaiting(f, run) {
  assert.equal(f.engine.coverageWaiters.size, 1);
  assert.equal(f.store.run(run.id).status, "collecting");
  assert.match(f.store.run(run.id).stage, /等待后台采集/);
  assert.equal(f.analyses(), 0);
}

test("one Nightingale source waits for independent collection and preserves the actual inspection window", async (t) => {
  const f = fixture(t);
  await ready(f);
  f.rows.push(event(2, 3620), event(3, 3630), event(4, 3640));
  const run = f.engine.manual(f.task.id);
  assertWaiting(f, run);
  assert.equal(f.calls.length, 1, "inspection does not start an upstream request");
  assert.equal(f.engine.manual(f.task.id).id, run.id, "waiting runs are deduplicated");
  f.clock.now = 3660000;
  await f.engine.tick();
  await f.engine.pollPromise;
  await f.engine.drainPromise;
  const saved = f.store.run(run.id);
  assert.equal(saved.status, "completed");
  assert.equal(saved.start, 1830000);
  assert.equal(saved.end, 3630000, "waiting does not move the half-hour window");
  assert.equal(saved.sources.length, 1, "unconfigured Zabbix/Prometheus are not required");
  assert.equal(saved.sources[0].status, "ok");
  assert.deepEqual(saved.alerts.map((a) => a.nativeId), ["1", "2"]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.engine.coverageWaiters.size, 0);
});

test("all selected healthy sources must cover the frozen window before analysis starts", async (t) => {
  const second = { ...source, id: "second", name: "另一夜莺", url: "https://second.invalid" };
  const f = fixture(t, { sources: [source, second] });
  await ready(f);
  const run = f.engine.manual(f.task.id);
  assertWaiting(f, run);
  f.clock.now = 3660000;
  await f.engine.poll(source.id);
  assertWaiting(f, run);
  await f.engine.poll(second.id);
  await f.engine.drainPromise;
  const saved = f.store.run(run.id);
  assert.equal(saved.sources.length, 2);
  assert.ok(saved.sources.every((s) => s.status === "ok"));
  assert.equal(saved.end, 3630000);
});

test("an unselected incomplete source never delays or marks the selected Nightingale report incomplete", async (t) => {
  const f = fixture(t);
  await f.engine.poll();
  f.store.saveSettings({ sources: [source, { ...source, id: "unused", name: "未选来源" }], tasks: [f.task] });
  const run = f.engine.manual(f.task.id);
  await f.engine.drainPromise;
  const saved = f.store.run(run.id);
  assert.deepEqual(saved.sources.map((s) => [s.id, s.status]), [["n9e", "ok"]]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.engine.coverageWaiters.size, 0);
});

test("a bounded wait expires to an honestly incomplete local snapshot without fetching upstream", async (t) => {
  const f = fixture(t, { coverageWaitMs: 10 });
  await ready(f);
  const run = f.engine.manual(f.task.id);
  assertWaiting(f, run);
  await f.engine.drainPromise;
  const saved = f.store.run(run.id);
  assert.equal(saved.status, "completed");
  assert.equal(saved.sources[0].status, "partial");
  assert.equal(saved.end, 3630000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.engine.coverageWaiters.size, 0);
});

test("prefix gaps, failed or partial collection, stale revisions, and old watermarks are not waited away", async (t) => {
  for (const [name, changes] of [
    ["prefix gap", { coverageStart: 1831000 }],
    ["failure", { status: "failed" }],
    ["partial pagination", { status: "partial" }],
    ["no successful collection", { successAt: null }],
    ["source generation mismatch", { sourceRevision: 0 }],
    ["long backlog", { coveredUntil: 3500000 }],
  ]) await t.test(name, async (subtest) => {
    const f = fixture(subtest);
    await ready(f);
    f.store.putIngestionState(source.id, { ...f.store.ingestionState(source.id), ...changes });
    const run = f.engine.manual(f.task.id);
    assert.equal(f.engine.coverageWaiters.size, 0);
    await f.engine.drainPromise;
    assert.notEqual(f.store.run(run.id).sources[0].status, "ok");
    assert.equal(f.calls.length, 1);
  });
});

test("first collection and Alertmanager snapshots never receive invented history coverage", async (t) => {
  for (const type of ["nightingale", "alertmanager"]) await t.test(type, async (subtest) => {
    const f = fixture(subtest, { sources: [{ ...source, type }] });
    const run = f.engine.manual(f.task.id);
    assert.equal(f.engine.coverageWaiters.size, 0);
    await f.engine.drainPromise;
    const saved = f.store.run(run.id);
    assert.notEqual(saved.sources[0].status, "ok");
    assert.equal(saved.alerts.length, 0);
    assert.match(saved.report.summary, /不能判定无异常/);
    assert.equal(f.calls.length, 0);
  });
});

test("background failure wakes the waiting inspection without falsely completing coverage", async (t) => {
  const f = fixture(t);
  await ready(f);
  const run = f.engine.manual(f.task.id);
  assertWaiting(f, run);
  f.engine.fetcher = async () => { throw new Error("test upstream unavailable"); };
  f.clock.now = 3660000;
  await f.engine.poll();
  await f.engine.drainPromise;
  const saved = f.store.run(run.id);
  assert.notEqual(saved.sources[0].status, "ok");
  assert.match(saved.sources[0].note, /test upstream unavailable/);
  assert.equal(f.store.ingestionState(source.id).coveredUntil, 3600000);
  assert.equal(f.engine.coverageWaiters.size, 0);
});

test("disabling a selected source immediately wakes the wait and records it as unavailable", async (t) => {
  const f = fixture(t);
  await ready(f);
  const run = f.engine.manual(f.task.id);
  assertWaiting(f, run);
  await f.handler("source.save", { ...source, enabled: false });
  await f.engine.drainPromise;
  const saved = f.store.run(run.id);
  assert.equal(saved.sources[0].status, "failed");
  assert.match(saved.sources[0].note, /停用/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.engine.coverageWaiters.size, 0);
});

test("source identity changes during a wait cannot reuse the old connection's complete coverage", async (t) => {
  const f = fixture(t);
  await ready(f);
  const run = f.engine.manual(f.task.id);
  assertWaiting(f, run);
  f.engine.fetcher = async () => { throw new Error("new source unavailable"); };
  const changed = await f.handler("source.save", { ...source, url: "https://replacement.invalid" });
  await f.engine.pollPromise;
  await f.engine.drainPromise;
  assert.equal(changed.revision, 2);
  const saved = f.store.run(run.id);
  assert.notEqual(saved.sources[0].status, "ok");
  assert.equal(saved.alerts.length, 0, "the old source's events are not analyzed as the replacement source");
  assert.equal(f.engine.coverageWaiters.size, 0);
});

test("cancellation and Host shutdown clean up coverage waiters without analyzing", async (t) => {
  for (const operation of ["cancel", "close"]) await t.test(operation, async (subtest) => {
    const f = fixture(subtest);
    await ready(f);
    const run = f.engine.manual(f.task.id);
    assertWaiting(f, run);
    if (operation === "cancel") f.engine.cancel(run.id);
    else await f.engine.close();
    await f.engine.drainPromise;
    assert.equal(f.store.run(run.id).status, operation === "cancel" ? "cancelled" : "interrupted");
    assert.equal(f.analyses(), 0);
    assert.equal(f.engine.coverageWaiters.size, 0);
    assert.equal(f.calls.length, 1);
  });
});
