import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.mjs";
import { Store } from "../src/store.mjs";
import { taskConfig } from "../src/config.mjs";

const now = 3600000;
const source = {
  id: "n9e", name: "测试夜莺", type: "nightingale", enabled: true,
  url: "https://n9e.invalid", pollIntervalSeconds: 60, revision: 0,
};
const alert = {
  alertId: "n9e:1", sourceId: "n9e", sourceName: "测试夜莺", sourceType: "nightingale",
  nativeId: "1", host: "test-host", title: "测试告警", eventTime: 3590000,
  first: 3590000, sourceRevision: 0, raw: { rule_name: "测试告警" },
};
const report = {
  summary: "观察到告警，根因待验证", coveredIds: [alert.alertId],
  incidents: [{ title: "测试事件", alertIds: [alert.alertId], assessment: "根因待验证",
    evidence: ["告警记录"], unknowns: ["缺少指标"], actions: ["查询指标"] }],
};

function fixture(t, { alerts = [], mode = "auto", sendDataOnFailure = true } = {}) {
  const store = new Store(":memory:");
  const task = taskConfig({
    name: "半小时巡检", sourceIds: [source.id], intervalMinutes: 30,
    workspace: "/opt/ops", deliveryMode: mode, sendDataOnFailure,
    targets: [{ botId: "test-bot", targetId: "test-group", channel: "feishu" }],
  }, [source]);
  store.saveSettings({ sources: [source], tasks: [task] });
  store.commitIngestion(source.id, alerts, {
    sourceRevision: 0, status: "ok", coverageStart: 1800000,
    coveredUntil: now, successAt: now, at: now,
  });
  const sent = [];
  let imLookups = 0;
  const engine = new Engine({
    store, now: () => now, coverageWaitMs: 0,
    credentials: { resolve: async () => ({ value: "TEST_TOKEN" }) },
    fetcher: async () => { throw new Error("unexpected upstream request"); },
    analyze: async () => JSON.stringify(report),
    getIm: () => {
      imLookups++;
      return { send: async (...args) => { sent.push(args); return { sent: true }; } };
    },
  });
  t.after(async () => { await engine.close(); store.close(); });
  const savedRun = (id = "run", overrides = {}) => ({
    id, taskId: task.id, task, start: 1800000, end: now, version: 1,
    status: "completed", stage: "分析完成", alerts: structuredClone(alerts),
    sources: [{ id: source.id, name: source.name, status: "ok", count: alerts.length }],
    sessions: [], report: alerts.length ? report : { summary: "窗口内无告警", incidents: [], coveredIds: [] },
    ...overrides,
  });
  return { store, task, engine, sent, savedRun, imLookups: () => imLookups };
}

test("scheduled empty inspections stay local without creating deliveries or looking up IM", async (t) => {
  const f = fixture(t);
  f.store.saveSettings({ sources: [source], tasks: [{ ...f.task, enabled: true, nextEnd: now }] });
  await f.engine.tick();
  await f.engine.drainPromise;
  await f.engine.pollPromise;
  const runs = f.store.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "completed");
  assert.equal(runs[0].alerts.length, 0);
  assert.equal(runs[0].start, 1800000);
  assert.equal(runs[0].end, now);
  assert.ok(runs[0].report);
  assert.deepEqual(f.store.deliveries(), []);
  assert.equal(f.imLookups(), 0);
});

test("manual inspections with complete, partial, or failed empty sources stay local", async (t) => {
  for (const status of ["ok", "partial", "failed"]) await t.test(status, async (t) => {
    const f = fixture(t);
    if (status !== "ok") f.store.putIngestionState(source.id, {
      sourceRevision: 0, status, coverageStart: 1800000,
      coveredUntil: 3500000, successAt: 3500000, at: now, note: "测试覆盖缺口",
    });
    const queued = f.engine.manual(f.task.id);
    await f.engine.drainPromise;
    const run = f.store.run(queued.id);
    assert.equal(run.status, "completed");
    assert.equal(run.alerts.length, 0);
    assert.equal(run.sources[0].status, status === "ok" ? "ok" : "partial");
    if (status !== "ok") assert.match(run.report.summary, /不能判定无异常/);
    assert.deepEqual(await f.engine.deliver(run.id), { skipped: true, reason: "no-alerts" });
    assert.deepEqual(f.store.deliveries(), []);
    assert.equal(f.imLookups(), 0);
  });
});

test("sendDataOnFailure cannot send a failed run with no collected alerts", async (t) => {
  const f = fixture(t, { sendDataOnFailure: true });
  f.engine.waitForLocalCoverage = () => { throw new Error("测试本地读取失败"); };
  const queued = f.engine.manual(f.task.id);
  await f.engine.drainPromise;
  const run = f.store.run(queued.id);
  assert.equal(run.status, "failed");
  assert.match(run.error, /测试本地读取失败/);
  assert.equal(run.alerts.length, 0);
  assert.deepEqual(await f.engine.deliver(run.id), { skipped: true, reason: "no-alerts" });
  assert.deepEqual(f.store.deliveries(), []);
  assert.equal(f.imLookups(), 0);
});

test("restarted legacy pending empty messages are skipped once and cannot be retried", async (t) => {
  const f = fixture(t);
  f.store.putRun(f.savedRun());
  f.store.putDelivery({
    id: "legacy-empty", runId: "run", version: 1, status: "pending", attempts: 2,
    botId: "test-bot", targetId: "test-group", text: "旧版 0/0 通知", nextAttempt: now,
  });
  f.engine.initialize();
  await f.engine.tick();
  await f.engine.pollPromise;
  const saved = f.store.delivery("legacy-empty");
  assert.equal(saved.status, "skipped");
  assert.equal(saved.attempts, 2);
  assert.equal(saved.nextAttempt, undefined);
  assert.equal(saved.skippedAt, now);
  assert.match(saved.error, /采集到 0 条告警/);
  await f.engine.tick();
  await f.engine.pollPromise;
  await assert.rejects(f.engine.retryDelivery(saved.id), /无法重试/);
  assert.deepEqual(f.store.delivery(saved.id), saved);
  assert.equal(f.imLookups(), 0);
});

test("accepted and unknown empty delivery history is preserved without resending", async (t) => {
  const f = fixture(t);
  f.store.putRun(f.savedRun());
  for (const status of ["accepted", "unknown"]) {
    const row = { id: status, runId: "run", version: 1, status, text: "旧记录", attempts: 1 };
    f.store.putDelivery(row);
    await f.engine.sendDelivery({ ...row });
    assert.deepEqual(f.store.delivery(status), row);
  }
  await assert.rejects(f.engine.retryDelivery("accepted"), /无法重试/);
  await assert.rejects(f.engine.retryDelivery("unknown"), /确认/);
  assert.deepEqual(await f.engine.retryDelivery("unknown", true), { skipped: true, reason: "no-alerts" });
  assert.equal(f.store.delivery("unknown").status, "unknown");
  assert.equal(f.imLookups(), 0);
});

test("a missing report is not treated as proof that a legacy message has no alerts", async (t) => {
  const f = fixture(t);
  const row = { id: "legacy-orphan", runId: "missing", status: "pending", attempts: 0,
    botId: "b", targetId: "g", text: "保留的旧投递内容" };
  f.store.putDelivery(row);
  await f.engine.sendDelivery(row);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][3].format, "plain");
  assert.equal(f.store.delivery(row.id).status, "accepted");
});

test("new nonempty reports use Markdown and remain idempotent", async (t) => {
  const f = fixture(t, { alerts: [alert], mode: "manual" });
  f.store.putRun(f.savedRun());
  await f.engine.deliver("run");
  await f.engine.deliver("run");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][3].format, "markdown");
  assert.equal(f.store.deliveries()[0].format, "markdown");
  assert.equal(f.store.deliveries()[0].alertCount, 1);
  assert.equal(f.store.deliveries()[0].status, "accepted");
});

test("nonempty failed analysis still follows sendDataOnFailure", async (t) => {
  for (const sendDataOnFailure of [true, false]) await t.test(String(sendDataOnFailure), async (t) => {
    const f = fixture(t, { alerts: [alert], sendDataOnFailure });
    f.engine.analyze = async () => { throw new Error("测试模型失败"); };
    const queued = f.engine.manual(f.task.id);
    await f.engine.drainPromise;
    const run = f.store.run(queued.id);
    assert.equal(run.status, "failed");
    assert.equal(run.alerts.length, 1);
    assert.equal(f.sent.length, sendDataOnFailure ? 1 : 0);
    assert.equal(f.store.deliveries().length, sendDataOnFailure ? 1 : 0);
    if (sendDataOnFailure) assert.match(f.sent[0][2], /分析未完成/);
  });
});
