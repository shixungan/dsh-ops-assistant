import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { collectLocalSource } from "../src/ingestion.mjs";
import { coverageWarnings } from "../src/coverage.mjs";
import { deliveryText } from "../src/analysis.mjs";

const source = { id: "n", name: "夜莺", type: "nightingale", revision: 0 };

test("one selected Nightingale source can be complete on its own", () => {
  assert.deepEqual(coverageWarnings([{ ...source, status: "ok" }]), []);
});

test("local coverage exposes the actual head and tail gaps for selected sources", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.putIngestionState(source.id, {
    sourceRevision: 0, coverageStart: 745000, coveredUntil: 7172000,
    successAt: 7172000, status: "ok",
  });
  const result = collectLocalSource(source, 0, 7200000, store);
  assert.equal(result.status, "partial");
  assert.equal(result.coverage.missingHeadSeconds, 745);
  assert.equal(result.coverage.missingTailSeconds, 28);
  const warnings = coverageWarnings([{ ...source, ...result }]);
  assert.deepEqual(warnings, ["夜莺：窗口前段未覆盖 745 秒，窗口末尾待采集 28 秒"]);
  const text = deliveryText({
    id: "r", status: "completed", start: 0, end: 7200000,
    alerts: [], sources: [{ ...source, ...result, count: 0 }],
    report: { summary: "可见数据无告警", coveredIds: [] },
  });
  assert.match(text, /本次数据不完整，结论仅针对已收到的告警/);
  assert.doesNotMatch(text, /夜莺|Zabbix|Prometheus|745 秒|28 秒/);
});

test("initial collection, failures, snapshots and legacy reports retain truthful warnings", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const initial = collectLocalSource(source, 0, 1800000, store);
  assert.deepEqual(coverageWarnings([{ ...source, ...initial }]), ["夜莺：尚未完成首次采集"]);
  store.putIngestionState(source.id, { sourceRevision: 0, status: "failed", successAt: null });
  const failed = collectLocalSource(source, 0, 1800000, store);
  assert.deepEqual(coverageWarnings([{ ...source, ...failed }]), ["夜莺：后台采集失败"]);
  const snapshotSource = { ...source, name: "Prometheus", type: "alertmanager" };
  const snapshot = collectLocalSource(snapshotSource, 0, 1800000, store);
  assert.deepEqual(coverageWarnings([{ ...snapshotSource, ...snapshot }]), ["Prometheus：快照来源，历史覆盖有限"]);
  assert.deepEqual(coverageWarnings([{ ...source, status: "partial" }]), ["夜莺：窗口覆盖不足，详见报告"]);
});
