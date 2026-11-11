import test from "node:test";
import assert from "node:assert/strict";
import { assertFormatOnly, repairAnalysisJson } from "../src/analysis-format.mjs";

const report = {
  summary: "观察到丢包，关联尚未验证。",
  incidents: [{
    title: "测试丢包", alertIds: ["test:1"], assessment: "无法确认根因。",
    evidence: ['ping_percent_packet_loss{project="test"} > 5'],
    unknowns: ["缺少时序数据"], actions: ["查询对应时间窗口的指标"],
  }],
};
const serialized = JSON.stringify(report);
const missingBracket = serialized.replace(/\]\}\]\}$/, "}]}");
const accepted = (source, expected = report) => {
  const result = repairAnalysisJson(source);
  assert.equal(typeof result, "string");
  assert.deepEqual(JSON.parse(result), expected);
  assert.doesNotThrow(() => assertFormatOnly(source, result));
  return result;
};

test("local repair closes a missing actions array without a model call or content change", () => {
  assert.throws(() => JSON.parse(missingBracket), SyntaxError);
  assert.equal(accepted(missingBracket), serialized);
});

test("local repair handles matching ancestor terminators and completed trailing values", () => {
  accepted(serialized.slice(0, -3));
  accepted(serialized.replace(/\}\]\}$/, "]}"));
  accepted('{"inside":{"values":[["first"},"kept":true}', { inside: { values: [["first"]] }, kept: true });
  accepted('[{"key":"value"]', [{ key: "value" }]);
});

test("local repair escapes only complete PromQL selectors inside JSON value strings", () => {
  const unescaped = missingBracket.replaceAll('\\"test\\"', '"test"');
  accepted(unescaped);
  const value = 'sum(rate(metric{project="test", job=~"node.+", site!="west", rack!~"old.*"}[5m]))';
  const raw = JSON.stringify({ value, after: ["unchanged", "second item"] });
  accepted(raw.replaceAll('\\"', '"'), { value, after: ["unchanged", "second item"] });
  const mixed = raw.replace('\\"test\\"', '"test"');
  accepted(mixed, { value, after: ["unchanged", "second item"] });
});

test("valid replies retain escaping, field order and whitespace", () => {
  const source = '{\n  "text": "\\u0061 \\n C:\\\\tmp\\\\file \\\"quoted\\\"", "arr": [1, true, null]\n}';
  assert.equal(repairAnalysisJson(source), source);
  assert.equal(repairAnalysisJson(`\n\`\`\`json\n${source}\n\`\`\`\n`), source);
  accepted(`\`\`\`json\n${missingBracket}\n\`\`\``);
});

test("local repair never completes an unfinished string, scalar, field or empty container", () => {
  for (const source of [
    '{"summary":"cut off', '{"summary":"escaped\\', '{"value":tru',
    '{"value":nul', '{"value":1e', '{"value":-', '{"value":',
    '{"value"', '{', '[', '{"actions":[', '{"object":{',
    '{"actions":["done",', '{"actions":["done",]}',
    '{"actions":["done"],}', '{"value":"done",}',
    '{"value":"bad\\q"}', '{"value":"bad\\u123"}',
    '{"value":"line\nbreak"}',
  ]) assert.equal(repairAnalysisJson(source), null, source);
});

test("local repair rejects missing separators and arbitrary unescaped quotes rather than merging values", () => {
  for (const source of [
    '["first" "second"]', '["first",,"second"]',
    '{"first":"one" "second":"two"}', '{"first" "one"}',
    '{"evidence":["unescaped "quote" in ordinary prose"]}',
    '{"evidence":["metric{label="bad\\value"}"]}',
    '{"evidence":["metric{label="unfinished}"]}',
    '{"evidence":["metric{label="test"", "second"]}',
  ]) assert.equal(repairAnalysisJson(source), null, source);
});

test("local repair rejects unmatched closing tokens and extra prose", () => {
  for (const source of [
    '{"value":"text"]', '["value"}', `${missingBracket} trailing text`,
    `${missingBracket}}`, `analysis: ${missingBracket}`, '```JSON\n{"a":1}\n```',
  ]) assert.equal(repairAnalysisJson(source), null, source);
});

test("local repair does not reinterpret brackets or commas inside evidence", () => {
  const document = {
    evidence: ['literal [{a:b}], (in,out)', 'one, two: three', 'existing "quote"', 'metric{label=', 'second'],
    actions: ["check only"],
  };
  const raw = JSON.stringify(document).replace(/\]\}$/, "}");
  accepted(raw, document);
});

test("local repair is bounded and rejects non-text inputs", () => {
  for (const value of [null, undefined, {}, [], 1, " ", "x".repeat(1000001)])
    assert.equal(repairAnalysisJson(value), null);
  assert.equal(repairAnalysisJson('['.repeat(102) + '"text"'), null);
});
