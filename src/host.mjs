import { homedir } from "node:os";
import { resolve } from "node:path";
import { Store } from "./store.mjs";
import { Engine } from "./engine.mjs";
import { createDshAnalyzer } from "./dsh.mjs";
import { sourceConfig, taskConfig, credentialRef } from "./config.mjs";
import { collectSource, pollAlertmanager } from "./collectors.mjs";

export const name = "dsh-ops-assistant";
export const inject = [
  "connection",
  "credentials",
  "sessionController",
  "agents",
  "tools",
];

export async function apply(ctx, config = {}) {
  const store = new Store(
    resolve(
      config.dataDir ??
        resolve(
          process.env.DSH_HOME ?? resolve(homedir(), ".dsh"),
          "integrations",
          "dsh-ops-assistant",
        ),
      "ops.sqlite",
    ),
  );
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
}) {
  return async (method, payload = {}, signal) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("无效请求");
    const config = store.getSettings();
    switch (method) {
      case "state":
        return {
          config,
          runs: store
            .runs()
            .map(({ alerts, report, ...run }) => ({
              ...run,
              alertCount: alerts.length,
              summary: report?.summary,
              coveredCount: report?.coveredIds.length ?? 0,
            })),
          deliveries: store.deliveries().map(({ text, ...row }) => row),
          pollStatus: engine.pollStatus ?? {},
          fatalError: engine.fatalError ?? null,
          imAvailable: !!getIm()?.send,
        };
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
        const task = taskConfig(payload, config.sources, existing);
        if (
          !existing ||
          (!existing.enabled && task.enabled) ||
          existing.intervalMinutes !== task.intervalMinutes
        )
          task.nextEnd = null;
        config.tasks = [...config.tasks.filter((t) => t.id !== task.id), task];
        store.saveSettings(config);
        return task;
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
        return getIm()?.listBots ? await getIm().listBots() : [];
      case "im.targets":
        return getIm()?.listTargets
          ? await getIm().listTargets(payload.botId)
          : [];
      case "tools.list":
        return getTools();
      default:
        throw new Error("未知管理操作");
    }
  };
}
