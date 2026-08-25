import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SHARE_NETWORK_ID,
  assembleBundle,
  chunkBundle,
  shareBlobChunkKey,
  shareBundleChunkKey,
  shareHeadKey,
  shareProposalChunkKey,
  shareProposalKey,
  shareRoomId,
  shareRosterKey,
  shareStoragePrefix,
  signHead,
  signProposal,
  signRoster,
  verifyHead,
  verifyProposal,
  verifyRoster,
} from './share.js';

const OWNER_POLL_MS = 15_000;
const MIRROR_POLL_MS = 10_000;

async function storageValue(node, key) {
  try {
    const record = await node.storage?.get?.('public', key);
    if (record?.value !== undefined && record?.value !== null) return record.value;
  } catch { /* fall through to the mesh */ }
  try {
    const value = await node.storage?.retrieve?.('public', key, { timeoutMs: 4_000 });
    return value?.value ?? value ?? null;
  } catch {
    return null;
  }
}

/**
 * A guest node for one-shot share-room commands (propose, list, accept).
 * Full room member for replication purposes, no session or lock taken.
 */
export async function connectShareGuest({ repositoryId, share, signalingServer = null, userId = `share-guest-${Date.now() % 1_000_000}` }) {
  const { installNativeWebRTC } = await import('./webrtc.js');
  await installNativeWebRTC();
  const { PeerPigeonNode } = await import('peerpigeon');
  const node = new PeerPigeonNode({
    crypto: { roomId: shareRoomId(repositoryId), roomSecret: share.key },
    networkId: SHARE_NETWORK_ID,
    sessionId: repositoryId,
    ...(signalingServer ? { signalingServer } : {}),
    storage: {
      userId,
      sessionId: `${SHARE_NETWORK_ID}:${repositoryId}`,
      syncSecret: share.key,
      dbName: `gitpigeon-share-guest-${repositoryId}`,
      // The share room carries the STANDARD repository protocol (manifests,
      // chunks, presence — the same records as the private room, minus
      // private/live/trash) plus the share-scoped proposal records.
      syncFilter: (_space, key) => String(key).startsWith(`gitpigeon/v1/${repositoryId}`)
        || String(key).startsWith(shareStoragePrefix(repositoryId)),
    },
  });
  await node.start();
  return node;
}

/**
 * Submit the current branch's commits beyond the shared head as a signed
 * proposal: the fork-and-PR path. Any link holder may propose; only an
 * owner device acting on it changes the repository.
 */
export async function submitProposal({ repository, repositoryId, share, node, keyPair, title = '', author = '' }) {
  const roster = await verifyRoster(await storageValue(node, shareRosterKey(repositoryId)), share.ownerPublicKey);
  if (!roster) throw new Error('The shared roster has not replicated yet — try again in a moment.');
  const head = await verifyHead(await storageValue(node, shareHeadKey(repositoryId)), roster);
  if (!head) throw new Error('No verified shared head is available yet.');
  const branch = (await repository.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (!branch || branch === 'HEAD') throw new Error('Check out a branch before proposing.');
  const refName = `refs/heads/${branch}`;
  const baseOid = head.refs[refName] ?? Object.entries(head.refs).find(([name]) => name === 'refs/heads/main')?.[1] ?? '';
  const localOid = (await repository.git(['rev-parse', refName])).stdout.trim();
  if (baseOid === localOid) throw new Error('Nothing to propose: this branch matches the shared head.');
  const directory = await mkdtemp(path.join(tmpdir(), 'gitpigeon-proposal-'));
  const filename = path.join(directory, 'proposal.bundle');
  try {
    const bundleArgs = ['bundle', 'create', filename, refName];
    if (baseOid) {
      const known = await repository.git(['cat-file', '-e', `${baseOid}^{commit}`]).then(() => true, () => false);
      if (known) bundleArgs.push('--not', baseOid);
    }
    await repository.git(bundleArgs);
    await repository.git(['bundle', 'verify', filename]);
    const { readFile } = await import('node:fs/promises');
    const buffer = await readFile(filename);
    const { sha256, bytes, chunks } = chunkBundle(buffer);
    const proposal = await signProposal({
      repositoryId,
      title,
      author,
      baseOid,
      refName,
      bundleSha256: sha256,
      bundleBytes: bytes,
      chunkCount: chunks.length,
      keyPair,
    });
    for (let index = 0; index < chunks.length; index += 1) {
      await node.storage?.put?.('public', shareProposalChunkKey(repositoryId, proposal.proposalId, index), { data: chunks[index] });
    }
    await node.storage?.put?.('public', shareProposalKey(repositoryId, proposal.proposalId), proposal);
    return proposal;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Every verified proposal currently replicated into this node. */
export async function listProposals({ node, repositoryId }) {
  const prefix = `${shareStoragePrefix(repositoryId)}proposal/`;
  const records = await node.storage?.list?.('public') ?? [];
  const proposals = [];
  for (const record of records) {
    if (!String(record?.key ?? '').startsWith(prefix)) continue;
    const verified = await verifyProposal(record.value);
    if (verified && verified.repositoryId === repositoryId) proposals.push(verified);
  }
  return proposals.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

/**
 * Fetch a proposal's bundle, verify it against the signed record, and land
 * it as remote-tracking refs (refs/remotes/pigeon/proposal_<id>/…) for the
 * owner to review and merge with ordinary git.
 */
export async function fetchProposal({ repository, repositoryId, node, proposalId }) {
  const proposal = await verifyProposal(await storageValue(node, shareProposalKey(repositoryId, proposalId)));
  if (!proposal) throw new Error(`No verified proposal ${proposalId} has replicated to this node.`);
  const chunks = [];
  for (let index = 0; index < proposal.chunkCount; index += 1) {
    const record = await storageValue(node, shareProposalChunkKey(repositoryId, proposalId, index));
    if (typeof record?.data !== 'string') throw new Error('The proposal bundle has not fully replicated yet.');
    chunks.push(record.data);
  }
  const buffer = assembleBundle(chunks, proposal.bundleSha256, proposal.bundleBytes);
  if (!buffer) throw new Error('The proposal bundle failed its digest — refusing it.');
  const directory = await mkdtemp(path.join(tmpdir(), 'gitpigeon-proposal-'));
  const filename = path.join(directory, 'proposal.bundle');
  try {
    await writeFile(filename, buffer);
    await repository.git(['bundle', 'verify', filename]);
    // Review refs only — NEVER the local branches. importBundle exists for
    // trusted device sync and fast-forwards; a proposal is untrusted until
    // a person merges it themselves.
    const namespace = `refs/remotes/pigeon/proposal_${proposal.proposalId.slice(0, 8)}`;
    const heads = (await repository.git(['bundle', 'list-heads', filename])).stdout
      .split('\n').filter(Boolean)
      .map((line) => line.split(' '))
      .filter(([, name]) => name?.startsWith('refs/heads/'));
    if (!heads.length) throw new Error('The proposal bundle carries no branches.');
    const refspecs = heads.map(([, name]) => `+${name}:${namespace}/${name.slice('refs/heads/'.length)}`);
    await repository.git(['fetch', '--no-tags', '--no-write-fetch-head', filename, ...refspecs]);
    return {
      proposal,
      reviewRefs: heads.map(([, name]) => `${namespace}/${name.slice('refs/heads/'.length)}`),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The share room service. One per shared repository, alongside the private
 * session.
 *
 * As OWNER it keeps the room's roster signed and publishes a signed head +
 * chunked git bundle whenever the repository's refs change. As MIRROR it
 * verifies the roster against the URL's owner key, verifies each head
 * against the roster, imports the bundle into the local clone — and, by
 * replicating the records, keeps the repository available when the owner is
 * offline. Membership grants carriage, signatures grant authority.
 */
export async function startShareService({
  repository,
  repositoryId,
  share,
  keyPair = null,
  signalingServer = null,
  node: injectedNode = null,
  logger = {},
}) {
  const role = share.role === 'owner' ? 'owner' : 'mirror';
  let node = injectedNode;
  if (!node) {
    const { installNativeWebRTC } = await import('./webrtc.js');
    await installNativeWebRTC();
    const { PeerPigeonNode } = await import('peerpigeon');
    node = new PeerPigeonNode({
      crypto: { roomId: shareRoomId(repositoryId), roomSecret: share.key },
      networkId: SHARE_NETWORK_ID,
      sessionId: repositoryId,
      ...(signalingServer ? { signalingServer } : {}),
      storage: {
        userId: `share-${role}-${String(share.ownerPublicKey).slice(0, 12)}`,
        sessionId: `${SHARE_NETWORK_ID}:${repositoryId}`,
        syncSecret: share.key,
        dbName: `gitpigeon-share-${repositoryId}`,
        syncFilter: (_space, key) => String(key).startsWith(shareStoragePrefix(repositoryId)),
      },
    });
    await node.start();
  }

  let closed = false;
  let timer = null;
  let working = Promise.resolve();
  let lastPublishedRefsDigest = null;
  let lastHeadRecord = null;
  let lastRosterRecord = null;
  let lastBundleSha = null;
  let lastAppliedSequence = 0;
  const status = { role, peers: () => node.getConnectedPeers().length, lastError: null, publishedSequence: 0, appliedSequence: 0 };

  const storageGet = async (key) => {
    try {
      const record = await node.storage?.get?.('public', key);
      if (record?.value !== undefined && record?.value !== null) return record.value;
    } catch { /* fall through to the mesh */ }
    try {
      const value = await node.storage?.retrieve?.('public', key, { timeoutMs: 4_000 });
      return value?.value ?? value ?? null;
    } catch {
      return null;
    }
  };

  const subscriptions = [];
  const subscribe = (key) => {
    const unsubscribe = node.storage?.subscribeKey?.('public', key);
    if (unsubscribe) subscriptions.push(unsubscribe);
  };
  subscribe(shareRosterKey(repositoryId));
  subscribe(shareHeadKey(repositoryId));

  const ensureRoster = async () => {
    const raw = await storageGet(shareRosterKey(repositoryId));
    const existing = await verifyRoster(raw, share.ownerPublicKey);
    if (existing?.signers?.includes(keyPair.pub)) {
      // Memory-backed storage: after a restart the record may only live in
      // remote replicas. Re-seed the raw signed record locally so this node
      // serves it even when every replica leaves.
      try {
        const local = await node.storage?.get?.('public', shareRosterKey(repositoryId));
        if (!local?.value && raw) await node.storage?.put?.('public', shareRosterKey(repositoryId), raw);
      } catch { /* the next pass retries */ }
      lastRosterRecord = raw;
      return existing;
    }
    const version = (existing?.version ?? 0) + 1;
    const signers = [...new Set([...(existing?.signers ?? []), keyPair.pub])];
    const roster = await signRoster({ repositoryId, signers, version, ownerKeyPair: keyPair });
    await node.storage?.put?.('public', shareRosterKey(repositoryId), roster);
    lastRosterRecord = roster;
    return roster;
  };

  // LOCAL presence only — never the mesh. The skip decisions below exist to
  // avoid re-uploading data this node already serves; a copy that lives only
  // in some browser tab across the mesh serves nobody once that tab closes.
  // Watcher storage is memory-backed, so after a restart local misses are
  // the norm and everything content-addressed gets re-seeded.
  const storedLocally = async (key) => {
    try {
      const record = await node.storage?.get?.('public', key);
      return record?.value !== undefined && record?.value !== null;
    } catch {
      return false;
    }
  };

  const publishOnce = async () => {
    const refsDigest = await repository.refsDigest();
    if (!refsDigest) return;
    // Heartbeat: mesh records EXPIRE — retrievable minutes after publishing,
    // gone later, exactly like the index directory (which republishes on a
    // heartbeat for this reason). While nothing changed and this node still
    // holds its chunks, re-putting the two small signed records every pass
    // keeps the share alive; when local copies are missing (memory-backed
    // storage after a restart, or local expiry), fall through and re-seed
    // everything.
    if (refsDigest === lastPublishedRefsDigest && lastHeadRecord && lastBundleSha
      && await storedLocally(shareBundleChunkKey(repositoryId, lastBundleSha, 0))) {
      await node.storage?.put?.('public', shareHeadKey(repositoryId), lastHeadRecord);
      if (lastRosterRecord) await node.storage?.put?.('public', shareRosterKey(repositoryId), lastRosterRecord);
      return;
    }
    const rawHead = await storageGet(shareHeadKey(repositoryId));
    const currentHead = await verifyHead(rawHead, await verifyRoster(await storageGet(shareRosterKey(repositoryId)), share.ownerPublicKey));
    const bundle = await repository.createBundle();
    if (!bundle) return;
    try {
      const { sha256, bytes, chunks } = chunkBundle(bundle.data);
      for (let index = 0; index < chunks.length; index += 1) {
        const key = shareBundleChunkKey(repositoryId, sha256, index);
        if (!(await storedLocally(key))) await node.storage?.put?.('public', key, { data: chunks[index] });
        subscribe(key);
      }
      // The browsable snapshot: each committed file, content-addressed, so a
      // browser reads the repository without unpacking the git bundle.
      // Content addressing makes republished heads cheap — unchanged blobs
      // are already in the room.
      const files = [];
      let snapshotBytes = 0;
      const tree = (await repository.git(['ls-tree', '-r', '-z', 'HEAD'])).stdout.split('\0').filter(Boolean);
      for (const line of tree) {
        const [meta, filePath] = line.split('\t');
        const [, type, oid] = (meta ?? '').split(' ');
        if (type !== 'blob' || !filePath) continue;
        const size = Number((await repository.git(['cat-file', '-s', oid])).stdout.trim());
        if (!Number.isSafeInteger(size) || size > 1024 * 1024 || snapshotBytes + size > 32 * 1024 * 1024) continue;
        const content = (await repository.git(['cat-file', 'blob', oid], { encoding: null })).stdout;
        const blob = chunkBundle(content);
        const firstChunkKey = shareBlobChunkKey(repositoryId, blob.sha256, 0);
        subscribe(firstChunkKey);
        if (!(await storedLocally(firstChunkKey))) {
          for (let index = 0; index < blob.chunks.length; index += 1) {
            await node.storage?.put?.('public', shareBlobChunkKey(repositoryId, blob.sha256, index), { data: blob.chunks[index] });
          }
        }
        files.push({ path: filePath, size: blob.bytes, sha256: blob.sha256, chunkCount: blob.chunks.length });
        snapshotBytes += size;
      }
      // Same content as the current head: the chunks above are re-seeded
      // (that is the point after a restart), but no new head is minted.
      if (currentHead?.bundleSha256 === sha256) {
        // The RAW record keeps its signature; the verified value does not.
        if (rawHead) await node.storage?.put?.('public', shareHeadKey(repositoryId), rawHead);
        lastHeadRecord = rawHead;
        lastBundleSha = sha256;
        lastPublishedRefsDigest = refsDigest;
        status.publishedSequence = currentHead.sequence;
        logger.info?.(`Re-seeded shared ${repositoryId.slice(0, 8)} head #${currentHead.sequence} records`);
        return;
      }
      const head = await signHead({
        repositoryId,
        refs: Object.fromEntries(bundle.refs.map(({ name, oid }) => [name, oid])),
        bundleSha256: sha256,
        bundleBytes: bytes,
        chunkCount: chunks.length,
        sequence: (currentHead?.sequence ?? 0) + 1,
        keyPair,
        files,
        name: path.basename(repository.root),
      });
      await node.storage?.put?.('public', shareHeadKey(repositoryId), head);
      lastHeadRecord = head;
      lastBundleSha = sha256;
      lastPublishedRefsDigest = refsDigest;
      status.publishedSequence = head.sequence;
      logger.info?.(`Shared ${repositoryId.slice(0, 8)} head #${head.sequence} (${bundle.refs.length} refs, ${bytes} bytes)`);
    } finally {
      await bundle.dispose();
    }
  };

  const mirrorOnce = async () => {
    const roster = await verifyRoster(await storageGet(shareRosterKey(repositoryId)), share.ownerPublicKey);
    if (!roster) return;
    const head = await verifyHead(await storageGet(shareHeadKey(repositoryId)), roster);
    if (!head || head.sequence <= lastAppliedSequence) return;
    const chunks = [];
    for (let index = 0; index < head.chunkCount; index += 1) {
      const key = shareBundleChunkKey(repositoryId, head.bundleSha256, index);
      subscribe(key);
      const record = await storageGet(key);
      const data = record?.data ?? null;
      if (typeof data !== 'string') return; // not fully replicated yet; next pass retries
      chunks.push(data);
    }
    const buffer = assembleBundle(chunks, head.bundleSha256, head.bundleBytes);
    if (!buffer) return;
    const directory = await mkdtemp(path.join(tmpdir(), 'gitpigeon-share-'));
    const filename = path.join(directory, 'shared.bundle');
    try {
      await writeFile(filename, buffer);
      await repository.importBundle(filename, 'shared');
      // A fresh mirror has no local branches yet: materialize them from the
      // verified head so the clone is usable immediately.
      const localRefs = await repository.refs();
      if (!localRefs.some(({ name }) => name.startsWith('refs/heads/'))) {
        for (const [name, oid] of Object.entries(head.refs)) {
          if (!name.startsWith('refs/heads/')) continue;
          await repository.git(['branch', '--force', name.slice('refs/heads/'.length), oid]);
        }
        const first = Object.keys(head.refs).find((name) => name === 'refs/heads/main')
          ?? Object.keys(head.refs).find((name) => name.startsWith('refs/heads/'));
        if (first) await repository.git(['checkout', '--force', first.slice('refs/heads/'.length)]);
      }
      lastAppliedSequence = head.sequence;
      status.appliedSequence = head.sequence;
      logger.info?.(`Mirrored shared ${repositoryId.slice(0, 8)} head #${head.sequence}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  // Direct chunk serving: storage replication moves the SMALL signed records
  // reliably, but bulk content rides request/response over PeerPigeon's
  // encrypted direct messages — the exact transport the paired snapshot path
  // uses, because it is the one that works from browsers. Any room member
  // holding a chunk answers, owner or mirror alike.
  const serveChunks = (message) => {
    if (closed || message?.local || !message?.fromPeerId) return;
    let value = message.data;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return; }
    }
    if (value?.protocol !== 'gitpigeon-share-chunk/1' || value.kind !== 'request') return;
    const kindOf = value.chunkKind === 'bundle' ? 'bundle' : 'blob';
    const sha256 = String(value.sha256 ?? '');
    const index = Number(value.index);
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(index) || index < 0) return;
    const key = kindOf === 'bundle'
      ? shareBundleChunkKey(repositoryId, sha256, index)
      : shareBlobChunkKey(repositoryId, sha256, index);
    (async () => {
      const record = await node.storage?.get?.('public', key);
      const data = record?.value?.data;
      if (typeof data !== 'string') return;
      await node.sendEncryptedDirect(message.fromPeerId, JSON.stringify({
        protocol: 'gitpigeon-share-chunk/1',
        kind: 'chunk',
        requestId: String(value.requestId ?? '').slice(0, 64),
        sha256,
        index,
        data,
      }));
    })().catch((error) => logger.debug?.(`Share chunk serve: ${error.message}`));
  };
  node.on?.('message', serveChunks);

  const tick = () => {
    if (closed) return;
    working = working.then(async () => {
      if (closed) return;
      try {
        if (role === 'owner') await publishOnce();
        else await mirrorOnce();
        status.lastError = null;
      } catch (error) {
        status.lastError = String(error?.message ?? error).slice(0, 200);
        logger.debug?.(`Share ${role} pass: ${status.lastError}`);
      }
    });
  };

  if (role === 'owner') {
    if (!keyPair?.priv) throw new Error('An owner share needs the machine key pair');
    await ensureRoster().catch((error) => logger.debug?.(`Share roster: ${error.message}`));
  }
  const changeSubscription = node.storage?.subscribe?.((event) => {
    if (event?.origin === 'remote' && event.space === 'public' && String(event.key ?? '').startsWith(shareStoragePrefix(repositoryId))) tick();
  }) ?? null;
  tick();
  timer = setInterval(tick, role === 'owner' ? OWNER_POLL_MS : MIRROR_POLL_MS);
  timer.unref?.();

  return {
    status,
    /** The owner publishes promptly after a local change instead of waiting out the poll. */
    changed: tick,
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      node.off?.('message', serveChunks);
      changeSubscription?.();
      for (const unsubscribe of subscriptions) unsubscribe?.();
      await working;
      if (!injectedNode) await node.destroy().catch(() => {});
    },
  };
}
