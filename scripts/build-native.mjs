import { spawn } from "node:child_process";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argument = process.argv.find((value) => value.startsWith("--output="));
// `indexOf` returns -1 when the flag is absent, so the unguarded lookup read
// argv[0] — the node executable — and the build tried to copy node onto itself.
const separateIndex = process.argv.indexOf("--output");
const requestedOutput = argument?.slice("--output=".length)
  ?? (separateIndex === -1 ? undefined : process.argv[separateIndex + 1]);
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
// The real pty ships inside the executable. The standalone build used to
// fake a terminal through /usr/bin/script, which does tcgetattr on stdin —
// a pipe, in a daemon — and exits 1 before the shell ever runs: the shipped
// binary never had a working terminal on macOS at all.
const prebuild = `${process.platform}-${process.arch}`;
const ptyRoot = path.join(root, "node_modules", "node-pty");
const assetNames = process.platform === "win32"
  ? ["pty.node", "winpty-agent.exe", "winpty.dll", "conpty.node", "conpty.dll", "OpenConsole.exe"]
  : ["pty.node", "spawn-helper"];
async function collectPtyAssets() {
  const found = {};
  for (const base of [path.join(ptyRoot, "prebuilds", prebuild), path.join(ptyRoot, "build", "Release")]) {
    for (const name of assetNames) {
      if (found[`pty/${name}`]) continue;
      const file = path.join(base, name);
      try {
        await stat(file);
        found[`pty/${name}`] = file;
      } catch { /* keep looking */ }
    }
  }
  return found;
}
let assets = await collectPtyAssets();
if (!assets["pty/pty.node"] && process.platform !== "win32") {
  // Linux ships no prebuild; node-pty compiles at install time, which the
  // repository's ignore-scripts pin skips. Compile it here instead.
  console.log(`No node-pty prebuild for ${prebuild}; compiling it…`);
  await run("npm", ["rebuild", "node-pty", "--ignore-scripts=false", "--foreground-scripts"]);
  assets = await collectPtyAssets();
}
if (!assets["pty/pty.node"] && process.platform !== "win32") {
  throw new Error(`node-pty could not be built for ${prebuild}; the terminal would be dead in this binary`);
}
await writeFile(config, `${JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
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
