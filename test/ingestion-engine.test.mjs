import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { taskConfig } from "../src/config.mjs";
import { createHandler } from "../src/host.mjs";

const source = {
  id: "n9e",
  name: "夜莺",
  type: "nightingale",
  url: "https://n9e.invalid",
  enabled: true,
  pollIntervalSeconds: 60,
  revision: 1,
};
const event = (id, time, extra = {}) => ({
  id,
  hash: "same-rule-and-tags",
  first_trigger_time: 1700,
  trigger_time: time,
  last_eval_time: time,
  is_recovered: 0,
  recover_time: 0,
  rule_name: "接口异常",
  tags: ["instance=sw1"],
  ...extra,
});
const credentials = {
  resolve: async () => ({ value: "PERSONAL_TOKEN" }),
  set: async () => {},
  unset: async () => {},
};
const analyzer = async (prompt) => {
  const ids = [...new Set([...prompt.matchAll(/"alertId":"([^"]+)"/g)].map((m) => m[1]))];
  return JSON.stringify({
    summary: "依据本地告警原文分析",
    incidents: [{
      title: "接口异常",
      alertIds: ids,
      assessment: "观察到告警记录；当前状态未知",
      evidence: ["历史告警原文"],
      unknowns: ["未查询恢复状态"],
      actions: ["人工检查接口"],
    }],
  });
};
function fixture(t, rows = []) {
  const store = new Store(":memory:");
  store.saveSettings({ sources: [source], tasks: [] });
  const clock = { now: 3600000 };
  const calls = [];
  const engines = [];
  const fetcher = async (url, options) => {
    calls.push({ url: new URL(url), options });
    const start = Number(url.searchParams.get("stime"));
    const end = Number(url.searchParams.get("etime"));
    const list = rows.filter((r) => r.last_eval_time >= start && r.last_eval_time <= end);
    return Response.json({ dat: { list, total: list.length }, err: "" });
  };
  const createEngine = (overrides = {}) => {
    const engine = new Engine({
      store,
      credentials,
      now: () => clock.now,
      fetcher,
      analyze: analyzer,
      getIm: () => null,
      ...overrides,
    });
    engines.push(engine);
    return engine;
  };
  t.after(async () => {
    for (const engine of engines) await engine.close();
    store.close();
  });
  return { store, clock, calls, rows, createEngine, engine: createEngine() };
}
function inspection(minutes, sources = [source]) {
  return taskConfig({
    name: `${minutes} 分钟巡检`,
    sourceIds: sources.map((s) => s.id),
    workspace: "/opt/ops",
    intervalMinutes: minutes,
    deliveryMode: "off",
  }, sources);
}

test("enabled sources ingest locally even when no inspection task exists", async (t) => {
  const { engine, store, calls } = fixture(t, [
    event(1, 1900),
    event(2, 3500),
    event(3, 3550, { is_recovered: 1, recover_time: 3550 }),
  ]);
  await engine.poll();
  assert.equal(store.getSettings().tasks.length, 0);
  assert.equal(store.runs().length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get("stime"), "1800");
  assert.equal(calls[0].url.searchParams.get("etime"), "3599");
  assert.equal(calls[0].options.headers["X-User-Token"], "PERSONAL_TOKEN");
  assert.deepEqual(store.alerts(source.id, 1800000, 3600000).map((a) => a.nativeId), ["1", "2"]);
  assert.equal(store.ingestionInfo(source.id).count, 2);
  assert.equal(store.ingestionState(source.id).coveredUntil, 3600000);
});

test("inspection intervals select independent recent local windows without network requests", async (t) => {
  const { engine, store, calls } = fixture(t, [event(1, 1900), event(2, 3500)]);
  await engine.poll();
  const thirty = inspection(30), five = inspection(5);
  store.saveSettings({ sources: [source], tasks: [thirty, five] });
  engine.fetcher = () => { throw new Error("Inspection must not fetch upstream"); };
  const longRun = engine.manual(thirty.id);
  await engine.drainPromise;
  const shortRun = engine.manual(five.id);
  await engine.drainPromise;
  const longResult = store.run(longRun.id), shortResult = store.run(shortRun.id);
  assert.equal(longResult.start, 1800000);
  assert.equal(longResult.end, 3600000);
  assert.equal(shortResult.start, 3300000);
  assert.equal(shortResult.end, 3600000);
  assert.deepEqual(longResult.alerts.map((a) => a.nativeId), ["1", "2"]);
  assert.deepEqual(shortResult.alerts.map((a) => a.nativeId), ["2"]);
  assert.equal(longResult.status, "completed");
  assert.equal(shortResult.status, "completed");
  assert.equal(calls.length, 1);
});

test("background polling honors its own cadence and deduplicates overlapping reads", async (t) => {
  const { engine, store, calls, rows, clock } = fixture(t, [event(1, 3500)]);
  await engine.poll();
  await engine.poll();
  assert.equal(calls.length, 1);
  clock.now += 60000;
  rows.push(event(2, 3630));
  await engine.poll();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.searchParams.get("stime"), "3480");
  assert.equal(store.ingestionInfo(source.id).count, 2);
  assert.equal(store.ingestionState(source.id).coveredUntil, 3660000);
});

test("failed polling preserves the watermark and a restarted engine resumes from it", async (t) => {
  const { engine, store, calls, rows, clock, createEngine } = fixture(t, [event(1, 3500)]);
  await engine.poll();
  clock.now += 60000;
  engine.fetcher = async () => { throw new Error("upstream unavailable"); };
  await engine.poll();
  assert.equal(store.ingestionState(source.id).coveredUntil, 3600000);
  assert.equal(store.ingestionState(source.id).status, "failed");
  await engine.close();
  clock.now += 60000;
  rows.push(event(2, 3670));
  const restarted = createEngine();
  restarted.initialize();
  await restarted.poll();
  assert.equal(calls.at(-1).url.searchParams.get("stime"), "3480");
  assert.equal(store.ingestionState(source.id).coveredUntil, 3720000);
  assert.deepEqual(store.alerts(source.id, 1800000, 3720000).map((a) => a.nativeId), ["1", "2"]);
});

test("partial polling saves available events but cannot mark a report window complete", async (t) => {
  const { engine, store } = fixture(t);
  let page = 0;
  engine.fetcher = async () => Response.json({
    dat: { total: 2, list: page++ === 0 ? [event(1, 3500)] : [] },
  });
  await engine.poll();
  assert.equal(store.ingestionInfo(source.id).count, 1);
  assert.equal(store.ingestionState(source.id).coveredUntil, 1800000);
  assert.equal(store.ingestionState(source.id).status, "partial");
  const task = inspection(30);
  store.saveSettings({ sources: [source], tasks: [task] });
  const run = engine.manual(task.id);
  await engine.drainPromise;
  const result = store.run(run.id);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.sources[0].status, "partial");
  assert.equal(page, 2);
});

test("an inspection without local coverage reports incomplete data instead of fetching upstream", async (t) => {
  const { engine, store, calls } = fixture(t);
  const task = inspection(30);
  store.saveSettings({ sources: [source], tasks: [task] });
  const run = engine.manual(task.id);
  await engine.drainPromise;
  const result = store.run(run.id);
  assert.equal(calls.length, 0);
  assert.equal(result.alerts.length, 0);
  assert.notEqual(result.sources[0].status, "ok");
  assert.match(result.report.summary, /不能判定无异常/);
});

test("a late scheduler runs one recent interval without replaying old inspection windows", async (t) => {
  const { engine, store, clock } = fixture(t, [event(1, 3500)]);
  const task = { ...inspection(30), enabled: true, nextEnd: clock.now - 3600000 };
  store.saveSettings({ sources: [source], tasks: [task] });
  await engine.tick();
  await engine.pollPromise;
  await engine.drainPromise;
  const runs = store.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].start, clock.now - 1800000);
  assert.equal(runs[0].end, clock.now);
  assert.ok(store.getSettings().tasks[0].nextEnd > clock.now);
  await engine.tick();
  assert.equal(store.runs().length, 1);
});

test("a queued inspection reads the interval before actual execution, not queue time", async (t) => {
  const { engine, store, clock, rows } = fixture(t, [event(1, 1830), event(2, 3500)]);
  await engine.poll();
  const task = { ...inspection(30), enabled: true, nextEnd: clock.now };
  store.saveSettings({ sources: [source], tasks: [task] });
  engine.busy = true;
  await engine.tick();
  await engine.pollPromise;
  const queued = store.runs()[0];
  assert.equal(queued.status, "queued");
  assert.equal(queued.end, 3600000);

  clock.now += 60000;
  rows.push(event(3, 3630));
  await engine.poll();
  engine.busy = false;
  engine.drain();
  await engine.drainPromise;
  const result = store.run(queued.id);
  assert.equal(result.start, 1860000);
  assert.equal(result.end, 3660000);
  assert.deepEqual(result.alerts.map((a) => a.nativeId), ["2", "3"]);
  assert.equal(store.window(task.id, 1800000, 3600000), null);
  assert.equal(store.window(task.id, 1860000, 3660000).id, queued.id);
});

test("disabled sources and storage migration pauses do not make upstream requests", async (t) => {
  const { engine, store, calls } = fixture(t, [event(1, 3500)]);
  store.saveSettings({ sources: [{ ...source, enabled: false }], tasks: [] });
  await engine.poll();
  assert.equal(calls.length, 0);
  store.saveSettings({ sources: [source], tasks: [] });
  engine.paused = true;
  await engine.poll();
  assert.equal(calls.length, 0);
  engine.paused = false;
  await engine.poll();
  assert.equal(calls.length, 1);
});

test("overlapping background ticks share one active source request", async (t) => {
  const { engine } = fixture(t);
  let release, started;
  const began = new Promise((resolve) => { started = resolve; });
  const response = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  engine.fetcher = async () => {
    calls++;
    started();
    await response;
    return Response.json({ dat: { list: [], total: 0 } });
  };
  const first = engine.poll();
  await began;
  const second = engine.poll();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("saving an enabled source starts collection before any task is configured", async (t) => {
  const { engine, store, calls } = fixture(t, [event(1, 3500)]);
  store.saveSettings({ sources: [], tasks: [] });
  const handler = createHandler({ store, engine, credentials, getIm: () => null });
  const saved = await handler("source.save", { ...source, id: undefined, token: "PERSONAL_TOKEN" });
  await engine.pollPromise;
  assert.equal(calls.length, 1);
  assert.equal(store.ingestionInfo(saved.id).count, 1);
  assert.equal(store.getSettings().tasks.length, 0);
});

test("changing a source endpoint preserves old records without mixing them into new inspections", async (t) => {
  const { engine, store, rows } = fixture(t, [event(1, 3500, { rule_name: "旧平台" })]);
  await engine.poll();
  rows.splice(0, rows.length, event(1, 3550, { rule_name: "新平台" }));
  const handler = createHandler({ store, engine, credentials, getIm: () => null });
  const saved = await handler("source.save", {
    ...source, url: "https://replacement.invalid", token: "REPLACEMENT_TOKEN",
  });
  await engine.pollPromise;
  assert.equal(saved.revision, source.revision + 1);
  assert.equal(store.ingestionInfo(source.id).count, 2);
  const task = inspection(30, [saved]);
  store.saveSettings({ sources: [saved], tasks: [task] });
  const run = engine.manual(task.id);
  await engine.drainPromise;
  const result = store.run(run.id);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].raw.rule_name, "新平台");
});

test("a source disabled during its request cannot commit the stale response", async (t) => {
  const { engine, store } = fixture(t);
  let release, started;
  const began = new Promise((resolve) => { started = resolve; });
  const response = new Promise((resolve) => { release = resolve; });
  engine.fetcher = async () => {
    started();
    await response;
    return Response.json({ dat: { list: [event(1, 3500)], total: 1 } });
  };
  const polling = engine.poll();
  await began;
  store.saveSettings({ sources: [{ ...source, enabled: false }], tasks: [] });
  release();
  await polling;
  assert.equal(store.ingestionInfo(source.id).count, 0);
  assert.equal(store.ingestionState(source.id).coveredUntil, 1800000);
});

test("a source edited while credentials resolve cannot send the new token to its old URL", async (t) => {
  const { engine, store, calls, clock } = fixture(t);
  let release, started;
  const began = new Promise((resolve) => { started = resolve; });
  const credential = new Promise((resolve) => { release = resolve; });
  engine.credentials = {
    resolve: async () => {
      started();
      await credential;
      return { value: "NEW_PLATFORM_SECRET" };
    },
  };
  const polling = engine.poll();
  await began;
  clock.now += 60000;
  const replacement = {
    ...source,
    revision: source.revision + 1,
    url: "https://replacement.invalid",
  };
  store.saveSettings({ sources: [replacement], tasks: [] });
  engine.ensureIngestion(replacement);
  const replacementState = store.ingestionState(source.id);
  release();
  await polling;
  assert.equal(calls.length, 0);
  assert.deepEqual(store.ingestionState(source.id), replacementState);
  assert.equal(store.ingestionState(source.id).sourceRevision, replacement.revision);
});

test("concurrent saves serialize credentials and assign distinct source generations", async (t) => {
  const { engine, store } = fixture(t);
  const original = { ...source, revision: 0 };
  store.saveSettings({ sources: [original], tasks: [] });
  let releaseA, releaseB, startedA, startedB;
  const waitA = new Promise((resolve) => { releaseA = resolve; });
  const waitB = new Promise((resolve) => { releaseB = resolve; });
  const beganA = new Promise((resolve) => { startedA = resolve; });
  const beganB = new Promise((resolve) => { startedB = resolve; });
  let secret = "OLD_TOKEN";
  const writes = [];
  const savedCredentials = {
    resolve: async () => ({ value: secret }),
    set: async (_, value) => {
      writes.push(value);
      if (value === "TOKEN_A") {
        startedA();
        await waitA;
      } else {
        startedB();
        await waitB;
      }
      secret = value;
    },
  };
  engine.credentials = savedCredentials;
  engine.fetcher = async (url) => Response.json({
    dat: { total: 1, list: [event(1, 3500, { rule_name: url.hostname })] },
  });
  const handler = createHandler({ store, engine, credentials: savedCredentials, getIm: () => null });
  const first = handler("source.save", {
    ...original, url: "https://a.invalid", token: "TOKEN_A",
  });
  await beganA;
  const second = handler("source.save", {
    ...original, url: "https://b.invalid", token: "TOKEN_B",
  });
  // Keep both operations pending so the second cannot derive its revision
  // from the old source while the first credential write is awaiting I/O.
  await Promise.resolve();
  const writesBeforeFirstRelease = [...writes];
  releaseA();
  const savedA = await first;
  await beganB;
  await engine.pollPromise;
  releaseB();
  const savedB = await second;
  await engine.pollPromise;

  assert.deepEqual(writesBeforeFirstRelease, ["TOKEN_A"]);
  assert.equal(savedA.revision, 1);
  assert.equal(savedB.revision, 2);
  const records = store.alerts(source.id, 1800000, 3600000);
  assert.equal(records.length, 2);
  assert.deepEqual(new Set(records.map((a) => a.sourceRevision)), new Set([1, 2]));
  assert.deepEqual(new Set(records.map((a) => a.raw.rule_name)), new Set(["a.invalid", "b.invalid"]));
  assert.ok(records.every((a) => a.nativeId === "1"));
});

test("refreshes waiting on a poll each force their own source collection", async (t) => {
  const { engine, store } = fixture(t);
  const sources = [
    { ...source, id: "a", url: "https://a.invalid" },
    { ...source, id: "b", url: "https://b.invalid" },
  ];
  store.saveSettings({ sources, tasks: [] });
  let release, started;
  const began = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const hosts = [];
  engine.fetcher = async (url) => {
    hosts.push(url.hostname);
    if (hosts.length === 1) {
      started();
      await blocked;
    }
    return Response.json({ dat: { total: 0, list: [] } });
  };
  const initial = engine.poll();
  await began;
  const refreshA = engine.refreshSource("a");
  const refreshB = engine.refreshSource("b");
  release();
  await Promise.all([initial, refreshA, refreshB]);
  assert.deepEqual(hosts, ["a.invalid", "b.invalid", "a.invalid", "b.invalid"]);
});
