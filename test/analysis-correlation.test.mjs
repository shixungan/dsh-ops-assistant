import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRun, parseAnalysis, reportMarkdown } from "../src/analysis.mjs";

const incident = (ids) => ({
  title: "站点甲到站点乙丢包",
  alertIds: ids,
  assessment: "探测记录出现完全丢包，路径故障与探测侧异常尚无法区分。",
  evidence: ['metric{site="test"} = 100'],
  unknowns: ["缺少连续指标，恢复状态未知"],
  actions: ["查看两端丢包曲线，确认持续时长和恢复情况"],
});
const report = (ids = ["test:1"], correlation) => ({
  summary: "站点甲到站点乙出现完全丢包，根因和恢复情况尚未确认。",
  ...(correlation === undefined ? {} : { correlation }),
  incidents: [incident(ids)],
});
const makeRun = (ids) => ({
  id: "inspection-test", version: 1, status: "completed",
  start: 0, end: 1800000, sources: [{ name: "测试来源", status: "ok", count: ids.length }],
  alerts: ids.map((id) => ({ alertId: id, raw: { detail: "x".repeat(900) } })),
});
const task = { name: "测试巡检", instructions: "优先核查业务链路。", maxBatchChars: 1800 };

test("old reports without correlation keep their schema and all original evidence", () => {
  const original = report();
  const parsed = parseAnalysis(JSON.stringify(original), ["test:1"]);
  assert.deepEqual(parsed, { ...original, coveredIds: ["test:1"] });
  assert.equal(Object.hasOwn(parsed, "correlation"), false);
});

test("correlation is retained as supplied without weakening alert coverage checks", () => {
  const original = report(["test:1", "test:2"], "两条告警来自不同路径，尚无共同根因证据。");
  const parsed = parseAnalysis(JSON.stringify(original), ["test:1", "test:2"]);
  assert.equal(parsed.correlation, original.correlation);
  assert.deepEqual(parsed.incidents, original.incidents);
  assert.throws(() => parseAnalysis(JSON.stringify(original), ["test:1"]), /不存在的告警/);
  assert.throws(() => parseAnalysis(JSON.stringify(original), ["test:1", "test:2", "test:3"]), /覆盖不完整/);
});

test("a present correlation must be text and invalid values do not trigger another AI call", async () => {
  for (const correlation of [null, false, 1, [], {}]) {
    const run = makeRun(["test:1"]);
    let calls = 0;
    await assert.rejects(analyzeRun(run, task, async () => {
      calls++;
      return JSON.stringify(report(["test:1"], correlation));
    }, new AbortController().signal, () => {}), /correlation 须为文本/);
    assert.equal(calls, 1);
    assert.equal(run.analysisOutputs.length, 1);
    assert.equal(run.analysisOutputs[0].kind, "analysis");
  }
});

test("cross-batch correlation reaches the global merge and its final conclusion is retained", async () => {
  const run = makeRun(["test:1", "test:2"]);
  const partials = [
    report(["test:1"], "本分批仅有一个事件，暂无跨事件关联依据。"),
    report(["test:2"], "本分批仅有一个事件，需要结合其他分批判断。"),
  ];
  const final = report(["test:1", "test:2"], "两端点相同且时间重合，可能为同一故障的重复观测，仍待链路证据确认。");
  let calls = 0;
  const contexts = new Set();
  const sessions = [];
  const progress = () => {};
  progress.session = (id) => sessions.push(id);
  const answer = await analyzeRun(run, task, async (prompt, options, _signal, onSession) => {
    contexts.add(options.analysisContext);
    onSession("inspection-session");
    calls++;
    if (calls <= partials.length) return JSON.stringify(partials[calls - 1]);
    const serialized = prompt.slice(prompt.lastIndexOf("\n") + 1);
    const mergedInputs = JSON.parse(serialized);
    assert.deepEqual(mergedInputs.map((value) => value.correlation), partials.map((value) => value.correlation));
    assert.deepEqual(mergedInputs.flatMap((value) => value.coveredIds), ["test:1", "test:2"]);
    assert.ok(prompt.includes(task.instructions));
    return JSON.stringify(final);
  }, new AbortController().signal, progress);
  assert.equal(calls, 3);
  assert.equal(contexts.size, 1);
  assert.deepEqual(sessions, ["inspection-session"]);
  assert.equal(answer.correlation, final.correlation);
  assert.deepEqual(answer.coveredIds, ["test:1", "test:2"]);
});

test("local JSON repair preserves the correlation without a formatting model turn", async () => {
  const run = makeRun(["test:1"]);
  const original = report(["test:1"], "仅一个事件，暂无跨事件关联依据。");
  let calls = 0;
  const answer = await analyzeRun(run, task, async () => {
    calls++;
    return JSON.stringify(original).slice(0, -1);
  }, new AbortController().signal, () => {});
  assert.equal(calls, 1);
  assert.equal(answer.correlation, original.correlation);
  assert.deepEqual(answer.incidents, original.incidents);
  assert.deepEqual(run.analysisOutputs.map((value) => value.kind), ["analysis", "local-format-repair"]);
});

test("local Markdown keeps the new relation analysis and original evidence, while old reports still export", () => {
  const run = { ...makeRun(["test:1"]), report: parseAnalysis(JSON.stringify(report(["test:1"], "暂无跨事件关联依据。")), ["test:1"]) };
  const markdown = reportMarkdown(run);
  assert.ok(markdown.includes("## 事件关联分析\n暂无跨事件关联依据。"));
  assert.ok(markdown.includes(run.report.incidents[0].evidence[0]));
  assert.ok(markdown.includes(run.report.incidents[0].unknowns[0]));
  run.report = parseAnalysis(JSON.stringify(report()), ["test:1"]);
  assert.doesNotMatch(reportMarkdown(run), /## 事件关联分析|undefined/);
});


test("report exports the selected plan snapshot without looking up a mutable library entry", () => {
  const run = { ...makeRun(["test:1"]), task: { queryPlanRef: { id: "shared", name: "Business ping", revision: 3 } } };
  assert.match(reportMarkdown(run), /查询方案：Business ping（修订 3）/);
  delete run.task.queryPlanRef;
  assert.doesNotMatch(reportMarkdown(run), /查询方案：|undefined/);
});
