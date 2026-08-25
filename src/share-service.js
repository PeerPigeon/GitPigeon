import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SHARE_NETWORK_ID,
  assembleBundle,
  chunkBundle,
  shareBundleChunkKey,
  shareHeadKey,
  shareRoomId,
  shareRosterKey,
  shareStoragePrefix,
  signHead,
  signRoster,
  verifyHead,
  verifyRoster,
} from './share.js';

const OWNER_POLL_MS = 15_000;
const MIRROR_POLL_MS = 10_000;

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
    const existing = await verifyRoster(await storageGet(shareRosterKey(repositoryId)), share.ownerPublicKey);
    if (existing?.signers?.includes(keyPair.pub)) return existing;
    const version = (existing?.version ?? 0) + 1;
    const signers = [...new Set([...(existing?.signers ?? []), keyPair.pub])];
    const roster = await signRoster({ repositoryId, signers, version, ownerKeyPair: keyPair });
    await node.storage?.put?.('public', shareRosterKey(repositoryId), roster);
    return roster;
  };

  const publishOnce = async () => {
    const refsDigest = await repository.refsDigest();
    if (!refsDigest || refsDigest === lastPublishedRefsDigest) return;
    const currentHead = await verifyHead(await storageGet(shareHeadKey(repositoryId)), await verifyRoster(await storageGet(shareRosterKey(repositoryId)), share.ownerPublicKey));
    const bundle = await repository.createBundle();
    if (!bundle) return;
    try {
      const { sha256, bytes, chunks } = chunkBundle(bundle.data);
      if (currentHead?.bundleSha256 === sha256) {
        lastPublishedRefsDigest = refsDigest;
        return;
      }
      for (let index = 0; index < chunks.length; index += 1) {
        await node.storage?.put?.('public', shareBundleChunkKey(repositoryId, sha256, index), { data: chunks[index] });
        subscribe(shareBundleChunkKey(repositoryId, sha256, index));
      }
      const head = await signHead({
        repositoryId,
        refs: Object.fromEntries(bundle.refs.map(({ name, oid }) => [name, oid])),
        bundleSha256: sha256,
        bundleBytes: bytes,
        chunkCount: chunks.length,
        sequence: (currentHead?.sequence ?? 0) + 1,
        keyPair,
      });
      await node.storage?.put?.('public', shareHeadKey(repositoryId), head);
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
      changeSubscription?.();
      for (const unsubscribe of subscriptions) unsubscribe?.();
      await working;
      if (!injectedNode) await node.destroy().catch(() => {});
    },
  };
}
