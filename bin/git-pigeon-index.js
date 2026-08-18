#!/usr/bin/env node

import { runBrowserBridgeService } from '../src/browser-bridge.js';

runBrowserBridgeService().catch((error) => {
  console.error(`git-pigeon-index: ${error?.message ?? error}`);
  process.exitCode = 1;
});
