import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const official = "https://registry.npmjs.org";
const mirror = "https://registry.npmmirror.com";
const direct = "https://registry-direct.npmmirror.com";
const mirrorHosts = new Set(["registry.npmmirror.com", "registry-direct.npmmirror.com", "cdn.npmmirror.com"]);
class PendingError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function mirrorUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("镜像安装包地址无效"); }
  if (url.protocol !== "https:" || !mirrorHosts.has(url.hostname) ||
      url.username || url.password || (url.port && url.port !== "443"))
    throw new Error("安装包必须来自 npmmirror 官方 HTTPS 域名");
  return url.href;
}

async function readBytes(response, limit) {
  if (Number(response.headers.get("content-length")) > limit)
    throw new Error("响应超过允许大小");
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("响应超过允许大小");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

// This only mirrors public npm releases; it cannot upload a GitHub tarball.
// Sync API: cnpm/cnpmcore app/port/controller/PackageSyncController.ts.
export async function syncNpmMirror({ name, version, fetcher = fetch, sleep = delay,
  now = Date.now, timeoutMs = 180000, requestTimeoutMs = 15000,
  pollIntervalMs = 3000, maxBytes = 10 * 1024 * 1024 } = {}) {
  if (typeof name !== "string" || name.length > 214 ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ||
      typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(version))
    throw new Error("只接受 npm 包名和明确版本，不能同步 GitHub 等下载直链");
  for (const value of [timeoutMs, requestTimeoutMs, pollIntervalMs, maxBytes])
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
      throw new Error("超时、间隔和大小限制须为正整数");
  const deadline = now() + timeoutMs;
  const remaining = () => {
    const value = deadline - now();
    if (value <= 0) throw new Error("等待 npmmirror 同步及下载验证超时");
    return value;
  };
  const pause = async () => { await sleep(Math.min(pollIntervalMs, remaining())); remaining(); };

  async function request(url, { method = "GET", body, binary = false } = {}) {
    const budget = Math.min(requestTimeoutMs, remaining());
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new PendingError("请求超时"));
        controller.abort();
      }, budget);
    });
    try {
      return await Promise.race([timeout, (async () => {
        for (let redirects = 0; ; redirects++) {
          let response;
          try {
            response = await fetcher(url, { method, body, redirect: "manual", signal: controller.signal,
              headers: body ? { "Content-Type": "application/json", Accept: "application/json" }
                : { Accept: binary ? "application/octet-stream" : "application/json" } });
          } catch { throw new PendingError("无法连接镜像服务"); }
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            if (!binary || redirects >= 3) throw new Error("镜像返回了不支持的重定向");
            const location = response.headers.get("location");
            if (!location) throw new Error("镜像重定向缺少地址");
            url = mirrorUrl(new URL(location, url).href);
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel();
            const ErrorType = [404, 408, 429].includes(response.status) || response.status >= 500 ? PendingError : Error;
            throw new ErrorType(`请求失败（HTTP ${response.status}）`, response.status);
          }
          const bytes = await readBytes(response, binary ? maxBytes : 1024 * 1024);
          if (binary) return bytes;
          try { return JSON.parse(bytes.toString("utf8")); }
          catch { throw new Error("服务未返回有效 JSON"); }
        }
      })()]);
    } finally { clearTimeout(timer); controller.abort(); }
  }

  const packagePath = `${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  let upstream;
  try { upstream = await request(`${official}/${packagePath}`); }
  catch (error) {
    if (error.status === 404) throw new Error(`npm 官方源没有 ${name}@${version}，请先发布`);
    throw error;
  }
  const integrity = upstream?.dist?.integrity;
  if (upstream?.name !== name || upstream.version !== version ||
      typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity))
    throw new Error("npm 官方元数据不匹配或缺少 SHA-512 完整性信息");
  const taskUrl = `${direct}/-/package/${encodeURIComponent(name)}/syncs`;
  const task = await request(taskUrl, { method: "PUT", body: JSON.stringify({ skipDependencies: true }) });
  if (task?.ok !== true || typeof task.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(task.id))
    throw new Error("镜像未返回有效同步任务");
  while (true) {
    try {
      const state = await request(`${taskUrl}/${task.id}`);
      if (state?.ok !== true || state.id !== task.id) throw new Error("同步任务状态无效");
      if (state.state === "success") break;
      if (!["waiting", "processing"].includes(state.state)) throw new Error("npmmirror 同步任务失败");
    } catch (error) { if (!(error instanceof PendingError)) throw error; }
    await pause();
  }
  // A completed task does not prove that the public CDN has the new bytes.
  while (true) {
    try {
      const metadata = await request(`${mirror}/${packagePath}`);
      if (metadata?.name === name && metadata.version === version && metadata.dist?.integrity === integrity) {
        const tarball = mirrorUrl(metadata.dist.tarball);
        const bytes = await request(tarball, { binary: true });
        const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
        if (actual !== integrity) throw new Error("镜像安装包 SHA-512 校验不匹配");
        return { name, version, integrity, tarball, bytes: bytes.length, taskId: task.id };
      }
    } catch (error) { if (!(error instanceof PendingError)) throw error; }
    await pause();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { name: { type: "string" }, version: { type: "string" },
      timeout: { type: "string" }, help: { type: "boolean" } } });
    if (positionals.length && (positionals.length !== 2 || values.name || values.version))
      throw new Error("请提供“包名 版本”或 --name/--version，不要混用");
    if (values.help) console.log("用法：node scripts/sync-npmmirror.mjs [包名 版本 | --name 包名 --version 版本] [--timeout 毫秒]");
    else {
      const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
      const result = await syncNpmMirror({ name: values.name ?? positionals[0] ?? pkg.name,
        version: values.version ?? positionals[1] ?? pkg.version,
        ...(values.timeout ? { timeoutMs: Number(values.timeout) } : {}) });
      console.log(`已验证国内镜像：${result.name}@${result.version}（${result.bytes} 字节，SHA-512 一致）`);
    }
  } catch (error) {
    console.error(`npmmirror 同步失败：${error.message}`);
    process.exitCode = 1;
  }
}
