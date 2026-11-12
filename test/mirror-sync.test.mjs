import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { syncNpmMirror } from "../scripts/sync-npmmirror.mjs";

const name = "dsh-ops-assistant", version = "0.1.9";
const bytes = Buffer.from("test package bytes, not a real release");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const upstreamUrl = `https://registry.npmjs.org/${name}/${version}`;
const metadataUrl = `https://registry.npmmirror.com/${name}/${version}`;
const syncUrl = `https://registry-direct.npmmirror.com/-/package/${name}/syncs`;
const tarball = `https://registry.npmmirror.com/${name}/-/${name}-${version}.tgz`;
const cdn = `https://cdn.npmmirror.com/packages/${name}/${version}.tgz`;
const metadata = () => ({ name, version, dist: { integrity, tarball } });
const json = (body, status = 200) => Response.json(body, { status });

function fixture(intercept = () => undefined) {
  const calls = [], pauses = [];
  let time = 0;
  const options = { name, version, timeoutMs: 100, pollIntervalMs: 10, requestTimeoutMs: 30,
    now: () => time, sleep: async (ms) => { pauses.push(ms); time += ms; },
    fetcher: async (url, init) => {
      calls.push({ url, init });
      const custom = await intercept(url, init, calls);
      if (custom !== undefined) return custom;
      if (url === upstreamUrl || url === metadataUrl) return json(metadata());
      if (url === syncUrl) return json({ ok: true, id: "task_123", state: "waiting" }, 201);
      if (url === syncUrl + "/task_123") return json({ ok: true, id: "task_123", state: "success" });
      if (url === tarball) return new Response(bytes);
      throw new Error("Unexpected test URL");
    } };
  return { calls, pauses, run: (extra = {}) => syncNpmMirror({ ...options, ...extra }) };
}

test("sync verifies the public CDN bytes and keeps all requests credential-free", async () => {
  const f = fixture((url) => url === tarball
    ? new Response(null, { status: 302, headers: { location: cdn } })
    : url === cdn ? new Response(bytes) : undefined);
  const result = await f.run();
  assert.deepEqual(result, { name, version, integrity, tarball, bytes: bytes.length, taskId: "task_123" });
  assert.equal(f.calls[0].url, upstreamUrl);
  const mutation = f.calls.filter(({ init }) => init.method === "PUT");
  assert.equal(mutation.length, 1);
  assert.deepEqual(JSON.parse(mutation[0].init.body), { skipDependencies: true });
  assert.equal(f.calls.at(-1).url, cdn);
  for (const { init } of f.calls) {
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).has("authorization"), false);
  }
});

test("rejects direct download URLs and unpublished or invalid upstream versions before syncing", async () => {
  const invalid = fixture();
  await assert.rejects(invalid.run({ name: "https://github.com/example/package.tgz" }), /不能同步 GitHub/);
  assert.equal(invalid.calls.length, 0);
  for (const response of [() => json({ error: "Not found" }, 404), () => json(null),
    () => json({ ...metadata(), version: "0.1.8" }),
    () => json({ ...metadata(), dist: { integrity: "sha1-invalid" } })]) {
    const f = fixture((url) => url === upstreamUrl ? response() : undefined);
    await assert.rejects(f.run(), /请先发布|元数据不匹配/);
    assert.equal(f.calls.length, 1);
  }
});

test("task failure or malformed task identity cannot be mistaken for successful synchronization", async () => {
  for (const state of [{ ok: true, id: "task_123", state: "failed" },
    { ok: true, id: "another_task", state: "success" }, { ok: false, id: "task_123", state: "success" }]) {
    const f = fixture((url) => url === syncUrl + "/task_123" ? json(state) : undefined);
    await assert.rejects(f.run(), /任务失败|状态无效/);
    assert.equal(f.calls.some(({ url }) => url === metadataUrl), false);
  }
});

test("waits for task processing, public metadata and downloadable tarball to converge", async () => {
  let taskReads = 0, metadataReads = 0, downloads = 0;
  const f = fixture((url) => {
    if (url === syncUrl + "/task_123" && ++taskReads === 1)
      return json({ ok: true, id: "task_123", state: "processing" });
    if (url === metadataUrl) {
      metadataReads++;
      if (metadataReads === 1) return json({ error: "Not found" }, 404);
      if (metadataReads === 2) return json({ ...metadata(), version: "0.1.8" });
      if (metadataReads === 3) return json({ ...metadata(), dist: { integrity: "stale", tarball } });
    }
    if (url === tarball && ++downloads === 1) return new Response(null, { status: 503 });
  });
  assert.equal((await f.run()).integrity, integrity);
  assert.equal(taskReads, 2);
  assert.equal(metadataReads, 5);
  assert.equal(downloads, 2);
  assert.equal(f.pauses.length, 5);
});

test("matching metadata does not hide a tampered or oversized tarball", async () => {
  const badHash = fixture((url) => url === tarball ? new Response("tampered") : undefined);
  await assert.rejects(badHash.run(), /SHA-512 校验不匹配/);
  assert.equal(badHash.pauses.length, 0);
  for (const headers of [{}, { "content-length": "10000" }]) {
    const large = fixture((url) => url === tarball ? new Response(bytes, { headers }) : undefined);
    await assert.rejects(large.run({ maxBytes: 5 }), /超过允许大小/);
  }
});

test("refuses non-mirror tarballs, credentials and redirects out of the mirror boundary", async () => {
  for (const address of ["https://github.com/a/b.tgz", "https://evil.npmmirror.com/a.tgz",
    "http://registry.npmmirror.com/a.tgz", "https://user:secret@registry.npmmirror.com/a.tgz",
    "https://registry.npmmirror.com:8443/a.tgz"]) {
    const f = fixture((url) => url === metadataUrl ? json({ ...metadata(), dist: { integrity, tarball: address } }) : undefined);
    await assert.rejects(f.run(), /npmmirror 官方 HTTPS/);
    assert.equal(f.calls.some(({ url }) => url === address), false);
  }
  const redirect = fixture((url) => url === tarball
    ? new Response(null, { status: 302, headers: { location: "https://attacker.invalid/archive.tgz" } }) : undefined);
  await assert.rejects(redirect.run(), /npmmirror 官方 HTTPS/);
  assert.equal(redirect.calls.some(({ url }) => url.includes("attacker.invalid")), false);
});

test("stalled tasks or CDN availability have a bounded overall deadline", async () => {
  for (const delayedUrl of [syncUrl + "/task_123", metadataUrl, tarball]) {
    const f = fixture((url) => url === delayedUrl ? new Response(null, { status: 404 }) : undefined);
    await assert.rejects(f.run({ timeoutMs: 25 }), /同步及下载验证超时/);
    assert.equal(f.pauses.reduce((a, b) => a + b, 0), 25);
    assert.equal(f.calls.filter(({ url }) => url === delayedUrl).length, 3);
    assert.ok(f.calls.length <= 9);
  }
});

test("per-request timeout bounds a hanging fetch without waiting for overall polling", async () => {
  let signal;
  const f = fixture((url, init) => {
    if (url === upstreamUrl) { signal = init.signal; return new Promise(() => {}); }
  });
  await assert.rejects(f.run({ requestTimeoutMs: 5 }), /请求超时/);
  assert.equal(signal.aborted, true);
  assert.equal(f.calls.length, 1);
});
