import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { Store } from "./store.mjs";

function absoluteDirectory(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 2000 ||
    /[\x00-\x1f]/.test(value)
  )
    throw new Error("请输入有效的数据保存目录");
  if (!isAbsolute(value.trim()))
    throw new Error("数据保存目录必须是 DSH 服务器上的绝对路径");
  const directory = resolve(value.trim());
  if (directory === parse(directory).root)
    throw new Error("请填写磁盘内的专用目录，例如 /data/dsh-ops-assistant");
  return directory;
}

// The small pointer stays in DSH_HOME. All operational records live in the selected SQLite database.
export class StorageManager {
  constructor(
    config = {},
    { home = process.env.DSH_HOME ?? join(homedir(), ".dsh") } = {},
  ) {
    this.defaultDir = resolve(home, "integrations", "dsh-ops-assistant");
    this.settingsFile = join(this.defaultDir, "storage.json");
    let selected = config.dataDir ?? this.defaultDir;
    let saved = false;
    if (existsSync(this.settingsFile)) {
      const value = JSON.parse(readFileSync(this.settingsFile, "utf8"));
      if (value.version !== 1) throw new Error("不支持的数据存储配置版本");
      selected = absoluteDirectory(value.dataDir);
      saved = true;
    }
    this.dataDir = absoluteDirectory(selected);
    // A missing moved database must not silently become an empty database on an unmounted disk.
    if (saved && !existsSync(join(this.dataDir, "ops.sqlite")))
      throw new Error(
        `数据文件不可用，请检查磁盘挂载和权限：${join(this.dataDir, "ops.sqlite")}`,
      );
    this.store = new Store(join(this.dataDir, "ops.sqlite"));
    this.dataDir = realpathSync(this.dataDir);
    this.moving = false;
  }
  info() {
    return {
      dataDir: this.dataDir,
      databasePath: this.store.path,
      settingsFile: this.settingsFile,
      moving: this.moving,
    };
  }
  persist(dataDir) {
    mkdirSync(dirname(this.settingsFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.settingsFile}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporary,
        JSON.stringify({ version: 1, dataDir }, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      const fd = openSync(temporary, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.settingsFile);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  async move(value, engine) {
    if (this.moving) throw new Error("数据目录正在迁移，请稍后再试");
    const destination = absoluteDirectory(value);
    if (existsSync(destination) && realpathSync(destination) === this.dataDir)
      return this.info();
    if (
      engine.closed ||
      engine.busy ||
      engine.polling ||
      engine.tickBusy ||
      engine.queue.length ||
      engine.sending.size
    )
      throw new Error(
        "仍有巡检、采集或投递正在执行，请等待完成后再更改数据目录",
      );
    this.moving = true;
    engine.paused = true;
    try {
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      const actual = realpathSync(destination);
      await this.store.relocate(join(actual, "ops.sqlite"), () =>
        this.persist(actual),
      );
      this.dataDir = actual;
      return this.info();
    } finally {
      this.moving = false;
      engine.paused = false;
    }
  }
}
