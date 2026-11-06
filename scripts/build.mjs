import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
const result = await build({
  entryPoints: ["client/index.jsx"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: ["chrome100"],
  external: ["react", "react-dom"],
  write: false,
  minify: true,
  legalComments: "none",
});
await mkdir("lib", { recursive: true });
await writeFile(
  "lib/client.js",
  `window.__ModuleLoader__.load({id:"dsh-ops-assistant",factory:(require)=>{var module={exports:{}};var exports=module.exports;${result.outputFiles[0].text}\nreturn module.exports;}});\n`,
);
console.log("Built DSH browser plugin.");
