#!/usr/bin/env node
import { main } from '../src/cli.js';

main().then(() => {
  // WebRTC implementations can retain internal socket handles briefly after
  // PeerPigeon teardown. Every foreground operation has completed here; do
  // not leave one-shot Git subcommands hanging on those implementation handles.
  process.exit(0);
}).catch((error) => {
  console.error(`git-pigeon: ${error?.message ?? error}`);
  process.exit(1);
});
