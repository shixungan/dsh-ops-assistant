import { DatabaseSync, backup } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  existsSync,
  copyFileSync,
  constants,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

// One local SQLite database; continuous ingestion and report snapshots share it.
// Raw events remain immutable per report batch. Never store credentials here.
export class Store {
  constructor(path) {
    this.path = path;
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, window_start INTEGER NOT NULL, window_end INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(task_id,window_start,window_end));
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS deliveries_run_status ON deliveries(json_extract(data, '$.runId'), json_extract(data, '$.status'));
      CREATE TABLE IF NOT EXISTS observations (source_id TEXT NOT NULL, event_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source_id,event_key));
      CREATE TABLE IF NOT EXISTS alert_events (source_id TEXT NOT NULL, event_id TEXT NOT NULL, event_time INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source_id,event_id));
      CREATE INDEX IF NOT EXISTS alert_events_source_time ON alert_events(source_id,event_time);
      CREATE TABLE IF NOT EXISTS source_ingestion (source_id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    if (path !== ":memory:") chmodSync(path, 0o600);
  }
  getSettings() {
    return JSON.parse(
      this.db.prepare("SELECT data FROM settings WHERE id=?").get("config")
        ?.data ?? '{"sources":[],"tasks":[]}',
    );
  }
  saveSettings(data) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES (?,?)")
      .run("config", JSON.stringify(data));
  }
  putRun(run) {
    this.db
      .prepare(
        "INSERT INTO runs VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id, window_start=excluded.window_start, window_end=excluded.window_end, data=excluded.data",
      )
      .run(run.id, run.taskId, run.start, run.end, JSON.stringify(run));
  }
  run(id) {
    const row = this.db.prepare("SELECT data FROM runs WHERE id=?").get(id);
    return row ? JSON.parse(row.data) : null;
  }
  window(taskId, start, end) {
    const row = this.db
      .prepare(
        "SELECT data FROM runs WHERE task_id=? AND window_start=? AND window_end=?",
      )
      .get(taskId, start, end);
    return row ? JSON.parse(row.data) : null;
  }
  runs(limit = 100) {
    return this.db
      .prepare("SELECT data FROM runs ORDER BY window_end DESC LIMIT ?")
      .all(limit)
      .map((r) => JSON.parse(r.data));
  }
  hasSendingDelivery(runId) {
    return !!this.db.prepare(
      "SELECT 1 FROM deliveries WHERE json_extract(data, '$.runId')=? AND json_extract(data, '$.status')='sending' LIMIT 1",
    ).get(runId);
  }
  deleteRuns(ids) {
    // Report snapshots and every delivery version belong to the run. The
    // independent alert history and collector cursors are intentionally kept.
    const deleteDeliveries = this.db.prepare(
      "DELETE FROM deliveries WHERE json_extract(data, '$.runId')=?",
    );
    const deleteRun = this.db.prepare("DELETE FROM runs WHERE id=?");
    const deletedIds = [...new Set(ids)];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of deletedIds) {
        deleteDeliveries.run(id);
        if (deleteRun.run(id).changes !== 1)
          throw new Error("部分巡检记录已不存在，请刷新列表后重试");
      }
      this.db.exec("COMMIT");
      return { deletedIds, deletedCount: deletedIds.length };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  putDelivery(row) {
    this.db
      .prepare("INSERT OR REPLACE INTO deliveries VALUES (?,?)")
      .run(row.id, JSON.stringify(row));
  }
  delivery(id) {
    const row = this.db
      .prepare("SELECT data FROM deliveries WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.data) : null;
  }
  deliveries() {
    return this.db
      .prepare("SELECT data FROM deliveries ORDER BY rowid DESC LIMIT 200")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  observe(sourceId, key, row) {
    this.db
      .prepare("INSERT OR REPLACE INTO observations VALUES (?,?,?)")
      .run(sourceId, key, JSON.stringify(row));
  }
  observations(sourceId) {
    return this.db
      .prepare("SELECT data FROM observations WHERE source_id=?")
      .all(sourceId)
      .map((r) => JSON.parse(r.data));
  }
  ingestionState(sourceId) {
    const row = this.db
      .prepare("SELECT data FROM source_ingestion WHERE source_id=?")
      .get(sourceId);
    return row ? JSON.parse(row.data) : null;
  }
  putIngestionState(sourceId, state) {
    if (
      typeof sourceId !== "string" || !sourceId ||
      !state || typeof state !== "object" || Array.isArray(state)
    )
      throw new Error("无效的告警采集状态");
    this.db
      .prepare(
        "INSERT INTO source_ingestion VALUES (?,?) ON CONFLICT(source_id) DO UPDATE SET data=excluded.data",
      )
      .run(sourceId, JSON.stringify(state));
  }
  commitIngestion(sourceId, alerts, state) {
    if (!Array.isArray(alerts)) throw new Error("告警记录必须为数组");
    const write = this.db.prepare(
      "INSERT INTO alert_events VALUES (?,?,?,?) ON CONFLICT(source_id,event_id) DO UPDATE SET event_time=excluded.event_time, data=excluded.data",
    );
    // The cursor must not advance unless every event in this ingestion batch
    // is durable. A failed batch also rolls back updates to existing events.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const alert of alerts) {
        if (
          !alert || alert.sourceId !== sourceId ||
          typeof alert.alertId !== "string" || !alert.alertId ||
          !Number.isSafeInteger(alert.eventTime) || alert.eventTime < 0
        )
          throw new Error("无效的告警记录：来源、ID 或事件时间缺失");
        write.run(sourceId, alert.alertId, alert.eventTime, JSON.stringify(alert));
      }
      this.putIngestionState(sourceId, state);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  alerts(sourceId, start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
      throw new Error("无效的本地告警查询时间窗");
    return this.db
      .prepare(
        "SELECT data FROM alert_events WHERE source_id=? AND event_time>=? AND event_time<? ORDER BY event_time ASC, event_id ASC",
      )
      .all(sourceId, start, end)
      .map((row) => JSON.parse(row.data));
  }
  ingestionInfo(sourceId) {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count, MIN(event_time) AS earliestEventTime, MAX(event_time) AS latestEventTime FROM alert_events WHERE source_id=?",
      )
      .get(sourceId);
    return { ...row };
  }
  close() {
    this.db.close();
  }
  async relocate(path, persist) {
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(path + suffix))
        throw new Error(
          "目标目录已有 ops.sqlite 或关联文件，请选择新的专用目录；不会覆盖已有数据",
        );
    const temporary = `${path}.${randomUUID()}.tmp`;
    let next,
      created = false,
      committed = false;
    try {
      await backup(this.db, temporary);
      // COPYFILE_EXCL protects existing data even if the destination appears during the backup.
      copyFileSync(temporary, path, constants.COPYFILE_EXCL);
      created = true;
      chmodSync(path, 0o600);
      next = new Store(path);
      if (next.db.prepare("PRAGMA quick_check").get().quick_check !== "ok")
        throw new Error("迁移后的数据库校验失败，继续使用原目录");
      next.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const fd = openSync(path, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      persist();
      const previous = this.db;
      this.db = next.db;
      this.path = path;
      committed = true;
      previous.close();
    } finally {
      if (!committed) {
        next?.close();
        if (created)
          for (const suffix of ["", "-wal", "-shm"])
            if (existsSync(path + suffix)) unlinkSync(path + suffix);
      }
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
