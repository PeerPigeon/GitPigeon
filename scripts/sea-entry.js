import { main } from "../src/cli.js";

main().catch((error) => {
  console.error(`git-pigeon: ${error?.message ?? error}`);
  process.exitCode = 1;
});
