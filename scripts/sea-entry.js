import { main } from "../src/cli.js";

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(`git-pigeon: ${error?.message ?? error}`);
  process.exit(1);
});
