import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { StorageManager } from "../src/storage.mjs";
import { Store } from "../src/store.mjs";
import { createHandler } from "../src/host.mjs";
import { Engine } from "../src/engine.mjs";
import { taskConfig } from "../src/config.mjs";
import { imStatus } from "../src/im.mjs";

function temporary(t) {
  const root = resolve(tmpdir());
  const dir = mkdtempSync(join(root, "dsh-ops-settings-"));
  t.after(() => {
    assert.ok(resolve(dir).startsWith(root + sep) && dir !== root);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
const idle = () => ({ queue: [], sending: new Set(), paused: false });
const source = {
  id: "s",
  enabled: true,
  name: "测试源",
  type: "nightingale",
  url: "https://n9e.invalid",
};
const task = () =>
  taskConfig({ name: "巡检", sourceIds: ["s"], workspace: "/work" }, [source]);

test("storage moves WAL records, preserves original, and resumes at the saved directory", async (t) => {
  const dir = temporary(t),
    home = join(dir, "home"),
    target = join(dir, "data-disk");
  const storage = new StorageManager({}, { home });
  const original = storage.store.path;
  storage.store.saveSettings({ sources: [source], tasks: [task()] });
  storage.store.putRun({
    id: "r",
    taskId: "t",
    start: 1,
    end: 2,
    alerts: [{ raw: "原始告警" }],
  });
  storage.store.putDelivery({ id: "d", status: "accepted" });
  storage.store.observe("s", "event", { raw: "采集快照" });
  const engine = idle();
  await storage.move(target, engine);
  assert.equal(engine.paused, false);
  assert.equal(storage.store.run("r").alerts[0].raw, "原始告警");
  assert.equal(storage.store.delivery("d").status, "accepted");
  assert.equal(storage.store.observations("s")[0].raw, "采集快照");
  assert.ok(existsSync(original));
  storage.store.putDelivery({ id: "after", status: "pending" });
  storage.store.close();
  const old = new Store(original);
  assert.equal(old.delivery("after"), null);
  old.close();
  const restarted = new StorageManager(
    { dataDir: join(dir, "ignored-config") },
    { home },
  );
  assert.equal(restarted.store.delivery("after").status, "pending");
  assert.equal(restarted.dataDir, target);
  restarted.store.close();
});

test("storage refuses active jobs, relative paths, existing databases and missing moved disks", async (t) => {
  const dir = temporary(t),
    home = join(dir, "home"),
    target = join(dir, "disk");
  const storage = new StorageManager({}, { home });
  await assert.rejects(storage.move("relative/path", idle()), /绝对路径/);
  await assert.rejects(
    storage.move(target, { ...idle(), busy: true }),
    /仍有巡检/,
  );
  assert.equal(existsSync(target), false);
  mkdirSync(target);
  writeFileSync(join(target, "ops.sqlite"), "existing file");
  await assert.rejects(storage.move(target, idle()), /不会覆盖/);
  assert.equal(
    readFileSync(join(target, "ops.sqlite"), "utf8"),
    "existing file",
  );
  const clean = join(dir, "clean-disk");
  await storage.move(clean, idle());
  storage.store.close();
  renameSync(clean, join(dir, "unmounted-disk"));
  assert.throws(() => new StorageManager({}, { home }), /数据文件不可用/);
  assert.equal(existsSync(clean), false);
});

test("storage pointer write failure keeps the original usable and removes only its own copy", async (t) => {
  const dir = temporary(t),
    storage = new StorageManager({}, { home: join(dir, "home") });
  const original = storage.store.path;
  storage.store.saveSettings({ sources: [source], tasks: [] });
  storage.persist = () => {
    throw new Error("simulated disk failure");
  };
  const engine = idle(),
    target = join(dir, "data");
  await assert.rejects(storage.move(target, engine), /simulated disk failure/);
  assert.equal(storage.store.path, original);
  assert.equal(storage.store.getSettings().sources.length, 1);
  assert.equal(engine.paused, false);
  assert.equal(existsSync(join(target, "ops.sqlite")), false);
  storage.store.close();
});

test("IM discovery distinguishes missing/incompatible service and strips private routes", async () => {
  const store = new Store(":memory:");
  let im;
  const handler = createHandler({
    store,
    engine: {},
    credentials: {},
    getIm: () => im,
  });
  assert.match((await handler("state")).im.message, /未发现/);
  await assert.rejects(handler("im.bots"), /未发现/);
  im = { send() {} };
  assert.equal(imStatus(im).available, true);
  assert.equal(imStatus(im).ready, false);
  im = {
    send() {},
    listBots: async () => [
      { botId: "bot", channel: "feishu", secret: "secret" },
    ],
    listTargets: async () => [
      {
        targetId: "ops",
        name: "运维群",
        kind: "group",
        route: { chatId: "private-route" },
      },
    ],
  };
  assert.deepEqual(await handler("im.bots"), [
    { botId: "bot", channel: "feishu" },
  ]);
  assert.deepEqual(await handler("im.targets", { botId: "bot" }), [
    { targetId: "ops", name: "运维群", kind: "group" },
  ]);
  store.close();
});

test("delivery settings validate saved targets, never send, and preserve task schedule and historical targets", async () => {
  const store = new Store(":memory:"),
    original = task();
  original.nextEnd = 123456;
  store.saveSettings({ sources: [source], tasks: [original] });
  store.putRun({
    id: "r",
    taskId: original.id,
    start: 1,
    end: 2,
    task: original,
    alerts: [],
  });
  let sends = 0;
  const im = {
    send: () => {
      sends++;
    },
    listBots: async () => [{ botId: "b", channel: "feishu" }],
    listTargets: async () => [{ targetId: "g", name: "运维群", kind: "group" }],
  };
  const handler = createHandler({
    store,
    engine: {},
    credentials: {},
    getIm: () => im,
  });
  const payload = {
    id: original.id,
    deliveryMode: "auto",
    targets: [{ botId: "b", targetId: "g" }],
    sendDataOnFailure: true,
  };
  const result = await handler("task.delivery.save", payload);
  assert.equal(result.targets[0].targetName, "运维群");
  assert.equal(result.targets[0].channel, "feishu");
  assert.equal(result.nextEnd, 123456);
  assert.equal(result.workspace, original.workspace);
  assert.equal(store.run("r").task.deliveryMode, "off");
  assert.equal(sends, 0);
  await assert.rejects(
    handler("task.delivery.save", {
      ...payload,
      targets: [{ botId: "b", targetId: "deleted" }],
    }),
    /已不存在/,
  );
  assert.equal(store.getSettings().tasks[0].targets[0].targetId, "g");
  store.close();
});

test("management writes and scheduler cannot run across a storage migration", async () => {
  const store = new Store(":memory:");
  const engine = new Engine({ store, credentials: {}, getIm: () => undefined });
  let finish;
  const storage = {
    info: () => ({}),
    move: async () => {
      engine.paused = true;
      await new Promise((r) => {
        finish = r;
      });
      engine.paused = false;
    },
  };
  const handler = createHandler({
    store,
    engine,
    storage,
    credentials: {},
    getIm: () => undefined,
  });
  const migration = handler("storage.save", { dataDir: "/data/test" });
  await assert.rejects(handler("task.run", { id: "t" }), /正在迁移/);
  await assert.rejects(
    handler("storage.save", { dataDir: "/data/other" }),
    /管理操作/,
  );
  await engine.tick();
  assert.equal(engine.tickBusy, false);
  await handler("state");
  finish();
  await migration;
  store.close();
});
