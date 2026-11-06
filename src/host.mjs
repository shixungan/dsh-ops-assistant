import { StorageManager } from "./storage.mjs";
import { Engine } from "./engine.mjs";
import { createDshAnalyzer } from "./dsh.mjs";
import {
  sourceConfig,
  taskConfig,
  deliveryConfig,
  credentialRef,
} from "./config.mjs";
import { collectSource, pollAlertmanager } from "./collectors.mjs";
import { imStatus, listBots, listTargets, validateTargets } from "./im.mjs";

export const name = "dsh-ops-assistant";
export const inject = [
  "connection",
  "credentials",
  "sessionController",
  "agents",
  "tools",
];

export async function apply(ctx, config = {}) {
  const storage = new StorageManager(config);
  const store = storage.store;
  const getIm = () =>
    typeof ctx.get === "function" ? ctx.get("dshIm") : undefined;
  const engine = new Engine({
    store,
    credentials: ctx.credentials,
    analyze: createDshAnalyzer(ctx),
    getIm,
  });
  engine.initialize();
  ctx.provide("opsManager", engine);
  const handler = createHandler({
    store,
    engine,
    credentials: ctx.credentials,
    getIm,
    storage,
    getTools: () =>
      ctx.tools
        .schemas()
        .map((t) => ({ name: t.name, description: t.description })),
  });
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: "/api/dsh-ops-assistant",
        methods: ["POST"],
        requestBody: "buffered",
        async fetch(request) {
          if (request.method !== "POST")
            return new Response("method not allowed", { status: 405 });
          if (
            request.headers
              .get("content-type")
              ?.split(";")[0]
              .trim()
              .toLowerCase() !== "application/json"
          )
            return new Response("JSON required", { status: 415 });
          const raw = await request.text();
          if (raw.length > 256000)
            return new Response("request too large", { status: 413 });
          let message;
          try {
            message = JSON.parse(raw);
          } catch {
            return new Response("invalid JSON", { status: 400 });
          }
          if (
            message?.type !== "client-request" ||
            message.method !== "dsh-ops-assistant" ||
            typeof message.rpcId !== "string" ||
            typeof message.payload?.method !== "string"
          )
            return new Response("invalid request", { status: 400 });
          let result;
          try {
            result = {
              ok: true,
              value: await handler(
                message.payload.method,
                message.payload.payload,
                request.signal,
              ),
            };
          } catch (error) {
            result = {
              ok: false,
              error: {
                code: "ops/request-failed",
                message: error.message,
                details: {},
              },
            };
          }
          return Response.json({
            type: "server-response",
            rpcId: message.rpcId,
            result,
          });
        },
      }),
    "ops: authenticated DSH management carrier",
  );
  ctx.effect(() => {
    const tick = () => {
      engine.tickPromise = engine.tick();
      engine.tickPromise.catch((error) => {
        engine.fatalError = error.message;
      });
    };
    const timer = setInterval(tick, 10000);
    timer.unref?.();
    tick();
    return async () => {
      clearInterval(timer);
      await storage.movePromise?.catch(() => {});
      await engine.close();
      await engine.tickPromise?.catch(() => {});
      await engine.pollPromise?.catch(() => {});
      store.close();
    };
  }, "ops: persistent scheduler");
}

export function createHandler({
  store,
  engine,
  credentials,
  getIm,
  getTools = () => [],
  storage,
}) {
  const handle = async (method, payload = {}, signal) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("无效请求");
    const config = store.getSettings();
    switch (method) {
      case "state":
        return {
          config,
          runs: store.runs().map(({ alerts, report, ...run }) => ({
            ...run,
            alertCount: alerts.length,
            summary: report?.summary,
            coveredCount: report?.coveredIds.length ?? 0,
          })),
          deliveries: store.deliveries().map(({ text, ...row }) => row),
          pollStatus: engine.pollStatus ?? {},
          fatalError: engine.fatalError ?? null,
          imAvailable: imStatus(getIm()).ready,
          im: imStatus(getIm()),
          storage: storage?.info() ?? null,
        };
      case "storage.save": {
        if (!storage) throw new Error("当前实例不支持修改数据目录");
        storage.movePromise = storage.move(payload.dataDir, engine);
        return await storage.movePromise;
      }
      case "source.save": {
        const existing = payload.id
          ? config.sources.find((s) => s.id === payload.id)
          : undefined;
        if (payload.id && !existing) throw new Error("来源不存在");
        const source = sourceConfig(payload, existing);
        if (typeof payload.token === "string" && payload.token.trim())
          await credentials.set(credentialRef(source.id), payload.token.trim());
        else if (existing && source.url !== existing.url)
          await credentials.unset(credentialRef(source.id));
        signal?.throwIfAborted();
        const latest = store.getSettings();
        latest.sources = [
          ...latest.sources.filter((s) => s.id !== source.id),
          source,
        ];
        store.saveSettings(latest);
        return source;
      }
      case "source.test": {
        const source = config.sources.find((s) => s.id === payload.id);
        if (!source) throw new Error("来源不存在");
        const options = {
          signal,
          token: (await credentials.resolve(credentialRef(source.id)))?.value,
        };
        const end = Date.now();
        if (source.type === "alertmanager")
          return {
            count: await pollAlertmanager(source, store, options),
            note: "当前快照可访问，不代表历史完整",
          };
        const result = await collectSource(
          source,
          end - 1800000,
          end,
          store,
          options,
        );
        return {
          count: result.alerts.length,
          status: result.status,
          note: result.note,
        };
      }
      case "task.save": {
        const existing = payload.id
          ? config.tasks.find((t) => t.id === payload.id)
          : undefined;
        if (payload.id && !existing) throw new Error("任务不存在");
        const delivery = deliveryConfig(payload);
        await validateTargets(getIm(), delivery);
        const latest = store.getSettings();
        const current = latest.tasks.find((t) => t.id === payload.id);
        const task = taskConfig(
          { ...payload, ...delivery },
          latest.sources,
          current,
        );
        if (
          !existing ||
          (!current.enabled && task.enabled) ||
          current.intervalMinutes !== task.intervalMinutes
        )
          task.nextEnd = null;
        latest.tasks = [...latest.tasks.filter((t) => t.id !== task.id), task];
        store.saveSettings(latest);
        return task;
      }
      case "task.delivery.save": {
        if (!config.tasks.some((t) => t.id === payload.id))
          throw new Error("任务不存在");
        const delivery = deliveryConfig(payload);
        await validateTargets(getIm(), delivery);
        const latest = store.getSettings();
        const current = latest.tasks.find((t) => t.id === payload.id);
        if (!current) throw new Error("任务不存在");
        Object.assign(current, delivery);
        store.saveSettings(latest);
        return current;
      }
      case "task.run":
        return engine.manual(payload.id);
      case "run.get": {
        const { run, markdown } = engine.report(payload.id);
        const { alerts, ...detail } = run;
        return { run: { ...detail, alertCount: alerts.length }, markdown };
      }
      case "run.alerts": {
        const run = store.run(payload.id);
        if (!run) throw new Error("报告不存在");
        const page =
          Number.isInteger(payload.page) && payload.page >= 0
            ? payload.page
            : 0;
        return {
          total: run.alerts.length,
          page,
          items: run.alerts.slice(page * 50, (page + 1) * 50),
        };
      }
      case "run.cancel":
        engine.cancel(payload.id);
        return { accepted: true };
      case "run.retry":
        return engine.retry(payload.id);
      case "run.deliver":
        await engine.deliver(payload.id);
        return { accepted: true };
      case "delivery.retry":
        await engine.retryDelivery(payload.id, payload.confirmUnknown === true);
        return { accepted: true };
      case "im.bots":
        return listBots(getIm());
      case "im.targets":
        return listTargets(getIm(), payload.botId);
      case "tools.list":
        return getTools();
      default:
        throw new Error("未知管理操作");
    }
  };
  let requests = 0;
  let moving = false;
  const reads = new Set([
    "state",
    "run.get",
    "run.alerts",
    "tools.list",
    "im.bots",
    "im.targets",
  ]);
  return async (method, payload, signal) => {
    if (method === "storage.save") {
      if (moving || requests)
        throw new Error("仍有管理操作正在执行，请稍后再更改数据目录");
      moving = true;
      try {
        return await handle(method, payload, signal);
      } finally {
        moving = false;
      }
    }
    if (moving && !reads.has(method))
      throw new Error("数据目录正在迁移，请稍后再试");
    requests++;
    try {
      return await handle(method, payload, signal);
    } finally {
      requests--;
    }
  };
}
