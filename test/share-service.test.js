import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitRepository } from '../src/git.js';
import { fetchProposal, listProposals, startShareService, submitProposal } from '../src/share-service.js';
import { createShareKey, shareHeadKey, signHead } from '../src/share.js';

const repositoryId = 'f0e1d2c3b4a59687';

function fakeShareNode(records) {
  const subscribers = new Set();
  return {
    records,
    emit(key) {
      for (const callback of subscribers) callback({ origin: 'remote', op: 'upsert', space: 'public', key });
    },
    getConnectedPeers: () => ['peer'],
    storage: {
      async get(space, key) {
        return records.has(key) ? { value: records.get(key) } : null;
      },
      async put(space, key, value) {
        records.set(key, value);
      },
      async retrieve() { return null; },
      async list() {
        return [...records.entries()].map(([key, value]) => ({ space: 'public', key, value }));
      },
      subscribeKey() { return () => {}; },
      subscribe(callback) {
        subscribers.add(callback);
        return () => subscribers.delete(callback);
      },
    },
  };
}

const until = async (predicate, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

test('an owner publishes a signed head and a mirror materializes the clone', async (t) => {
  const rootA = await mkdtemp(path.join(tmpdir(), 'gitpigeon-share-owner-'));
  const rootB = await mkdtemp(path.join(tmpdir(), 'gitpigeon-share-mirror-'));
  t.after(() => Promise.all([
    rm(rootA, { recursive: true, force: true }),
    rm(rootB, { recursive: true, force: true }),
  ]));
  const repoA = await GitRepository.init(rootA);
  await repoA.git(['config', 'user.email', 'owner@example.test']);
  await repoA.git(['config', 'user.name', 'Owner']);
  await writeFile(path.join(rootA, 'README.md'), 'shared over the mesh\n');
  await repoA.git(['add', 'README.md']);
  await repoA.git(['commit', '-m', 'first shared commit']);

  const { generateRandomPair } = await import('unsea');
  const owner = await generateRandomPair();
  const stranger = await generateRandomPair();
  const records = new Map();
  const ownerNode = fakeShareNode(records);
  const mirrorNode = fakeShareNode(records);
  const share = { key: createShareKey(), ownerPublicKey: owner.pub };

  const ownerService = await startShareService({
    repository: repoA,
    repositoryId,
    share: { ...share, role: 'owner' },
    keyPair: owner,
    node: ownerNode,
  });
  t.after(() => ownerService.close());
  assert.ok(await until(() => records.has(shareHeadKey(repositoryId))), 'the owner published a head');

  const repoB = await GitRepository.init(rootB);
  const mirrorService = await startShareService({
    repository: repoB,
    repositoryId,
    share: { ...share, role: 'mirror' },
    node: mirrorNode,
  });
  t.after(() => mirrorService.close());
  assert.ok(await until(async () => {
    try { return (await readFile(path.join(rootB, 'README.md'), 'utf8')).includes('shared over the mesh'); }
    catch { return false; }
  }), 'the mirror materialized the working tree from the verified bundle');

  // A new commit on the owner side flows through as a higher sequence.
  await writeFile(path.join(rootA, 'README.md'), 'shared over the mesh\nsecond line\n');
  await repoA.git(['add', 'README.md']);
  await repoA.git(['commit', '-m', 'second shared commit']);
  ownerService.changed();
  assert.ok(await until(() => mirrorService.status.appliedSequence >= 2), 'the mirror followed the new head');

  // A forged head — valid signature, unrostered key — must be ignored.
  const forged = await signHead({
    repositoryId,
    refs: { 'refs/heads/main': 'd'.repeat(40) },
    bundleSha256: 'd'.repeat(64),
    bundleBytes: 10,
    chunkCount: 1,
    sequence: 99,
    keyPair: stranger,
  });
  records.set(shareHeadKey(repositoryId), forged);
  mirrorNode.emit(shareHeadKey(repositoryId));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(mirrorService.status.appliedSequence < 99, 'the forged head was rejected');
});

test('a mirror proposes commits; the owner lists and lands them for review', async (t) => {
  const rootA = await mkdtemp(path.join(tmpdir(), 'gitpigeon-pr-owner-'));
  const rootB = await mkdtemp(path.join(tmpdir(), 'gitpigeon-pr-fork-'));
  t.after(() => Promise.all([
    rm(rootA, { recursive: true, force: true }),
    rm(rootB, { recursive: true, force: true }),
  ]));
  const repoA = await GitRepository.init(rootA);
  await repoA.git(['config', 'user.email', 'owner@example.test']);
  await repoA.git(['config', 'user.name', 'Owner']);
  await writeFile(path.join(rootA, 'app.js'), 'console.log(1)\n');
  await repoA.git(['add', 'app.js']);
  await repoA.git(['commit', '-m', 'base']);

  const { generateRandomPair } = await import('unsea');
  const owner = await generateRandomPair();
  const visitor = await generateRandomPair();
  const records = new Map();
  const ownerNode = fakeShareNode(records);
  const forkNode = fakeShareNode(records);
  const share = { key: createShareKey(), ownerPublicKey: owner.pub };

  const ownerService = await startShareService({
    repository: repoA, repositoryId, share: { ...share, role: 'owner' }, keyPair: owner, node: ownerNode,
  });
  t.after(() => ownerService.close());
  assert.ok(await until(() => records.has(shareHeadKey(repositoryId))));

  const repoB = await GitRepository.init(rootB);
  const mirrorService = await startShareService({
    repository: repoB, repositoryId, share: { ...share, role: 'mirror' }, node: forkNode,
  });
  await until(() => mirrorService.status.appliedSequence >= 1);
  await mirrorService.close();

  // The visitor commits on their mirror and proposes it.
  await repoB.git(['config', 'user.email', 'visitor@example.test']);
  await repoB.git(['config', 'user.name', 'Visitor']);
  await writeFile(path.join(rootB, 'app.js'), 'console.log(2)\n');
  await repoB.git(['add', 'app.js']);
  await repoB.git(['commit', '-m', 'improve the number']);
  const proposal = await submitProposal({
    repository: repoB, repositoryId, share, node: forkNode, keyPair: visitor,
    title: 'Improve the number', author: 'Visitor',
  });
  assert.equal(proposal.title, 'Improve the number');

  // The owner sees it and lands it as review refs — never a direct edit.
  const listed = await listProposals({ node: ownerNode, repositoryId });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].proposalId, proposal.proposalId);
  const { reviewRefs } = await fetchProposal({ repository: repoA, repositoryId, node: ownerNode, proposalId: proposal.proposalId });
  assert.equal(reviewRefs.length, 1);
  assert.ok(reviewRefs[0].startsWith('refs/remotes/pigeon/proposal_'));
  const shown = await repoA.git(['show', `${reviewRefs[0]}:app.js`]);
  assert.equal(shown.stdout, 'console.log(2)\n');
  // Review is not merge: the owner's branch is untouched until they merge.
  const ownerMain = await repoA.git(['show', 'refs/heads/main:app.js']);
  assert.equal(ownerMain.stdout, 'console.log(1)\n');
});
