import test from "node:test";
import assert from "node:assert/strict";
import { deliveryFeishuText } from "../src/delivery.mjs";

const labels = ["一、结论", "二、事件", "三、事件分析", "四、事件关联分析", "五、下一步建议动作"];
const heading = (label) => `<text_tag color='blue'>${label}</text_tag>`;
const incident = (id = "a1", title = "月湖至浦江丢包") => ({
  title, alertIds: [id], assessment: "探测到丢包，缺少接口指标，尚不能定位故障点。",
  evidence: ["本窗口告警记录"], unknowns: ["恢复状态未确认", "缺少端点接入拓扑"],
  actions: ["核对两端资产与接入端口。", "检查链路错误和丢弃计数。", "查看告警前后丢包趋势。"],
});
const fixture = () => ({
  id: "inspection-example-123", task: { name: "ping巡检" }, status: "completed",
  start: Date.parse("2026-11-11T21:00:37Z"), end: Date.parse("2026-11-11T21:30:37Z"),
  alerts: [{ alertId: "a1", title: "月湖至浦江丢包", host: "probe_a",
    eventTime: Date.parse("2026-11-11T21:05:28Z"), first: Date.parse("2026-11-11T20:00:00Z") }],
  sources: [{ id: "source-private", name: "来源明细不展示", status: "ok", count: 1 }],
  report: { summary: "跨机房探测出现丢包，根因与恢复状态尚未确认。",
    correlation: "仅一条告警，无跨事件关联依据。", incidents: [incident()], coveredIds: ["a1"] },
});
function section(message, index) {
  const start = message.indexOf(heading(labels[index])) + heading(labels[index]).length;
  const next = index < labels.length - 1 ? message.indexOf(heading(labels[index + 1])) : message.indexOf("巡检 ID：");
  return message.slice(start, next);
}
const decodeEntities = (message) => message.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
function visible(message) {
  return decodeEntities(message.replace(/<[^>]*>/g, ""));
}
function assertStructure(message) {
  assert.ok(message.startsWith(heading(labels[0])), "conclusion precedes task metadata");
  let previous = -1;
  for (const label of labels) {
    const tag = heading(label), index = message.indexOf(tag);
    assert.ok(index > previous, `${label} appears in order`);
    assert.equal(message.split(tag).length - 1, 1, `${label} occurs once`);
    previous = index;
  }
  assert.equal(message.split("巡检 ID：").length - 1, 1);
  assert.ok(visible(message).trimEnd().endsWith("巡检 ID：inspection-example-123"));
  assert.doesNotMatch(message, /来源明细不展示|source-private|来源：|原始等级|完整报告与告警原文|DSH →|批次：/);
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("Feishu card presents five labeled sections with separators and only an inspection ID footer", () => {
  const run = fixture(), message = deliveryFeishuText(run);
  assertStructure(message);
  assert.ok((message.match(/\n<hr>\n/g) ?? []).length >= 4, "sections have separate horizontal rules");
  assert.match(section(message, 0), /跨机房探测出现丢包，根因与恢复状态尚未确认。/);
  assert.match(section(message, 1), /ping巡检/);
  assert.doesNotMatch(section(message, 0), /ping巡检|05:00:37/);
  assert.match(decodeEntities(message), /<font color=['"]grey['"]>[^<]*巡检 ID：inspection-example-123<\/font>/);
});

test("card metadata is visually secondary and uses event time in Beijing rather than first trigger", () => {
  const message = deliveryFeishuText(fixture()), events = section(message, 1);
  assert.match(decodeEntities(events), /<font color=['"]grey['"]>[^<]*2026-11-12 05:00:37 — 05:30:37（北京时间）[^<]*<\/font>/);
  assert.match(visible(events), /1 条告警.*1 个事件/);
  assert.match(visible(events), /记录时间 05:05:28/);
  assert.doesNotMatch(events, /04:00:00|21:05:28Z|undefined|Invalid Date/);
});

test("single-event analysis has no redundant index and actions use three stable separate paragraphs", () => {
  const message = deliveryFeishuText(fixture());
  assert.doesNotMatch(visible(section(message, 2)).replace(/\*\*/g, ""), /^\s*(?:1[.、)]|①)/);
  const actions = visible(section(message, 4));
  for (const [index, mark] of ["①", "②", "③"].entries()) {
    assert.equal(actions.split(mark).length - 1, 1);
    assert.match(actions, new RegExp(`${mark}[^\n]+${index < 2 ? "\\n\\n" : ""}`));
  }
  assert.doesNotMatch(actions, /^\s*\d+[.)、]\s/m);
});

test("dynamic tags, Markdown and pre-escaped entities remain text without producing mentions or links", () => {
  const run = fixture();
  run.report.summary = '<at id="all">全员</at>';
  run.task.name = "&#60;at id=all&#62;";
  run.report.incidents[0].title = "**标题** <font color=red>红字</font>";
  run.report.incidents[0].assessment = "[伪链接](https://invalid.example) `code` _name_";
  run.report.correlation = "<link url='https://invalid.example'>关联</link>";
  run.report.incidents[0].actions = ["<at id=all>动作</at>"];
  const message = deliveryFeishuText(run);
  assertStructure(message);
  assert.doesNotMatch(message, /<(?:\/?at|\/?link|\/?a|\/?person)\b/i);
  assert.ok(message.includes("&#60;at"));
  const events = visible(section(message, 1));
  assert.ok(events.includes(run.task.name), "an existing entity remains literal after one decode");
  assert.doesNotMatch(events, /<at\b/, "nested entities cannot introduce a mention after one decode");
  assert.ok(message.includes("&#42;"), "dynamic emphasis is not template styling");
  assert.ok(message.includes("&#91;"), "dynamic Markdown links remain literal");
  assert.doesNotMatch(message, /<font color=red>/);
});

test("readable addresses and device identifiers survive entity encoding", () => {
  const run = fixture();
  run.report.summary = "探针 [192.0.2.10](http://192.0.2.10) 至 198.51.100.8 出现丢包。";
  run.report.incidents[0].assessment = "设备 SW-A_B 的端口计数未取得，丢包 >5% 的原因未确认。";
  const message = deliveryFeishuText(run), shown = visible(message);
  assert.match(shown, /探针 192\.0\.2\.10 至 198\.51\.100\.8/);
  assert.match(shown, /SW-A_B/);
  assert.match(shown, /丢包 >5%/);
  assert.doesNotMatch(message, /http:\/\/192\.0\.2\.10/);
});

test("long unknown lists show whole items with an omission count instead of a generic disclaimer", () => {
  const run = fixture();
  const unknowns = [
    "尚未取得接口错误和丢弃计数，不能区分物理链路异常与临时拥塞，也不能确认问题是否来自探测端点。",
    "尚未取得两端接入拓扑和逐跳流量数据，不能确定探测实际经过的端口，也不能据此判断业务流量路径。",
    "尚未取得历史丢包趋势与恢复记录，无法判断异常持续时长，以及恢复后的链路质量是否已经符合预期。",
  ];
  run.report.incidents[0].unknowns = unknowns;
  const analysis = visible(section(deliveryFeishuText(run), 2));
  assert.ok(analysis.includes(unknowns[0]));
  assert.ok(analysis.includes(unknowns[1]));
  assert.ok(!analysis.includes(unknowns[2]));
  assert.match(analysis, /另有 1 项/);
  assert.doesNotMatch(analysis, /仍有未验证事项，尚不能形成完整判断/);
});

test("shortening does not promote a qualified causal claim to a confirmed cause", () => {
  const run = fixture();
  const qualified = "根因为共享专线故障" + "，待补查记录".repeat(90) + "，但这只是未验证假设，尚无足够证据。";
  run.report.summary = qualified;
  run.report.correlation = qualified;
  run.report.incidents[0].assessment = qualified;
  run.report.incidents[0].actions = ["立即重启设备" + "并核对业务影响".repeat(90) + "，但仅在人工批准且确认具备回退方案后执行。"];
  const message = deliveryFeishuText(run);
  assertStructure(message);
  for (const index of [0, 2, 3]) {
    const body = visible(section(message, index));
    if (body.includes("根因为共享专线故障")) assert.match(body, /只是未验证假设，尚无足够证据/);
  }
  const actions = visible(section(message, 4));
  if (actions.includes("立即重启设备")) assert.match(actions, /仅在人工批准且确认具备回退方案后执行/);
});

test("failed analysis cannot expose an earlier successful report as current findings", () => {
  const run = fixture();
  run.status = "failed";
  run.report.summary = "过时结论";
  run.report.correlation = "过时关联";
  run.report.incidents[0].assessment = "过时分析";
  run.report.incidents[0].actions = ["过时建议"];
  const message = deliveryFeishuText(run);
  assertStructure(message);
  assert.match(visible(section(message, 0)), /分析未完成/);
  assert.match(visible(section(message, 1)), /月湖至浦江丢包/);
  assert.doesNotMatch(message, /过时/);
});

test("legacy multi-alert reports do not turn an absent correlation field into a negative conclusion", () => {
  const run = fixture();
  delete run.report.correlation;
  run.alerts.push({ ...run.alerts[0], alertId: "a2" });
  run.report.incidents[0].alertIds.push("a2");
  run.report.incidents[0].assessment = "已验证两条记录为同一事件的重复观测。";
  const message = deliveryFeishuText(run);
  assert.match(visible(section(message, 2)), /已验证两条记录为同一事件的重复观测/);
  assert.match(visible(section(message, 3)), /旧报告未单列事件关联分析/);
  assert.doesNotMatch(visible(section(message, 3)), /无法确认共同根因|无跨事件关联依据/);
});

test("incomplete data preserves a short scope limitation without disclosing source details", () => {
  const run = fixture();
  run.sources[0].status = "partial";
  run.sources[0].coverage = { missingTailSeconds: 967, kind: "gap" };
  const message = deliveryFeishuText(run);
  assertStructure(message);
  assert.match(visible(section(message, 0)), /本次数据不完整，结论仅针对已收到的告警/);
  assert.doesNotMatch(message, /967|partial|来源明细不展示/);
});

test("large cards retain their five sections and ID without mutating data or duplicating recommendations", () => {
  const run = fixture();
  run.report.incidents = Array.from({ length: 5 }, (_, i) => ({
    ...incident(`a${i + 1}`, `事件${i + 1}`), assessment: "尚未定位丢包故障点。".repeat(100),
    actions: ["核对两端资产。", `检查第 ${i + 1} 条路径。`],
  }));
  run.report.summary = "根因未验证。".repeat(100);
  run.report.correlation = "共同故障尚未验证。".repeat(100);
  const before = structuredClone(run);
  freeze(run);
  for (const budget of [3500, 1200]) {
    const message = deliveryFeishuText(run, budget);
    assertStructure(message);
    assert.ok(message.length <= budget, `${message.length} exceeds ${budget}`);
    assert.ok((visible(section(message, 4)).match(/核对两端资产。/g) ?? []).length <= 1);
  }
  assert.throws(() => deliveryFeishuText(run, 20), RangeError);
  assert.deepEqual(run, before);
});

test("card dates survive a midnight boundary and absent timestamps stay absent", () => {
  const run = fixture();
  run.start = Date.parse("2026-11-11T15:45:00Z");
  run.end = Date.parse("2026-11-11T16:15:00Z");
  run.alerts[0].eventTime = Date.parse("2026-11-11T16:01:00Z");
  const events = visible(section(deliveryFeishuText(run), 1));
  assert.match(events, /2026-11-11 23:45:00 — 2026-11-12 00:15:00（北京时间）/);
  assert.match(events, /记录时间 2026-11-12 00:01:00/);
  delete run.alerts[0].eventTime;
  delete run.alerts[0].first;
  assert.doesNotMatch(visible(section(deliveryFeishuText(run), 1)), /记录时间|undefined|Invalid Date|NaN/);
});
