import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.mjs";
import { Store } from "../src/store.mjs";
import { taskConfig } from "../src/config.mjs";
import { createDshAnalyzer } from "../src/dsh.mjs";

const now = 3600000;
const source = {
  id: "n9e", name: "测试夜莺", type: "nightingale", enabled: true,
  url: "https://n9e.invalid", pollIntervalSeconds: 60, revision: 0,
};
const alert = {
  alertId: "n9e:1", sourceId: source.id, sourceName: source.name,
  sourceType: source.type, sourceRevision: 0, nativeId: "1",
  host: "test-host", title: "接口丢包", first: now - 10000,
  eventTime: now - 10000, raw: { rule_name: "接口丢包" },
};

function fixture(t, { status = "ok", alerts = [], unavailable = false } = {}) {
  const store = new Store(":memory:");
  const task = taskConfig({
    name: "半小时巡检", sourceIds: [source.id], intervalMinutes: 30,
    workspace: "/opt/ops", deliveryMode: "off", allowedTools: [],
  }, [source]);
  store.saveSettings({ sources: [{ ...source, enabled: !unavailable }], tasks: [task] });
  store.commitIngestion(source.id, alerts, {
    sourceRevision: 0, status, coverageStart: now - 1800000,
    coveredUntil: status === "ok" ? now : now - 100000,
    successAt: status === "ok" ? now : now - 100000,
    at: now, note: status === "failed" ? "后台接口返回非 JSON" : "测试采集结果",
  });

  const calls = { create: [], prompt: [] };
  const agents = new Map(), listeners = new Set();
  const emit = (sessionId, type, data) => {
    for (const listener of listeners) listener({ id: sessionId }, { type, data });
  };
  const ctx = {
    agents: { get: (id) => agents.get(id) },
    on: (_name, listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    sessionController: {
      create: async (options) => {
        calls.create.push(options);
        const sessionId = `session-${calls.create.length}`;
        agents.set(sessionId, { ctx: { tools: { restrict() {}, guard() {} } } });
        return { sessionId };
      },
      rename: async () => {},
      cancel: async () => {},
      prompt: async (request) => {
        calls.prompt.push(request);
        const text = JSON.stringify({
          summary: "观察到接口丢包，根因待核查",
          incidents: [{
            title: "接口丢包", alertIds: [alert.alertId], assessment: "告警记录显示丢包",
            evidence: ["原始告警记录"], unknowns: ["根因未确认"], actions: ["检查接口指标"],
          }],
        });
        emit(request.sessionId, "assistant/message", { stream: [{ type: "text-chunks", texts: [text] }] });
        emit(request.sessionId, "turn/end", { reason: { kind: "completed" } });
        return { accepted: true };
      },
    },
  };
  const engine = new Engine({
    store, now: () => now, coverageWaitMs: 0,
    credentials: { resolve: async () => ({ value: "TEST_TOKEN" }) },
    fetcher: async () => { throw new Error("inspection must read the local alert store"); },
    analyze: createDshAnalyzer(ctx), getIm: () => null,
  });
  engine.initialize();
  t.after(async () => { await engine.close(); store.close(); });
  return { store, task, engine, calls };
}

function assertEmptyReport(f, run, expectedStatus, version) {
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.version, version);
  assert.equal(run.start, now - 1800000);
  assert.equal(run.end, now);
  assert.deepEqual(run.alerts, []);
  assert.equal(run.sources.length, 1);
  assert.equal(run.sources[0].id, source.id);
  assert.equal(run.sources[0].status, expectedStatus);
  assert.equal(run.analyzed, 0);
  assert.deepEqual(run.sessions, []);
  assert.equal(f.calls.create.length, 0, "an empty inspection must not create a DSH session");
  assert.equal(f.calls.prompt.length, 0, "an empty inspection must not prompt an existing DSH session");
  assert.deepEqual(run.report.incidents, []);
  assert.deepEqual(run.report.coveredIds, []);
  assert.ok(run.report.summary);
  if (expectedStatus !== "ok") assert.match(run.report.summary, /不能判定无异常/);
  assert.match(f.engine.report(run.id).markdown, /告警 0 条/);
  assert.equal(f.store.runs().length, 1, "reanalysis must update the existing saved report");
}

for (const mode of ["scheduled", "manual", "reanalysis"]) {
  test(`${mode} empty inspections save reports without creating or prompting DSH sessions`, async (t) => {
    for (const scenario of [
      { name: "complete source", status: "ok", expectedStatus: "ok" },
      { name: "partial collection", status: "partial", expectedStatus: "partial" },
      { name: "failed collection", status: "failed", expectedStatus: "partial" },
      { name: "selected source unavailable", unavailable: true, expectedStatus: "failed" },
    ]) await t.test(scenario.name, async (t) => {
      const f = fixture(t, scenario);
      if (mode === "scheduled") {
        const config = f.store.getSettings();
        config.tasks[0] = { ...f.task, enabled: true, nextEnd: now };
        f.store.saveSettings(config);
        await f.engine.tick();
        await f.engine.pollPromise;
      } else {
        f.engine.manual(f.task.id);
      }
      await f.engine.drainPromise;
      const [initial] = f.store.runs();
      assert.ok(initial, "the inspection must persist a report even without model work");
      assertEmptyReport(f, initial, scenario.expectedStatus, 1);
      if (scenario.status === "failed") assert.equal(initial.sources[0].coverage.kind, "failed");
      if (mode === "reanalysis") {
        f.engine.retry(initial.id);
        await f.engine.drainPromise;
        assertEmptyReport(f, f.store.run(initial.id), scenario.expectedStatus, 2);
      }
    });
  });
}

test("a nonempty inspection uses the same DSH adapter and records exactly one created session", async (t) => {
  const f = fixture(t, { alerts: [alert] });
  const queued = f.engine.manual(f.task.id);
  await f.engine.drainPromise;
  const run = f.store.run(queued.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.prompt.length, 1);
  assert.equal(f.calls.create[0].cwd, f.task.workspace);
  assert.deepEqual(run.sessions, ["session-1"]);
  assert.equal(f.calls.prompt[0].sessionId, run.sessions[0]);
  assert.equal(run.alerts.length, 1);
  assert.equal(run.analyzed, 1);
  assert.deepEqual(run.report.coveredIds, [alert.alertId]);
  assert.equal(run.analysisOutputs[0].sessionId, run.sessions[0]);
});
