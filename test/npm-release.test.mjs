import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { releaseVersion, verifyReleaseArchive, publishVerifiedArchive } from "../scripts/publish-npm-release.mjs";

const version = "0.1.9";
const name = "dsh-ops-assistant";
const manifest = { name, version, repository: { url: "git+https://github.com/shixungan/dsh-ops-assistant.git" },
  main: "./src/host.mjs", dsh: { bundle: { patch: "./cordis.patch.yml" } } };
const archive = Buffer.from("test archive bytes, never executed");
const sha = "a".repeat(40);
const checksum = `${createHash("sha256").update(archive).digest("hex")}  ${name}-${version}.tgz\n`;
const fixture = () => ({ version, archive, checksum, manifest: structuredClone(manifest),
  release: { repository: "shixungan/dsh-ops-assistant", tag: "v" + version, commit: sha, sourceManifest: structuredClone(manifest) },
  workflowSha: sha });
const verified = verifyReleaseArchive(fixture());
const metadata = { name, version, dist: { integrity: verified.integrity } };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const notFound = () => json({ error: "Not found" }, 404);
function scenario(responses, overrides = {}) {
  const calls = [], published = [];
  const options = { version, verified, archivePath: "/tmp/release/package.tgz", attempts: 3,
    fetcher: async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      assert.match(url, /^https:\/\/registry\.npmjs\.org\/dsh-ops-assistant\//);
      assert.ok(responses.length, "no unplanned network requests");
      return responses.shift();
    },
    publish: async (args) => { published.push(args); }, sleep: async () => {}, ...overrides,
  };
  return { options, calls, published };
}

test("release versions cannot become tag paths, prereleases or injected shell arguments", () => {
  for (const bad of [undefined, "v0.1.9", "01.1.9", "0.1.9-beta", "0.1.9; touch x", "../0.1.9", " 0.1.9", "0.1.9\n"])
    assert.throws(() => releaseVersion(bad), /版本/);
  assert.equal(releaseVersion(version), version);
});

test("release identity, source manifest and archive checksum must match before publishing", () => {
  assert.equal(verified.filename, "dsh-ops-assistant-0.1.9.tgz");
  const mutations = [
    (f) => { f.archive = Buffer.from("different"); },
    (f) => { f.checksum = f.checksum.replace("0.1.9.tgz", "../0.1.9.tgz"); },
    (f) => { f.checksum += f.checksum; },
    (f) => { f.release.repository = "other/owner"; },
    (f) => { f.release.commit = "main"; },
    (f) => { f.release.sourceManifest.version = "0.1.8"; },
    (f) => { f.manifest.name = "someone-else"; },
    (f) => { f.manifest.repository.url = "https://github.com/other/repo"; },
    (f) => { f.manifest.publishConfig = { registry: "https://mirror.invalid" }; },
    (f) => { f.manifest.publishConfig = { provenance: true }; },
    (f) => { f.manifest.private = true; },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => verifyReleaseArchive(f)); }
});

test("provenance describes only the exact workflow commit, never a historical release", () => {
  assert.equal(verifyReleaseArchive(fixture()).provenance, true);
  assert.equal(verifyReleaseArchive({ ...fixture(), workflowSha: "b".repeat(40) }).provenance, false);
  assert.equal(verifyReleaseArchive({ ...fixture(), workflowSha: undefined }).provenance, false);
});

test("identical existing versions are skipped without a publish or dist-tag mutation", async () => {
  const s = scenario([json(metadata)]);
  assert.deepEqual(await publishVerifiedArchive(s.options), { published: false, integrity: verified.integrity });
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.published, []);
  const mismatch = scenario([json({ ...metadata, dist: { integrity: "sha512-different" } })]);
  await assert.rejects(publishVerifiedArchive(mismatch.options), /不一致/);
  assert.deepEqual(mismatch.published, []);
});

test("a new release publishes only its verified archive without lifecycle scripts then verifies registry content", async () => {
  const s = scenario([notFound(), notFound(), notFound(), json(metadata)],
    { verified: { ...verified, provenance: false } });
  assert.equal((await publishVerifiedArchive(s.options)).published, true);
  assert.deepEqual(s.published, [["publish", "/tmp/release/package.tgz", "--ignore-scripts", "--access=public",
    "--tag=latest", "--registry=https://registry.npmjs.org", "--provenance=false"]]);
});

test("publishing a missing older version cannot move latest backwards", async () => {
  for (const newer of ["0.1.10", "0.2.0", "1.0.0"]) {
    const s = scenario([notFound(), json({ name, version: newer })]);
    await assert.rejects(publishVerifiedArchive(s.options), /拒绝回退/);
    assert.deepEqual(s.published, []);
  }
  const s = scenario([notFound(), json({ name, version: "0.1.8" }), json(metadata)]);
  assert.equal((await publishVerifiedArchive(s.options)).published, true);
});

test("registry errors or post-publish conflicts fail without repeated publication", async () => {
  const unavailable = scenario([json({ error: "unavailable" }, 503)]);
  await assert.rejects(publishVerifiedArchive(unavailable.options), /HTTP 503/);
  assert.equal(unavailable.published.length, 0);
  const conflict = scenario([notFound(), notFound(), json({ ...metadata, dist: { integrity: "sha512-conflict" } })]);
  await assert.rejects(publishVerifiedArchive(conflict.options), /不一致/);
  assert.equal(conflict.published.length, 1);
  const failed = scenario([notFound(), notFound()], { publish: async () => { throw new Error("npm denied"); } });
  await assert.rejects(publishVerifiedArchive(failed.options), /npm denied/);
  assert.equal(failed.calls.length, 2);
});

test("post-publication visibility retries are bounded and never republish the archive", async () => {
  const s = scenario([notFound(), notFound(), notFound(), notFound(), notFound()]);
  await assert.rejects(publishVerifiedArchive(s.options), /元数据尚不可见/);
  assert.equal(s.published.length, 1);
  assert.equal(s.calls.length, 5);
});
