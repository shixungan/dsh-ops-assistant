import test from "node:test";
import assert from "node:assert/strict";
import { assertFormatOnly } from "../src/analysis-format.mjs";

const report = {
  summary: "仅一条告警，根因未确认。",
  incidents: [{
    title: "IDC 丢包",
    alertIds: ["source:7845"],
    assessment: "丢包率 100%，无法判断是否恢复。",
    evidence: ['ping_percent_packet_loss{project="idc-idc"} > 5'],
    unknowns: ["缺少时序指标"],
    actions: ['查询 ping_percent_packet_loss{project="idc-idc"}，核对 (in,out)'],
  }],
};
const serialized = JSON.stringify(report);
const unescaped = serialized.replaceAll('\\"idc-idc\\"', '"idc-idc"');
const malformed = unescaped.replace(/\]\}\]\}$/, "}]}");
const changed = (update) => {
  const candidate = structuredClone(report);
  update(candidate);
  return JSON.stringify(candidate);
};
const rejects = (source, candidate) => {
  // All rejections below exercise valid candidate JSON, not its parser.
  JSON.parse(candidate);
  assert.throws(() => assertFormatOnly(source, candidate), /格式修正改变了原回复内容/);
};

test("format repair accepts unescaped PromQL quotes and a missing actions bracket", () => {
  assert.throws(() => JSON.parse(malformed), SyntaxError);
  assert.doesNotThrow(() => assertFormatOnly(malformed, serialized));
  assert.doesNotThrow(() => assertFormatOnly(malformed, JSON.stringify(report, null, 2)));
});

test("format repair permits only outside-string whitespace changes and known fences", () => {
  const pretty = JSON.stringify(report, null, "\t");
  assert.doesNotThrow(() => assertFormatOnly(`\n${pretty}\n`, serialized));
  assert.doesNotThrow(() => assertFormatOnly(serialized, pretty));
  assert.doesNotThrow(() => assertFormatOnly(`\`\`\`json\n${malformed}\n\`\`\``, pretty));
  assert.doesNotThrow(() => assertFormatOnly(malformed, `\`\`\`\n${pretty}\n\`\`\``));
});

test("format repair inserts missing structural punctuation without changing text", () => {
  for (const source of [
    serialized.replace('"summary":', '"summary"'),
    serialized.replace(',"incidents"', '"incidents"'),
    serialized.slice(0, -2),
  ]) {
    assert.doesNotThrow(() => assertFormatOnly(source, serialized));
  }
});

test("format repair rejects changed facts, IDs, conclusions, and reordered fields", () => {
  for (const candidate of [
    changed((r) => { r.summary = "仅一条告警，根因已确认。"; }),
    changed((r) => { r.incidents[0].alertIds = ["source:7846"]; }),
    changed((r) => { r.incidents[0].assessment = "丢包率 0%，已恢复。"; }),
    changed((r) => { r.incidents[0].unknowns = []; }),
    JSON.stringify({ incidents: report.incidents, summary: report.summary }),
  ]) rejects(malformed, candidate);
});

test("format repair rejects changes to PromQL, punctuation, or whitespace inside strings", () => {
  for (const replacement of [
    'ping_percent_packet_loss{project="idc-idc"} < 5',
    'ping_percent_packet_loss{project="other"} > 5',
    'ping_percent_packet_loss(project="idc-idc") > 5',
    'ping_percent_packet_loss{project="idc-idc",} > 5',
    'ping_percent_packet_loss{project="idc-idc"}>5',
    'ping_percent_packet_loss{ project="idc-idc"} > 5',
  ]) rejects(malformed, changed((r) => { r.incidents[0].evidence = [replacement]; }));
  rejects(malformed, changed((r) => { r.incidents[0].actions[0] += ","; }));
  rejects(malformed, changed((r) => { r.incidents[0].actions[0] = r.incidents[0].actions[0].replace("(in,out)", "(in out)"); }));
});

test("format repair rejects invented content, missing string delimiters, and leftover original text", () => {
  rejects(malformed, changed((r) => { r.incidents[0].actions.push("重启设备"); }));
  rejects(serialized.slice(0, serialized.indexOf("核对")), serialized);
  rejects(serialized.replace('"summary"', "summary"), serialized);
  rejects(`${malformed} 后续原文`, serialized);
  rejects(serialized.replace(',"incidents"', ',,"incidents"'), serialized);
});

test("format repair preserves existing escapes and does not rewrite string encodings", () => {
  const original = JSON.stringify({ text: '路径 C:\\tmp\\file；已转义 "value"；换行\n下一行' });
  assert.doesNotThrow(() => assertFormatOnly(original, JSON.stringify(JSON.parse(original), null, 2)));
  rejects(original, JSON.stringify({ text: '路径 C:\\tmp\\file；已转义 "new"；换行\n下一行' }));
  rejects('{"text":"value"}', '{"text":"\\u0076alue"}');
  rejects('{"text":"\\u0076alue"}', '{"text":"value"}');
});
