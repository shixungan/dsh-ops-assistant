import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
export const packageName = "dsh-ops-assistant";
const repository = "shixungan/dsh-ops-assistant";
const registry = "https://registry.npmjs.org";
const hash = (bytes, algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);

export function releaseVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new Error("版本必须为 x.y.z，不带 v 或其他参数");
  return value;
}

function validateManifest(manifest, version) {
  if (manifest?.name !== packageName || manifest.version !== version ||
      manifest.repository?.url !== `git+https://github.com/${repository}.git` ||
      manifest.main !== "./src/host.mjs" || manifest.dsh?.bundle?.patch !== "./cordis.patch.yml")
    throw new Error("安装包名称、版本、仓库或插件入口与预期不符");
  const config = manifest.publishConfig ?? {};
  if (Object.keys(config).some((key) => !["registry", "access"].includes(key)) ||
      (config.registry && config.registry.replace(/\/$/, "") !== registry) ||
      (config.access && config.access !== "public") || manifest.private)
    throw new Error("安装包发布配置与官方公开仓库不符");
}

export function verifyReleaseArchive({ version, archive, checksum, manifest, release, workflowSha }) {
  releaseVersion(version);
  if (release?.repository !== repository || release.tag !== `v${version}` ||
      !/^[a-f0-9]{40}$/.test(release.commit)) throw new Error("Release 身份或提交记录无效");
  validateManifest(release.sourceManifest, version);
  validateManifest(manifest, version);
  if (!Buffer.isBuffer(archive) || !archive.length || archive.length > 32 * 1024 * 1024)
    throw new Error("安装包大小无效");
  const filename = `${packageName}-${version}.tgz`;
  const lines = String(checksum).trim().split(/\r?\n/);
  const expected = `${hash(archive, "sha256", "hex")}  ${filename}`;
  if (lines.length !== 1 || lines[0] !== expected) throw new Error("Release 安装包 SHA256 校验失败");
  return {
    filename,
    integrity: `sha512-${hash(archive, "sha512", "base64")}`,
    // OIDC's automatic provenance describes the workflow SHA, not an arbitrary old tag.
    provenance: release.commit === workflowSha,
  };
}

export function assertPublishedMetadata(metadata, version, integrity) {
  if (metadata?.name !== packageName || metadata.version !== version || metadata.dist?.integrity !== integrity)
    throw new Error("npm 已有同版本内容与 Release 不一致，禁止覆盖或继续同步");
}

export async function publishVerifiedArchive({ version, archivePath, verified, fetcher = fetch,
  publish, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), attempts = 12 }) {
  releaseVersion(version);
  async function metadata(suffix) {
    const response = await fetcher(`${registry}/${packageName}/${suffix}`, {
      signal: AbortSignal.timeout(15000), redirect: "error",
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`读取 npm 元数据失败：HTTP ${response.status}`);
    return response.json();
  }
  const existing = await metadata(version);
  if (existing) {
    assertPublishedMetadata(existing, version, verified.integrity);
    return { published: false, integrity: verified.integrity };
  }
  const latest = await metadata("latest");
  if (latest) {
    const prior = releaseVersion(latest.version).split(".").map(Number);
    const next = version.split(".").map(Number);
    const first = prior.findIndex((n, i) => n !== next[i]);
    if (first >= 0 && prior[first] > next[first]) throw new Error("版本低于 npm latest，拒绝回退最新版本");
  }
  await publish(["publish", archivePath, "--ignore-scripts", "--access=public", "--tag=latest",
    `--registry=${registry}`, `--provenance=${verified.provenance}`]);
  for (let i = 0; i < attempts; i++) {
    const result = await metadata(version);
    if (result) {
      assertPublishedMetadata(result, version, verified.integrity);
      return { published: true, integrity: verified.integrity };
    }
    if (i + 1 < attempts) await sleep(5000);
  }
  throw new Error("npm 发布后元数据尚不可见；请稍后重跑校验，不要变更同版本安装包");
}

async function main() {
  const version = releaseVersion(process.env.PUBLISH_VERSION);
  if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== "refs/heads/main")
    throw new Error("仅允许从本仓库 main 的受信任工作流发布");
  if (process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN)
    throw new Error("此工作流仅使用 npm Trusted Publishing，请移除长期 npm Token");
  if (!process.env.RELEASE_DIR) throw new Error("缺少已校验的 Release 目录");
  const dir = resolve(process.env.RELEASE_DIR);
  const archivePath = join(dir, `${packageName}-${version}.tgz`);
  const [archive, checksum, releaseText] = await Promise.all([
    readFile(archivePath), readFile(join(dir, "SHA256SUMS.txt"), "utf8"), readFile(join(dir, "release.json"), "utf8"),
  ]);
  // Read only this member to stdout: no archive paths or lifecycle scripts are executed.
  const { stdout: manifestText } = await exec("tar", ["-xOf", archivePath, "package/package.json"],
    { timeout: 15000, maxBuffer: 256 * 1024 });
  const verified = verifyReleaseArchive({ version, archive, checksum,
    manifest: JSON.parse(manifestText), release: JSON.parse(releaseText), workflowSha: process.env.GITHUB_SHA });
  const { stdout: npmVersion } = await exec("npm", ["--version"]);
  const [major, minor, patch] = npmVersion.trim().split(".").map(Number);
  if (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1))))
    throw new Error("npm Trusted Publishing 需要 npm 11.5.1 或更高版本");
  console.log(`校验通过：${packageName}@${version}；provenance=${verified.provenance}`);
  const result = await publishVerifiedArchive({ version, archivePath, verified,
    publish: (args) => new Promise((done, reject) => {
      const child = spawn("npm", args, { stdio: "inherit", timeout: 300000 });
      child.on("error", reject);
      child.on("exit", (code, signal) => code === 0 ? done() : reject(new Error(`npm publish 未成功：${signal ?? code}`)));
    }),
  });
  console.log(result.published ? "npm 发布及内容校验完成" : "npm 同版本内容一致，跳过重复发布");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
