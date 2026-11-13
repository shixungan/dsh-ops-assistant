import { StorageManager } from "./storage.mjs";
import { Engine } from "./engine.mjs";
import { createDshAnalyzer } from "./dsh.mjs";
import {
  sourceConfig,
  taskConfig,
  deliveryConfig,
  credentialRef,
} from "./config.mjs";
import { localSourceInfo } from "./ingestion.mjs";
import { imStatus, listBots, listTargets, validateTargets } from "./im.mjs";
import { QUERY_ROLES, compatibleQueryTool } from "./query-plan.mjs";
import { queryPlanEntry } from "./plan-library.mjs";
import { dictionaryEntry, discoverDictionary, describeDictionaryTool, importDictionary, validateDictionaryReferences, checkedValidation } from "./mcp-dictionary.mjs";
import { dictionaryEntryIds } from "./dictionary-defs.mjs";

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
  const analyze = createDshAnalyzer(ctx);
  const engine = new Engine({
    store,
    credentials: ctx.credentials,
    analyze,
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
    validateDictionary: (entry, options, signal) => analyze.validateDictionary(entry, options, signal),
    getTools: () =>
      ctx.tools
        .schemas()
        .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters ?? t.inputSchema, outputSchema: t.outputSchema ?? t.output?.schema, annotations: t.annotations })),
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
      await Promise.allSettled([...(engine.dictionaryValidationPromises ?? [])]);
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
  validateDictionary,
  storage,
}) {
  const validating = new Set();
  const handle = async (method, payload = {}, signal) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("无效请求");
    const config = store.getSettings();
    switch (method) {
      case "state":
        return {
          config,
          runs: store.runs().map(({ alerts, report, analysisOutputs, queryEvidence, ...run }) => ({
            ...run,
            task: run.task ? Object.fromEntries(Object.entries(run.task).filter(([key]) => key !== "queryDictionary")) : run.task,
            alertCount: alerts.length,
            summary: report?.summary,
            coveredCount: report?.coveredIds.length ?? 0,
            deleteBlockedReason: engine.runDeletionReason?.(run) ?? null,
          })),
          deliveries: store.deliveries().map(({ text, ...row }) => row),
          pollStatus: engine.sourceStatus?.() ?? {},
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
        else if (existing && (source.url !== existing.url || source.type !== existing.type))
          await credentials.unset(credentialRef(source.id));
        signal?.throwIfAborted();
        const latest = store.getSettings();
        latest.sources = [
          ...latest.sources.filter((s) => s.id !== source.id),
          source,
        ];
        store.saveSettings(latest);
        engine.notifyCoverageWaiters?.();
        if (source.enabled && engine.refreshSource) {
          engine.ensureIngestion(source);
          engine.refreshSource(source.id).catch((error) => {
            engine.fatalError = error.message;
          });
        }
        return source;
      }
      case "source.test": {
        const source = config.sources.find((s) => s.id === payload.id);
        if (!source) throw new Error("来源不存在");
        if (!source.enabled) throw new Error("请先启用告警源");
        await engine.refreshSource(source.id);
        const result = localSourceInfo(source, store);
        return {
          count: result.count,
          status: result.status,
          note: result.note,
        };
      }
      case "queryPlan.save": {
        const existing = payload.id ? config.queryPlans.find((plan) => plan.id === payload.id) : undefined;
        if (payload.id && !existing) throw new Error("查询方案不存在");
        const plan = queryPlanEntry(payload, existing);
        validateDictionaryReferences(plan.config, config.mcpDictionary, existing?.config);
        signal?.throwIfAborted();
        config.queryPlans = [...config.queryPlans.filter((item) => item.id !== plan.id), plan];
        store.saveSettings(config);
        return plan;
      }
      case "dictionary.discover":
        return discoverDictionary(getTools());
      case "dictionary.describe":
        if (typeof payload.tool !== "string" || payload.tool.length > 300) throw new Error("请输入有效 MCP 工具标识");
        return describeDictionaryTool(getTools().find((tool) => tool.name === payload.tool.trim()));
      case "dictionary.import":
        return importDictionary(payload.text);
      case "dictionary.save": {
        const existing = payload.id ? config.mcpDictionary.find((entry) => entry.id === payload.id) : undefined;
        if (payload.id && !existing) throw new Error("数据字典不存在");
        if (!existing && config.mcpDictionary.length >= 100) throw new Error("数据字典最多保存 100 项");
        const toolName = typeof payload.tool === "string" ? payload.tool.trim() : existing?.tool;
        const entry = dictionaryEntry(payload, existing, { toolDefinition: getTools().find((tool) => tool.name === toolName) });
        if (existing && existing.purpose !== entry.purpose && payload.purpose && payload.purpose !== existing.purpose && config.queryPlans.some((plan) => dictionaryEntryIds(plan.config).includes(entry.id)))
          throw new Error("已引用的旧模板不能改变用途，请复制新条目后重新选择");
        signal?.throwIfAborted();
        config.mcpDictionary = [...config.mcpDictionary.filter((item) => item.id !== entry.id), entry];
        store.saveSettings(config);
        return entry;
      }
      case "dictionary.delete": {
        const entry = config.mcpDictionary.find((item) => item.id === payload.id);
        if (!entry) throw new Error("数据字典不存在");
        if (payload.revision !== entry.revision) throw new Error("数据字典已被修改，请刷新后重试");
        if (config.queryPlans.some((plan) => dictionaryEntryIds(plan.config).includes(entry.id)))
          throw new Error("数据字典仍被查询方案引用，请先更改方案引用");
        signal?.throwIfAborted();
        config.mcpDictionary = config.mcpDictionary.filter((item) => item.id !== entry.id);
        store.saveSettings(config);
        return { deleted: true, id: entry.id };
      }
      case "dictionary.validate": {
        if (!validateDictionary) throw new Error("当前实例不支持 MCP 查询验证");
        const entry = config.mcpDictionary.find((item) => item.id === payload.id);
        if (!entry) throw new Error("数据字典不存在");
        if (payload.revision !== entry.revision) throw new Error("数据字典已被修改，请刷新后重试");
        if (!entry.tool || entry.purpose === "reference") throw new Error("请填写实际 MCP 工具并读取参数后验证");
        if (validating.has(entry.id)) throw new Error("此字典正在验证，请等待完成");
        if (typeof payload.workspace !== "string" || !/^(?:\/|[A-Za-z]:[\\/])/.test(payload.workspace) || payload.workspace.length > 2000 || /[\x00-\x1f]/.test(payload.workspace)) throw new Error("验证工作目录须为服务器上的绝对路径");
        if (payload.agentPreset !== undefined && (typeof payload.agentPreset !== "string" || payload.agentPreset.length > 300 || /[\x00-\x1f]/.test(payload.agentPreset))) throw new Error("分析预设无效");
        if (!payload.sample || typeof payload.sample !== "object" || Array.isArray(payload.sample) || JSON.stringify(payload.sample).length > 16000) throw new Error("验证样例格式无效或过大");
        const signals = [signal, engine.lifecycle?.signal].filter(Boolean);
        const combined = signals.length ? AbortSignal.any(signals) : new AbortController().signal;
        combined.throwIfAborted();
        validating.add(entry.id);
        engine.dictionaryValidationPromises ??= new Set();
        const pending = Promise.resolve().then(() => validateDictionary(structuredClone(entry), { workspace: payload.workspace, agentPreset: payload.agentPreset ?? "", sample: structuredClone(payload.sample) }, combined));
        engine.dictionaryValidationPromises.add(pending);
        try {
          let result;
          try { result = await pending; }
          catch (error) {
            combined.throwIfAborted();
            result = { status: "failed", message: String(error.message ?? error).slice(0, 400) };
          }
          combined.throwIfAborted();
          const latest = store.getSettings();
          const current = latest.mcpDictionary.find((item) => item.id === entry.id);
          if (!current || current.revision !== entry.revision) throw new Error("验证期间数据字典已变更，结果未覆盖最新配置，请重新验证");
          current.validation = checkedValidation(result, current);
          latest.mcpDictionary = latest.mcpDictionary.map((item) => item.id === current.id ? current : item);
          store.saveSettings(latest);
          return current;
        } finally {
          validating.delete(entry.id);
          engine.dictionaryValidationPromises.delete(pending);
        }
      }
      case "queryPlan.delete": {
        const plan = config.queryPlans.find((item) => item.id === payload.id);
        if (!plan) throw new Error("查询方案不存在");
        if (payload.revision !== undefined && payload.revision !== plan.revision)
          throw new Error("查询方案已被修改，请刷新后重试");
        if (config.tasks.some((task) => task.queryPlanId === plan.id))
          throw new Error("查询方案仍被巡检任务引用，请先更改任务的查询方案");
        signal?.throwIfAborted();
        config.queryPlans = config.queryPlans.filter((item) => item.id !== plan.id);
        store.saveSettings(config);
        return { deleted: true, id: plan.id };
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
        if (payload.id && !current) throw new Error("任务不存在");
        const task = taskConfig(
          { ...payload, ...delivery },
          latest.sources,
          current,
          latest.queryPlans,
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
      case "run.delete":
        signal?.throwIfAborted();
        return engine.deleteRuns([payload.id]);
      case "run.deleteMany":
        signal?.throwIfAborted();
        return engine.deleteRuns(payload.ids);
      case "run.deliver":
        return await engine.deliver(payload.id) ?? { accepted: true };
      case "delivery.retry":
        return await engine.retryDelivery(payload.id, payload.confirmUnknown === true) ?? { accepted: true };
      case "im.bots":
        return listBots(getIm());
      case "im.targets":
        return listTargets(getIm(), payload.botId);
      case "tools.list":
        return getTools().map((tool) => ({ ...tool, roles: QUERY_ROLES.filter((role) => compatibleQueryTool(role, tool)) })).filter((tool) => tool.roles.length);
      default:
        throw new Error("未知管理操作");
    }
  };
  let requests = 0;
  let moving = false;
  // Keep a source's credential write, revision and settings update in order.
  const sourceWrites = new Map();
  const reads = new Set([
    "state",
    "run.get",
    "run.alerts",
    "tools.list",
    "dictionary.discover",
    "dictionary.describe",
    "dictionary.import",
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
      if (method === "source.save") {
        const key = payload?.id ?? "new-source";
        const previous = sourceWrites.get(key) ?? Promise.resolve();
        const pending = previous.catch(() => {}).then(() => {
          signal?.throwIfAborted();
          return handle(method, payload, signal);
        });
        sourceWrites.set(key, pending);
        try {
          return await pending;
        } finally {
          if (sourceWrites.get(key) === pending) sourceWrites.delete(key);
        }
      }
      return await handle(method, payload, signal);
    } finally {
      requests--;
    }
  };
}
