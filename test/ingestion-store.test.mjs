import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Store } from "../src/store.mjs";
import { StorageManager } from "../src/storage.mjs";

function temporary(t) {
  const root = resolve(tmpdir());
  const directory = mkdtempSync(join(root, "dsh-ops-ingestion-"));
  t.after(() => {
    const target = resolve(directory);
    assert.ok(target.startsWith(root + sep) && target !== root);
    rmSync(target, { recursive: true, force: true });
  });
  return directory;
}

const event = (id, eventTime, sourceId = "n9e", overrides = {}) => ({
  alertId: `${sourceId}:${id}`,
  nativeId: String(id),
  sourceId,
  sourceType: "nightingale",
  eventTime,
  first: 1000,
  last: null,
  raw: { id, last_eval_time: eventTime / 1000, tags: ["instance=sw1"] },
  ...overrides,
});
const state = (coveredUntil) => ({
  coverageStart: 1000,
  coveredUntil,
  attemptAt: coveredUntil,
  successAt: coveredUntil,
  status: "ok",
  sourceRevision: 0,
});

test("a queued report's actual execution window updates both JSON and its unique window index", () => {
  const store = new Store(":memory:");
  try {
    const queued = { id: "r1", taskId: "t1", start: 1000, end: 2000, status: "queued" };
    const executing = { ...queued, start: 1500, end: 2500, status: "collecting" };
    store.putRun(queued);
    store.putRun(executing);
    assert.equal(store.window("t1", 1000, 2000), null);
    assert.deepEqual(store.window("t1", 1500, 2500), executing);
    assert.deepEqual(store.run("r1"), executing);
  } finally {
    store.close();
  }
});

test("local events are isolated by source and use indexed half-open event-time windows", () => {
  const store = new Store(":memory:");
  try {
    const rows = [event(1, 1999), event(2, 2000), event(3, 2999), event(4, 3000)];
    store.commitIngestion("n9e", rows, state(4000));
    store.commitIngestion("other", [event(2, 2500, "other")], state(4000));
    assert.deepEqual(store.alerts("n9e", 2000, 3000), [rows[1], rows[2]]);
    assert.deepEqual(store.alerts("n9e", 3000, 3000), []);
    assert.deepEqual(store.alerts("missing", 0, 4000), []);
    assert.deepEqual(store.ingestionInfo("n9e"), {
      count: 4,
      earliestEventTime: 1999,
      latestEventTime: 3000,
    });
    assert.equal(store.ingestionInfo("missing").count, 0);
    assert.equal(store.ingestionState("missing"), null);
    const plan = store.db.prepare(
      "EXPLAIN QUERY PLAN SELECT data FROM alert_events WHERE source_id=? AND event_time>=? AND event_time<?",
    ).all("n9e", 2000, 3000);
    assert.ok(plan.some((row) => row.detail.includes("alert_events_source_time")));
  } finally {
    store.close();
  }
});

test("overlap reads upsert by normalized alert ID while source revisions preserve old originals", () => {
  const store = new Store(":memory:");
  try {
    const original = event(1, 2000);
    store.commitIngestion("n9e", [original, original], state(3000));
    const updated = event(1, 2500, "n9e", {
      raw: { id: 1, last_eval_time: 2.5, annotations: { detail: "updated" } },
    });
    const revised = event(1, 3500, "n9e", { alertId: "n9e:1:1" });
    store.commitIngestion("n9e", [updated, revised], state(4000));
    assert.deepEqual(store.alerts("n9e", 0, 5000), [updated, revised]);
    assert.equal(store.ingestionInfo("n9e").count, 2);
    assert.deepEqual(store.ingestionState("n9e"), state(4000));
    store.commitIngestion("n9e", [], state(5000));
    assert.equal(store.ingestionState("n9e").coveredUntil, 5000);
    assert.equal(store.ingestionInfo("n9e").count, 2);
  } finally {
    store.close();
  }
});

test("failed ingestion rolls back new events, existing updates and the source watermark together", () => {
  const store = new Store(":memory:");
  try {
    const original = event(1, 2000);
    store.commitIngestion("n9e", [original], state(3000));
    assert.throws(() => store.commitIngestion("n9e", [
      event(1, 2500), event(2, 3500), event(3, NaN),
    ], state(4000)), /无效的告警记录/);
    assert.deepEqual(store.alerts("n9e", 0, 5000), [original]);
    assert.deepEqual(store.ingestionState("n9e"), state(3000));
    assert.throws(() => store.commitIngestion("n9e", [event(2, 3500)], {
      ...state(4000), unsupported: 1n,
    }), /BigInt/);
    assert.deepEqual(store.alerts("n9e", 0, 5000), [original]);
    assert.deepEqual(store.ingestionState("n9e"), state(3000));
    // A bad batch must leave the connection ready for the next scheduled poll.
    store.commitIngestion("n9e", [event(2, 3500)], state(4000));
    assert.equal(store.ingestionInfo("n9e").count, 2);
    assert.equal(store.ingestionState("n9e").coveredUntil, 4000);
  } finally {
    store.close();
  }
});

test("ingestion tables upgrade an existing database without losing settings and survive reopen", (t) => {
  const path = join(temporary(t), "ops.sqlite");
  const legacy = new DatabaseSync(path);
  const settings = { sources: [{ id: "n9e" }], tasks: [] };
  legacy.exec("CREATE TABLE settings (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  legacy.prepare("INSERT INTO settings VALUES (?,?)").run("config", JSON.stringify(settings));
  legacy.close();
  const first = new Store(path);
  const row = event(1, 2000);
  try {
    assert.deepEqual(first.getSettings(), settings);
    first.commitIngestion("n9e", [row], state(3000));
    first.putIngestionState("n9e", {
      ...state(3000), attemptAt: 4000, status: "failed", note: "暂时不可用",
    });
  } finally {
    first.close();
  }
  const reopened = new Store(path);
  try {
    assert.deepEqual(reopened.getSettings(), settings);
    assert.deepEqual(reopened.alerts("n9e", 1000, 3000), [row]);
    assert.equal(reopened.ingestionState("n9e").coveredUntil, 3000);
    assert.equal(reopened.ingestionState("n9e").status, "failed");
    assert.equal(reopened.ingestionInfo("n9e").count, 1);
  } finally {
    reopened.close();
  }
});

test("custom data-directory migration preserves continuous events and polling state across restart", async (t) => {
  const directory = temporary(t);
  const home = join(directory, "dsh-home");
  const destination = join(directory, "custom-alert-data");
  const storage = new StorageManager({}, { home });
  const originalPath = storage.store.path;
  const row = event(1, 2000);
  const afterMove = event(2, 3500);
  try {
    storage.store.commitIngestion("n9e", [row], state(3000));
    await storage.move(destination, { queue: [], sending: new Set(), paused: false });
    assert.equal(storage.store.path, join(destination, "ops.sqlite"));
    assert.deepEqual(storage.store.alerts("n9e", 1000, 3000), [row]);
    assert.deepEqual(storage.store.ingestionState("n9e"), state(3000));
    storage.store.commitIngestion("n9e", [afterMove], state(4000));
  } finally {
    storage.store.close();
  }
  const restarted = new StorageManager({}, { home });
  try {
    assert.equal(restarted.dataDir, destination);
    assert.deepEqual(restarted.store.alerts("n9e", 1000, 4000), [row, afterMove]);
    assert.deepEqual(restarted.store.ingestionState("n9e"), state(4000));
  } finally {
    restarted.store.close();
  }
  const old = new Store(originalPath);
  try {
    assert.deepEqual(old.alerts("n9e", 1000, 4000), [row]);
    assert.deepEqual(old.ingestionState("n9e"), state(3000));
  } finally {
    old.close();
  }
});
