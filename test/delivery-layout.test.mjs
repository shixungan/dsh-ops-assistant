import test from "node:test";
import assert from "node:assert/strict";
import { deliveryText } from "../src/delivery.mjs";

const stamp = (value) => Date.parse(value);
const headings = [
  "**一、结论**", "**二、事件**", "**三、事件分析**",
  "**四、事件关联分析**", "**五、下一步建议动作**",
];
const incident = (id = "a1", title = "测试链路丢包") => ({
  title, alertIds: [id],
  assessment: "探测到单点丢包，尚不能判断故障位置。",
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
  report: {
    summary: "发现一条丢包记录，尚不能确定根因。",
    correlation: "仅有一个事件，暂无跨事件关联依据。",
    incidents: [incident()], coveredIds: ["a1"],
  },
});
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function assertSections(message) {
  assert.ok(message.startsWith(headings[0] + "\n"), "the conclusion is first");
  let last = -1;
  for (const heading of headings) {
    const index = message.indexOf(heading);
    assert.ok(index > last, heading + " exists in order");
    assert.equal(message.split(heading).length - 1, 1, heading + " is not repeated");
    last = index;
  }
}
function section(message, index) {
  const start = message.indexOf(headings[index]) + headings[index].length;
  const end = index < headings.length - 1
    ? message.indexOf(headings[index + 1]) : message.indexOf("巡检 ID：");
  return message.slice(start, end).trim();
}

test("the card leads with a conclusion, follows five sections and ends with only the inspection ID", () => {
  const message = deliveryText(fixture());
  assertSections(message);
  assert.match(section(message, 0), /发现一条丢包记录，尚不能确定根因。/);
  assert.ok(message.trimEnd().endsWith("巡检 ID：example-run-123"));
  assert.doesNotMatch(message, /来源：|测试夜莺|原始等级|重点事件|完整报告与告警原文|DSH →|批次：|消息摘要已缩短|AI 分析完成/);
});

test("event metadata contains the task, Beijing window and record time without a duplicated asset row", () => {
  const message = deliveryText(fixture());
  const events = section(message, 1);
  assert.match(events, /半小时巡检/);
  assert.match(events, /2026-11-09 19:14:42 — 19:44:42（北京时间）/);
  assert.match(events, /测试链路丢包/);
  assert.match(events, /19:19:45/);
  assert.match(events, /1\s*条/);
  assert.doesNotMatch(section(message, 0), /半小时巡检|19:14:42/);
  assert.doesNotMatch(message, /资产：|10:00:00Z|11:19:45Z|partial|resource_id/);
});

test("cross-midnight windows and alert records include their Beijing dates", () => {
  const run = fixture();
  run.start = stamp("2026-11-09T15:45:00Z");
  run.end = stamp("2026-11-09T16:15:00Z");
  run.alerts[0].eventTime = stamp("2026-11-09T16:01:00Z");
  const events = section(deliveryText(run), 1);
  assert.match(events, /2026-11-09 23:45:00 — 2026-11-10 00:15:00（北京时间）/);
  assert.match(events, /2026-11-10 00:01:00/);
});

test("event analysis, uncertainty, correlation and suggestions remain separate", () => {
  const message = deliveryText(fixture());
  assert.match(section(message, 2), /探测到单点丢包，尚不能判断故障位置。/);
  assert.match(section(message, 2), /恢复状态未知/);
  assert.match(section(message, 2), /未验证实际转发路径/);
  assert.equal(section(message, 3), fixture().report.correlation);
  assert.match(section(message, 4), /查询丢包曲线/);
  assert.match(section(message, 4), /人工核查接口日志/);
  assert.doesNotMatch(section(message, 2), /查询丢包曲线/);
  assert.doesNotMatch(section(message, 4), /已执行|已完成核查/);
});

test("a multi-event correlation remains independent instead of being inferred from matching timestamps", () => {
  const run = fixture();
  run.alerts.push({ ...run.alerts[0], alertId: "a2", title: "第二条探测路径丢包" });
  run.report.incidents.push(incident("a2", "第二个事件"));
  run.report.correlation = "两条路径只在时间上接近，尚无共同故障设备或共同根因的证据。";
  const message = deliveryText(run);
  assert.equal(section(message, 3), run.report.correlation);
  assert.doesNotMatch(section(message, 3), /已确认|已证实/);
});

test("old reports without correlation remain usable without fabricated associations", () => {
  for (const count of [1, 2, 3]) {
    const run = fixture();
    delete run.report.correlation;
    if (count > 1) {
      run.alerts.push({ ...run.alerts[0], alertId: "a2" });
      if (count === 2) run.report.incidents.push(incident("a2", "第二个事件"));
      else run.report.incidents[0].alertIds.push("a2");
      run.report.incidents[0].assessment = "已验证两条告警由同一链路故障引起。";
    }
    const message = deliveryText(run);
    assertSections(message);
    assert.equal(section(message, 3), count === 1
      ? "仅 1 条告警，无跨事件关联依据。"
      : "旧报告未单列事件关联分析，请按巡检 ID 查阅原分析。");
    assert.doesNotMatch(section(message, 3), /已确认|已证实|同一根因导致/);
  }
});

test("incomplete data has one concise conclusion limitation without source details", () => {
  const run = fixture();
  run.sources = [{ name: "很长的来源名称".repeat(35), count: 1, status: "partial",
    coverage: { kind: "gap", missingHeadSeconds: 0, missingTailSeconds: 967 } }];
  const message = deliveryText(run);
  assert.match(section(message, 0), /本次数据不完整，结论仅针对已收到的告警。/);
  assert.doesNotMatch(message, /来源名称|967|数据覆盖提醒|来源：|partial/);
  assert.ok(message.length <= 3500);
});

test("failed analysis retains five sections and raw-alert counts without leaking a stale report", () => {
  const run = fixture();
  run.status = "failed";
  run.error = "JSON 格式未通过校验";
  run.report.summary = "旧的整体结论不能投递";
  run.report.correlation = "旧的事件关联不能投递";
  run.report.incidents[0].assessment = "旧的事件分析不能投递";
  run.report.incidents[0].actions = ["旧的动作不能投递"];
  run.alerts.push({ ...run.alerts[0], alertId: "a2" });
  const message = deliveryText(run);
  assertSections(message);
  assert.match(section(message, 0), /分析未完成/);
  assert.match(section(message, 1), /测试链路丢包/);
  assert.match(section(message, 1), /2\s*条/);
  assert.doesNotMatch(message, /旧的|AI 分析完成/);
  assert.match(section(message, 3), /暂无|未完成|未验证|无法/);
});

test("untrusted Markdown and mention tags are escaped without losing template sections", () => {
  const run = fixture();
  run.task.name = '**task** <at id="all">everyone</at>';
  run.report.incidents[0].title = "**priority**";
  run.report.summary = '`code` _italic_ <at id="all">everyone</at>';
  run.report.correlation = "[关联](https://invalid.example) <at id=all>";
  const message = deliveryText(run);
  assertSections(message);
  assert.ok(message.includes("\\*\\*task\\*\\*"));
  assert.ok(message.includes('\\<at id="all"\\>everyone\\</at\\>'));
  assert.ok(message.includes("\\`code\\` \\_italic\\_"));
  assert.ok(message.includes("\\*\\*priority\\*\\*"));
  assert.ok(message.includes("\\[关联\\](https://invalid.example)"));
  assert.doesNotMatch(message, /(?<!\\)<\/?at\b/);
});

test("redundant IPv4 links become readable addresses while unrelated links remain escaped", () => {
  const run = fixture();
  run.report.summary = "源 [192.0.2.10](http://192.0.2.10)，参考 [手册](https://docs.invalid/x)。";
  const message = deliveryText(run);
  assert.ok(message.includes("源 192.0.2.10"));
  assert.doesNotMatch(message, /http:\/\/192\.0\.2\.10/);
  assert.ok(message.includes("\\[手册\\](https://docs.invalid/x)"));
});

test("long cards retain every section and the inspection ID within the size limit", () => {
  const run = fixture();
  run.task.name = "*".repeat(200);
  run.sources = Array.from({ length: 8 }, (_, i) => ({
    id: "s" + i, name: "[source " + i + "]" + "*".repeat(200), status: "partial", count: 20,
    coverage: { kind: "gap", missingTailSeconds: 967 },
  }));
  run.report.summary = "长结论：根因未知。".repeat(500);
  run.report.correlation = "尚无共同根因的证据。".repeat(500);
  run.report.incidents = Array.from({ length: 8 }, (_, i) => ({
    ...incident("a" + (i + 1), "长标题".repeat(200)),
    assessment: "待验证判断".repeat(400), unknowns: ["未知情况".repeat(200)],
    actions: ["核对第 " + (i + 1) + " 个接口", "查询指标".repeat(100)],
  }));
  const message = deliveryText(run);
  assertSections(message);
  assert.ok(message.length <= 3500, message.length);
  assert.match(section(message, 0), /本次数据不完整/);
  assert.ok(message.trimEnd().endsWith("巡检 ID：example-run-123"));
  assert.match(section(message, 1), /另有 5 个事件未展开/);
  assert.doesNotMatch(message, /消息摘要已缩短|详见完整报告|来源：|source [0-7]|…/);
});

test("shortening cannot retain a causal claim while discarding its later qualification", () => {
  const run = fixture();
  const qualified = "根因为共享专线故障" + "，补查记录".repeat(100) + "，但这只是未验证假设，尚无足够证据。";
  run.report.summary = qualified;
  run.report.incidents[0].assessment = qualified;
  run.report.correlation = qualified;
  const message = deliveryText(run);
  assertSections(message);
  for (const index of [0, 2, 3]) {
    const body = section(message, index);
    if (body.includes("根因为共享专线故障")) {
      assert.match(body, /只是未验证假设，尚无足够证据/, "a retained claim must retain its qualification");
    }
    assert.doesNotMatch(body, /…/);
  }
});

test("extra events are counted and numbered suggestions are deduplicated without mutating the report", () => {
  const run = fixture();
  run.report.incidents = Array.from({ length: 4 }, (_, i) => incident("a" + (i + 1), "事件" + (i + 1)));
  run.report.incidents[0].actions.push("查询丢包曲线");
  run.report.incidents[2].actions.push("确认恢复情况", "额外第四条建议");
  const before = structuredClone(run);
  freeze(run);
  const message = deliveryText(run);
  assert.match(section(message, 1), /另有 1 个事件未展开/);
  assert.doesNotMatch(section(message, 1), /事件4/);
  const actions = section(message, 4);
  assert.equal(actions.split("查询丢包曲线").length - 1, 1);
  const rows = actions.split("\n").filter((line) => /^\d+[.、]/.test(line.trim()));
  assert.ok(rows.length > 0 && rows.length <= 3, "at most three numbered recommendations");
  assert.doesNotMatch(actions, /额外第四条建议/);
  assert.deepEqual(run, before);
});

test("missing hosts and timestamps do not create fabricated asset or record details", () => {
  const run = fixture();
  run.alerts[0] = { alertId: "a1", severity: 0 };
  const message = deliveryText(run);
  assertSections(message);
  assert.doesNotMatch(message, /原始等级|记录时间|资产：|undefined|Invalid Date|NaN/);
  assert.doesNotMatch(section(message, 1), /19:19:45|19:00:00/);
});
