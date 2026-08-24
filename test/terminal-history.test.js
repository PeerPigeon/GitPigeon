import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalHistory, terminalHistoryKey } from '../src/terminal-history.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function fakeStorageNode() {
  const records = new Map();
  const subscribers = new Set();
  return {
    records,
    subscribers,
    emitRemote(key) {
      for (const callback of subscribers) callback({ origin: 'remote', op: 'upsert', space: 'public', key });
    },
    storage: {
      async get(space, key) {
        return records.has(`${space}\0${key}`) ? { value: records.get(`${space}\0${key}`) } : null;
      },
      async put(space, key, value) {
        records.set(`${space}\0${key}`, value);
      },
      async retrieve() { return null; },
      subscribeKey() { return () => {}; },
      subscribe(callback) {
        subscribers.add(callback);
        return () => subscribers.delete(callback);
      },
    },
  };
}

test('terminal history lives in mesh storage and merges across devices', async () => {
  const node = fakeStorageNode();
  const key = terminalHistoryKey('index-1');
  const history = createTerminalHistory({ node, key, deviceId: 'pro' });
  await history.ready();

  history.add('git status', 1000);
  history.add('npm test', 2000);
  // Re-running the previous command is not new information.
  history.add('npm test', 3000);
  await settle();

  assert.deepEqual(history.lines(), ['git status', 'npm test']);
  const stored = node.records.get(`public\0${key}`);
  assert.equal(stored.entries.length, 2);
  assert.equal(stored.entries[0].device, 'pro');

  // Another device's record lands remotely; it merges by time, no unions.
  node.records.set(`public\0${key}`, {
    entries: [
      ...stored.entries,
      { at: 1500, device: 'air', line: 'ls -la' },
      { at: 1500, device: 'air', line: 'ls -la' },
    ],
  });
  node.emitRemote(key);
  await settle();
  assert.deepEqual(history.lines(), ['git status', 'ls -la', 'npm test']);

  // A local add read-merge-writes so the sibling's entries survive the put.
  history.add('git log', 4000);
  await settle();
  const merged = node.records.get(`public\0${key}`);
  assert.deepEqual(merged.entries.map((entry) => entry.line), ['git status', 'ls -la', 'npm test', 'git log']);

  await history.close();
});

test('injected junk never validates into history entries', async () => {
  const node = fakeStorageNode();
  const history = createTerminalHistory({ node, key: terminalHistoryKey('index-2'), deviceId: 'pro' });
  await history.ready();
  history.add('', 1000);
  history.add('   ', 1100);
  history.add('a'.repeat(5000), 1200);
  await settle();
  assert.equal(history.lines().length, 1);
  assert.equal(history.lines()[0].length, 2000);
  await history.close();
});
