import { spawn } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argument = process.argv.find((value) => value.startsWith("--output="));
const requestedOutput = argument?.slice("--output=".length)
  ?? process.argv[process.argv.indexOf("--output") + 1];
const output = path.resolve(root, requestedOutput || path.join("dist", process.platform === "win32" ? "git-pigeon.exe" : "git-pigeon"));
const work = path.join(root, ".gitpigeon-build");
const bundle = path.join(work, "git-pigeon.cjs");
const blob = path.join(work, "git-pigeon.blob");
const config = path.join(work, "sea-config.json");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with status ${code}`)));
  });
}

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
await mkdir(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(root, "scripts", "sea-entry.js")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: false,
  minifySyntax: true,
  sourcemap: false,
  external: ["node-pty"],
  define: { __GITPIGEON_STANDALONE__: "true" },
});
await writeFile(config, `${JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
})}\n`);
await run(process.execPath, ["--experimental-sea-config", config]);
await copyFile(process.execPath, output);
if (process.platform === "darwin") {
  await run("codesign", ["--remove-signature", output]).catch(() => {});
}
const postject = path.join(root, "node_modules", "postject", "dist", "cli.js");
const injection = [
  output,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (process.platform === "darwin") injection.push("--macho-segment-name", "NODE_SEA");
await run(process.execPath, [postject, ...injection]);
if (process.platform === "darwin") await run("codesign", ["--sign", "-", output]);
await rm(work, { recursive: true, force: true });
console.log(`Built standalone GitPigeon executable: ${output}`);
