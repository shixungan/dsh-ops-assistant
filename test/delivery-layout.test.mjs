import test from "node:test";
import assert from "node:assert/strict";
import { deliveryText } from "../src/delivery.mjs";

const stamp = (value) => Date.parse(value);

test("long source names cannot hide the actual missing window in the card", () => {
  const run = fixture();
  run.sources = [{ name: "很长的来源名称".repeat(35), count: 1, status: "partial",
    coverage: { kind: "gap", missingHeadSeconds: 0, missingTailSeconds: 967 } }];
  const message = deliveryText(run);
  assert.match(message, /窗口末尾待采集 967 秒/);
  assert.ok(message.length <= 3500);
  assert.match(message, /example-run-123/);
});
const incident = (id = "a1", title = "测试链路丢包") => ({
  title, alertIds: [id],
  assessment: "观察到丢包；时间接近不证明同一根因。",
  evidence: ["历史告警记录中的单点值"],
  unknowns: ["恢复状态未知", "未验证实际转发路径"],
  actions: ["查询丢包曲线", "人工核查接口日志"],
});
const fixture = () => ({
  id: "example-run-123", task: { name: "半小时巡检" },
  start: stamp("2026-11-09T11:14:42Z"), end: stamp("2026-11-09T11:44:42Z"),
  status: "completed", sources: [{ id: "n", name: "测试夜莺", status: "ok", count: 1 }],
  alerts: [{ alertId: "a1", host: "probe_test", title: "测试链路丢包", severity: "1",
    eventTime: stamp("2026-11-09T11:19:45Z"), first: stamp("2026-11-09T10:00:00Z") }],
  report: { summary: "发现一条丢包记录，尚不能确定根因。", incidents: [incident()], coveredIds: ["a1"] },
});
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("the card shows a readable Beijing window, source counts, asset, raw severity and event time", () => {
  const message = deliveryText(fixture());
  assert.match(message, /2026-11-09 19:14:42 — 19:44:42（北京时间）/);
  assert.match(message, /告警 \*\*1\*\* 条 · 事件 \*\*1\*\* 个/);
  assert.match(message, /来源：测试夜莺 1 条/);
  assert.ok(message.includes("资产：probe\\_test"));
  assert.match(message, /记录时间 19:19:45 · 原始等级 1 · 1 条告警/);
  assert.doesNotMatch(message, /10:00:00Z|11:19:45Z|partial|resource_id/);
});

test("cross-midnight windows and records include their Beijing dates", () => {
  const run = fixture();
  run.start = stamp("2026-11-09T15:45:00Z");
  run.end = stamp("2026-11-09T16:15:00Z");
  run.alerts[0].eventTime = stamp("2026-11-09T16:01:00Z");
  const message = deliveryText(run);
  assert.match(message, /2026-11-09 23:45:00 — 2026-11-10 00:15:00（北京时间）/);
  assert.match(message, /记录时间 2026-11-10 00:01:00/);
});

test("conclusions, assessments, uncertainty and unexecuted suggestions remain separate", () => {
  const message = deliveryText(fixture());
  assert.match(message, /\*\*分析结论\*\*\n发现一条丢包记录，尚不能确定根因。/);
  assert.match(message, /判断：观察到丢包；时间接近不证明同一根因。/);
  assert.match(message, /待核实：恢复状态未知；未验证实际转发路径/);
  assert.match(message, /\*\*建议动作（未执行）\*\*\n- 查询丢包曲线\n- 人工核查接口日志/);
  assert.ok(message.indexOf("批次：") > message.indexOf("建议动作"));
});

test("a failed analysis uses only a labelled data summary and never a stale report conclusion", () => {
  const run = fixture();
  run.status = "failed";
  run.error = "JSON 格式未通过校验";
  run.report.summary = "这段旧结论不能投递";
  run.alerts.push({ ...run.alerts[0], alertId: "a2" });
  const message = deliveryText(run);
  assert.match(message, /AI 分析未完成，仅发送数据汇总/);
  assert.match(message, /原因：JSON 格式未通过校验/);
  assert.ok(message.includes("probe\\_test · 测试链路丢包：2 条"));
  assert.doesNotMatch(message, /这段旧结论不能投递|AI 分析完成|建议动作/);
});

test("untrusted Markdown and angle brackets are escaped while template formatting remains", () => {
  const run = fixture();
  run.task.name = '**task** <at id="all">everyone</at>';
  run.alerts[0].host = "[probe](https://invalid.example)";
  run.report.incidents[0].title = "**priority**";
  run.report.summary = '`code` _italic_ <at id="all">everyone</at>';
  const message = deliveryText(run);
  assert.ok(message.startsWith("**🔔 运维巡检**\n"));
  assert.ok(message.includes("\\*\\*task\\*\\*"));
  assert.ok(message.includes('\\<at id="all"\\>everyone\\</at\\>'));
  assert.ok(message.includes("\\[probe\\](https://invalid.example)"));
  assert.ok(message.includes("\\`code\\` \\_italic\\_"));
  assert.ok(message.includes("**1. \\*\\*priority\\*\\***"));
  assert.doesNotMatch(message, /(?<!\\)<\/?at\b/);
});

test("redundant IPv4 Markdown links become plain addresses without changing unrelated destinations", () => {
  const run = fixture();
  run.report.summary = "源 [192.0.2.10](http://192.0.2.10)，目标 [198.51.100.8](https://198.51.100.8/)，另见 [192.0.2.11](https://docs.invalid/example)。";
  const message = deliveryText(run);
  assert.ok(message.includes("源 192.0.2.10，目标 198.51.100.8"));
  assert.doesNotMatch(message, /https?:\/\/192\.0\.2\.10|https?:\/\/198\.51\.100\.8/);
  assert.ok(message.includes("\\[192.0.2.11\\](https://docs.invalid/example)"));
});

test("long cards stay within 3500 characters while retaining coverage warnings, batch footer and truncation notice", () => {
  const run = fixture();
  run.task.name = "*".repeat(200);
  run.sources = Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}`, name: `[source ${i}]` + "*".repeat(200), status: "partial", count: 20,
    coverage: { kind: "gap", missingTailSeconds: 967 },
  }));
  run.report.summary = "长结论：根因未知。".repeat(500);
  run.report.incidents = Array.from({ length: 8 }, (_, i) => ({
    ...incident(`a${i + 1}`, "长标题".repeat(200)),
    assessment: "待验证判断".repeat(400), unknowns: ["未知情况".repeat(200)],
    actions: [`核对第 ${i + 1} 个接口`, "查询指标".repeat(100)],
  }));
  const message = deliveryText(run);
  assert.ok(message.length <= 3500, message.length);
  assert.match(message, /数据覆盖提醒/);
  assert.match(message, /另有 5 个来源覆盖不足/);
  assert.match(message, /所选来源的时间窗尚未完整覆盖，不能据此判定无异常/);
  assert.match(message, /消息摘要已缩短，详见完整报告/);
  assert.ok(message.endsWith("批次：example-run-123"));
  assert.match(message, /DSH → 运维管理 → 分析报告/);
});

test("additional events and duplicate suggestions are summarized explicitly without mutating the report", () => {
  const run = fixture();
  run.report.incidents = Array.from({ length: 4 }, (_, i) => incident(`a${i + 1}`, `事件${i + 1}`));
  run.report.incidents[0].actions.push("查询丢包曲线");
  const before = structuredClone(run);
  freeze(run);
  const message = deliveryText(run);
  assert.match(message, /另有 1 个事件，详见完整报告/);
  assert.equal([...message.matchAll(/- 查询丢包曲线/g)].length, 1);
  assert.match(message, /消息摘要已缩短/);
  assert.deepEqual(run, before);
});

test("a zero original severity and a missing host or timestamp do not become fabricated data", () => {
  const run = fixture();
  run.alerts[0] = { alertId: "a1", severity: 0 };
  const message = deliveryText(run);
  assert.match(message, /原始等级 0/);
  assert.doesNotMatch(message, /记录时间|资产：|undefined|Invalid Date|NaN/);
});
