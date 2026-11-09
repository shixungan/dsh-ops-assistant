import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRun, parseAnalysis } from "../src/analysis.mjs";
import { createDshAnalyzer } from "../src/dsh.mjs";
import { Engine } from "../src/engine.mjs";
import { Store } from "../src/store.mjs";
import { createHandler } from "../src/host.mjs";

const task = {
  id: "task-format", name: "格式回归", sourceIds: ["s"], enabled: false,
  workspace: "/opt/ops", instructions: "保留观察事实与不确定性。",
  allowedTools: ["read_metrics"], maxBatchChars: 20000,
  timeoutMinutes: 15, intervalMinutes: 30, deliveryMode: "off", targets: [],
};
const query = 'ping_percent_packet_loss{project="test"} > 5';
const document = (ids = ["s:1"]) => ({
  summary: "已观察到丢包，原因待验证",
  incidents: [{
    title: "测试丢包", alertIds: ids, assessment: "单点告警不证明持续异常",
    evidence: [`原文指标：${query}`], unknowns: ["缺少时序数据"],
    actions: [`查询指标 ${query}`],
  }],
});
const output = (ids) => JSON.stringify(document(ids));
// Reproduces the two syntax defects without copying real infrastructure data.
const malformed = (ids) => output(ids)
  .replaceAll('\\"test\\"', '"test"')
  .replace(/\]\}\]\}$/, "}]}");
const makeRun = (ids = ["s:1"]) => ({
  id: "run-format", taskId: task.id, task: structuredClone(task),
  start: 0, end: 2000, version: 1, sessions: [],
  alerts: ids.map((alertId) => ({ alertId, host: "test-probe", raw: {} })),
  sources: [{ id: "s", name: "测试夜莺", status: "partial", count: ids.length }],
});
function progressFor(run) {
  const updates = [];
  const progress = (data) => {
    updates.push(structuredClone(data));
    Object.assign(run, data);
  };
  progress.session = (id) => run.sessions.push(id);
  progress.updates = updates;
  return progress;
}

test("malformed quotes and a missing array bracket receive one tool-free format retry", async () => {
  const run = makeRun();
  const progress = progressFor(run);
  const signal = new AbortController().signal;
  const raw = malformed();
  const valid = output();
  assert.throws(() => JSON.parse(raw), SyntaxError);
  let calls = 0;
  const report = await analyzeRun(run, task, async (prompt, options, receivedSignal, onSession) => {
    assert.equal(receivedSignal, signal);
    onSession(`session-${++calls}`);
    if (calls === 1) {
      assert.deepEqual(options.allowedTools, ["read_metrics"]);
      return raw;
    }
    assert.equal(calls, 2);
    assert.equal(options.formatOnly, true);
    assert.deepEqual(options.allowedTools, []);
    assert.equal(options.workspace, task.workspace);
    assert.ok(prompt.includes(JSON.stringify(raw)));
    assert.equal(run.analysisOutputs[0].text, raw, "failure is saved before repair starts");
    assert.ok(run.analysisOutputs[0].error);
    return valid;
  }, signal, progress);
  assert.equal(calls, 2);
  assert.deepEqual(report, parseAnalysis(valid, ["s:1"]));
  assert.equal(report.incidents[0].evidence[0], `原文指标：${query}`);
  assert.deepEqual(run.sessions, ["session-1", "session-2"]);
  assert.deepEqual(run.analysisOutputs.map((row) => row.text), [raw, valid]);
  assert.deepEqual(run.analysisOutputs.map((row) => row.kind), ["analysis", "format-repair"]);
  assert.deepEqual(run.analysisOutputs.map((row) => row.sessionId), ["session-1", "session-2"]);
  assert.ok(run.analysisOutputs.every((row) => row.version === 1));
  assert.equal(run.analysisOutputs[1].error, null);
  assert.ok(progress.updates.some((update) => update.analysisOutputs?.length === 1));
  assert.deepEqual(task.allowedTools, ["read_metrics"], "repair must not mutate task tool permissions");
});

test("valid output is saved and parsed without a format retry", async () => {
  const run = makeRun();
  let calls = 0;
  await analyzeRun(run, task, async () => { calls++; return output(); },
    new AbortController().signal, progressFor(run));
  assert.equal(calls, 1);
  assert.equal(run.analysisOutputs.length, 1);
  assert.equal(run.analysisOutputs[0].text, output());
  assert.equal(run.analysisOutputs[0].error, null);
});

test("a second malformed reply fails without a third attempt and retains both replies", async () => {
  const run = makeRun();
  let calls = 0;
  await assert.rejects(analyzeRun(run, task, async () => {
    calls++;
    return malformed();
  }, new AbortController().signal, progressFor(run)), /自动修正后仍未通过校验/);
  assert.equal(calls, 2);
  assert.equal(run.analysisOutputs.length, 2);
  assert.ok(run.analysisOutputs.every((row) => row.error && row.text === malformed()));
});

test("schema defects and missing or fabricated IDs are not retried as syntax errors", async (t) => {
  for (const [label, raw] of [
    ["missing ID", JSON.stringify({ summary: "不完整", incidents: [] })],
    ["fabricated ID", output(["s:invented"])],
    ["invalid array item", JSON.stringify({ ...document(), incidents: [{ ...document().incidents[0], evidence: [3] }] })],
    ["null root", "null"],
  ]) await t.test(label, async () => {
    const run = makeRun();
    let calls = 0;
    await assert.rejects(analyzeRun(run, task, async () => { calls++; return raw; },
      new AbortController().signal, progressFor(run)));
    assert.equal(calls, 1);
    assert.equal(run.analysisOutputs[0].text, raw);
    assert.ok(run.analysisOutputs[0].error);
  });
});

test("format repair still rejects omitted IDs, invented IDs and invalid schemas", async (t) => {
  for (const [label, repaired] of [
    ["omitted", JSON.stringify({ summary: "不完整", incidents: [] })],
    ["invented", output(["s:invented"])],
    ["schema", JSON.stringify({ ...document(), incidents: [{ ...document().incidents[0], actions: "query" }] })],
  ]) await t.test(label, async () => {
    const run = makeRun();
    let calls = 0;
    await assert.rejects(analyzeRun(run, task, async () => ++calls === 1 ? malformed() : repaired,
      new AbortController().signal, progressFor(run)), /自动修正后仍未通过校验/);
    assert.equal(calls, 2);
    assert.equal(run.analysisOutputs[1].text, repaired);
    assert.ok(run.analysisOutputs[1].error);
  });
});

test("format repair cannot rewrite conclusions or add evidence even with matching IDs", async (t) => {
  for (const field of ["assessment", "evidence"]) await t.test(field, async () => {
    const run = makeRun();
    const changed = document();
    if (field === "assessment") changed.incidents[0].assessment = "已证实设备故障";
    else changed.incidents[0].evidence.push("新增但未经查询验证的事实");
    let calls = 0;
    await assert.rejects(analyzeRun(run, task, async () => ++calls === 1 ? malformed() : JSON.stringify(changed),
      new AbortController().signal, progressFor(run)), /格式修正改变了原回复内容/);
    assert.equal(calls, 2);
    assert.equal(run.analysisOutputs[1].text, JSON.stringify(changed));
    assert.ok(run.analysisOutputs[1].error);
  });
});

test("cancellation after a complete malformed reply preserves it and starts no repair", async () => {
  const run = makeRun();
  const control = new AbortController();
  const reason = new Error("test cancellation");
  let calls = 0;
  await assert.rejects(analyzeRun(run, task, async () => {
    calls++;
    control.abort(reason);
    return malformed();
  }, control.signal, progressFor(run)), (error) => error === reason);
  assert.equal(calls, 1);
  assert.equal(run.analysisOutputs[0].text, malformed());
  assert.equal(run.analysisOutputs[0].error, reason.message);
});

test("cancellation during format repair propagates without accepting the repaired report", async () => {
  const run = makeRun();
  const control = new AbortController();
  const reason = new Error("repair timed out");
  let calls = 0;
  await assert.rejects(analyzeRun(run, task, async () => {
    if (++calls === 1) return malformed();
    control.abort(reason);
    return output();
  }, control.signal, progressFor(run)), (error) => error === reason);
  assert.equal(calls, 2);
  assert.equal(run.analysisOutputs[1].text, output());
  assert.equal(run.analysisOutputs[1].error, reason.message);
});

test("an analyzer failure before a reply is not treated as a reply syntax error", async () => {
  const run = makeRun();
  const error = new SyntaxError("transport decoding failed");
  let calls = 0;
  await assert.rejects(analyzeRun(run, task, async () => { calls++; throw error; },
    new AbortController().signal, progressFor(run)), (value) => value === error);
  assert.equal(calls, 1);
  assert.equal(run.analysisOutputs?.length ?? 0, 0);
});

test("a malformed cross-batch merge is repaired while retaining all input IDs", async () => {
  const run = makeRun(["s:1", "s:2"]);
  for (const alert of run.alerts) alert.raw = { detail: "x".repeat(700) };
  const options = { ...task, maxBatchChars: 1200 };
  let calls = 0;
  const replies = [output(["s:1"]), output(["s:2"]), malformed(["s:1", "s:2"]), output(["s:1", "s:2"])];
  const report = await analyzeRun(run, options, async (_, receivedTask) => {
    calls++;
    assert.equal(receivedTask.formatOnly === true, calls === 4);
    return replies[calls - 1];
  }, new AbortController().signal, progressFor(run));
  assert.equal(calls, 4);
  assert.deepEqual(report.coveredIds, ["s:1", "s:2"]);
  assert.equal(run.analysisOutputs[2].stage, "跨批次关联分析");
  assert.equal(run.analysisOutputs[3].stage, "跨批次关联分析");
  assert.equal(run.analysisOutputs[3].kind, "format-repair");
});

test("format-only DSH sessions deny the run_code transport as well as all query tools", async () => {
  let listener, guard, restriction;
  const ctx = {
    on: (_, handler) => { listener = handler; return () => { listener = null; }; },
    agents: { get: () => ({ ctx: { tools: {
      restrict: (value) => { restriction = value; },
      guard: (value) => { guard = value; },
    } } }) },
    sessionController: {
      create: async () => ({ sessionId: "repair-session" }),
      cancel() {},
      prompt: async () => {
        listener({ id: "repair-session" }, { type: "assistant/message", data: { stream: [{ type: "text-chunks", texts: [output()] }] } });
        listener({ id: "repair-session" }, { type: "turn/end", data: { reason: { kind: "completed" } } });
      },
    },
  };
  const result = await createDshAnalyzer(ctx)("repair", { ...task, allowedTools: [], formatOnly: true },
    new AbortController().signal, () => {});
  assert.equal(result, output());
  assert.deepEqual(restriction, { allow: [] });
  for (const name of ["run_code", "read_metrics", "bash"])
    assert.equal(typeof guard({ name }), "string", `${name} must be denied`);
  assert.equal(listener, null);
});

test("failed repair persists both replies, sends only the fallback once, and omits raw replies from list state", async () => {
  const store = new Store(":memory:");
  const run = makeRun();
  run.task = { ...task, deliveryMode: "auto", targets: [{ botId: "b", targetId: "g" }], sendDataOnFailure: true };
  run.reuseRaw = true;
  run.status = "queued";
  store.saveSettings({ sources: [], tasks: [run.task] });
  store.putRun(run);
  let calls = 0;
  const sent = [];
  const engine = new Engine({
    store,
    analyze: async (_, __, ___, onSession) => { onSession(`session-${++calls}`); return malformed(); },
    getIm: () => ({ send: async (_, __, text) => { sent.push(text); return { sent: true }; } }),
  });
  try {
    await engine.execute(run);
    const saved = store.run(run.id);
    assert.equal(calls, 2);
    assert.equal(saved.status, "failed");
    assert.equal(saved.analysisOutputs.length, 2);
    assert.ok(saved.analysisOutputs.every((row) => row.text === malformed()));
    assert.equal(sent.length, 1);
    assert.match(sent[0], /AI 分析未完成/);
    assert.doesNotMatch(sent[0], /AI 分析完成/);
    assert.equal(store.deliveries()[0].status, "accepted");
    const handler = createHandler({ store, engine, credentials: {}, getIm: () => null });
    assert.equal((await handler("state")).runs[0].analysisOutputs, undefined);
    assert.deepEqual((await handler("run.get", { id: run.id })).run.analysisOutputs, saved.analysisOutputs);
    await engine.deliver(run.id);
    assert.equal(sent.length, 1);
    // Reanalysis makes a new version but retains the initial failure diagnostics.
    engine.analyze = async () => output();
    engine.retry(run.id);
    await engine.drainPromise;
    const retried = store.run(run.id);
    assert.equal(retried.status, "completed");
    assert.deepEqual(retried.analysisOutputs.map((row) => row.version), [1, 1, 2]);
  } finally {
    await engine.close();
    store.close();
  }
});
