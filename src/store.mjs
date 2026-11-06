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

// One local SQLite database; raw events are immutable per batch. Never store credentials here.
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
      CREATE TABLE IF NOT EXISTS observations (source_id TEXT NOT NULL, event_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source_id,event_key));`);
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
        "INSERT INTO runs VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
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
