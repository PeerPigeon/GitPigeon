import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CloudSyncGuard,
  DROPBOX_IGNORE_STREAM,
  DROPBOX_IGNORE_XATTR,
  DROPBOX_IGNORE_XATTR_LINUX,
  FILE_PROVIDER_DOMAIN_XATTR,
  FILE_PROVIDER_IGNORE_XATTR,
  cloudSyncedRoots,
  detectCloudStorage,
  excludeDirectoryFromCloudSync,
  findToolingDirectories,
  sweepCloudStorage,
  toolingDirectoryOf,
} from '../src/cloud-storage.js';

const ICLOUD_DOMAIN = 'com.apple.CloudDocs.iCloudDriveFileProvider/21A66436-BC9B-4C39-BA32-943CB8E95766';
const DROPBOX_DOMAIN = 'com.getdropbox.dropbox.fileprovider/main';

// A fake `xattr` / `setfattr` / `getfattr` / `powershell.exe`: markers live in
// memory, and the File Provider domain attribute is present on `domains`.
function fakeTools({ domains = {} } = {}) {
  const markers = new Map();
  const calls = [];
  const key = (name, file) => `${name}\0${file}`;
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'xattr' && args[0] === '-p') {
      const [, name, ...files] = args;
      if (name === FILE_PROVIDER_DOMAIN_XATTR) {
        const lines = files.filter((file) => domains[file]).map((file) => `${file}: ${domains[file]}`);
        if (lines.length !== files.length) {
          const error = new Error('xattr: No such xattr');
          error.stdout = lines.length ? `${lines.join('\n')}\n` : '';
          throw error;
        }
        return { stdout: `${lines.join('\n')}\n`, stderr: '' };
      }
      const value = markers.get(key(name, files[0]));
      if (value === undefined) throw new Error(`xattr: ${files[0]}: No such xattr: ${name}`);
      return { stdout: `${value}\n`, stderr: '' };
    }
    if (command === 'xattr' && args[0] === '-w') {
      markers.set(key(args[1], args[3]), args[2]);
      return { stdout: '', stderr: '' };
    }
    if (command === 'getfattr') {
      const value = markers.get(key(args[2], args[3]));
      if (value === undefined) throw new Error('getfattr: No such attribute');
      return { stdout: `${value}\n`, stderr: '' };
    }
    if (command === 'setfattr') {
      markers.set(key(args[1], args[4]), args[3]);
      return { stdout: '', stderr: '' };
    }
    if (command === 'powershell.exe') {
      const script = args.at(-1);
      const file = /-LiteralPath '((?:[^']|'')*)'/.exec(script)[1].replaceAll("''", "'");
      if (script.startsWith('Get-Content')) {
        const value = markers.get(key(DROPBOX_IGNORE_STREAM, file));
        if (value === undefined) throw new Error('Get-Content: stream not found');
        return { stdout: `${value}\n`, stderr: '' };
      }
      markers.set(key(DROPBOX_IGNORE_STREAM, file), '1');
      return { stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  return { run, calls, markers, marked: (name, file) => markers.get(key(name, file)) };
}

function fakeLog() {
  const lines = { info: [], warn: [], debug: [] };
  return {
    lines,
    info: (message) => lines.info.push(message),
    warn: (message) => lines.warn.push(message),
    debug: (message) => lines.debug.push(message),
    error: () => {},
  };
}

async function temporaryRepository() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-cloud-')));
  await mkdir(path.join(root, '.git', 'node_modules'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(root, 'packages', 'web', 'node_modules', 'other'), { recursive: true });
  await mkdir(path.join(root, 'packages', 'web', 'dist'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.js'), 'export {};\n');
  return root;
}

test('toolingDirectoryOf names the artifact tree a watcher event belongs to', () => {
  assert.equal(toolingDirectoryOf('node_modules'), 'node_modules');
  assert.equal(toolingDirectoryOf('node_modules/pkg/index.js'), 'node_modules');
  assert.equal(toolingDirectoryOf('packages/web/node_modules/pkg/index.js'), 'packages/web/node_modules');
  assert.equal(toolingDirectoryOf('packages\\web\\dist\\bundle.js'), 'packages/web/dist');
  assert.equal(toolingDirectoryOf('src/app.js'), null);
  assert.equal(toolingDirectoryOf('.git/index'), null);
  assert.equal(toolingDirectoryOf(''), null);
});

test('findToolingDirectories lists every artifact tree without entering .git or the trees themselves', async () => {
  const root = await temporaryRepository();
  try {
    assert.deepEqual(await findToolingDirectories(root), [
      'node_modules', 'packages/web/dist', 'packages/web/node_modules',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('macOS: a File Provider domain on any ancestor identifies the cloud and its marker', async () => {
  const home = '/Users/someone';
  const repo = path.join(home, 'Documents', 'Work', 'repo');
  const icloud = fakeTools({ domains: { [path.join(home, 'Documents')]: ICLOUD_DOMAIN } });
  assert.deepEqual(await detectCloudStorage(repo, { platform: 'darwin', homedir: home, env: {}, run: icloud.run, read: async () => { throw new Error('ENOENT'); } }), {
    provider: 'icloud', root: path.join(home, 'Documents'), markers: ['file-provider'],
  });
  const dropboxRoot = path.join(home, 'Library', 'CloudStorage', 'Dropbox');
  const dropbox = fakeTools({ domains: { [dropboxRoot]: DROPBOX_DOMAIN } });
  assert.deepEqual(await detectCloudStorage(path.join(dropboxRoot, 'repo'), { platform: 'darwin', homedir: home, env: {}, run: dropbox.run, read: async () => { throw new Error('ENOENT'); } }), {
    provider: 'dropbox', root: dropboxRoot, markers: ['file-provider', 'dropbox-xattr'],
  });
  const none = fakeTools();
  assert.equal(await detectCloudStorage(path.join(home, 'code', 'repo'), { platform: 'darwin', homedir: home, env: {}, run: none.run, read: async () => { throw new Error('ENOENT'); } }), null);
});

test('macOS: the legacy Dropbox client is found through info.json; legacy OneDrive has no marker', async () => {
  const home = '/Users/someone';
  const none = fakeTools();
  const read = async (file) => {
    assert.equal(file, path.join(home, '.dropbox', 'info.json'));
    return JSON.stringify({ personal: { path: path.join(home, 'Dropbox') } });
  };
  assert.deepEqual(await detectCloudStorage(path.join(home, 'Dropbox', 'repo'), { platform: 'darwin', homedir: home, env: {}, run: none.run, read }), {
    provider: 'dropbox', root: path.join(home, 'Dropbox'), markers: ['dropbox-xattr'],
  });
  assert.deepEqual(await detectCloudStorage(path.join(home, 'OneDrive', 'repo'), { platform: 'darwin', homedir: home, env: {}, run: none.run, read }), {
    provider: 'onedrive', root: path.join(home, 'OneDrive'), markers: [],
  });
});

test('Windows and Linux detection', async () => {
  const noDropbox = async () => { throw new Error('ENOENT'); };
  const windowsHome = 'C:\\Users\\someone';
  const oneDrive = await detectCloudStorage(path.join(windowsHome, 'OneDrive', 'repo'), {
    platform: 'win32', homedir: windowsHome, env: { OneDrive: path.join(windowsHome, 'OneDrive') }, read: noDropbox,
  });
  assert.equal(oneDrive.provider, 'onedrive');
  assert.deepEqual(oneDrive.markers, []);
  const dropboxWindows = await detectCloudStorage(path.join(windowsHome, 'Dropbox', 'repo'), {
    platform: 'win32',
    homedir: windowsHome,
    env: { APPDATA: path.join(windowsHome, 'AppData', 'Roaming') },
    read: async (file) => {
      assert.equal(file, path.join(windowsHome, 'AppData', 'Roaming', 'Dropbox', 'info.json'));
      return JSON.stringify({ personal: { path: path.join(windowsHome, 'Dropbox') } });
    },
  });
  assert.deepEqual(dropboxWindows.markers, ['dropbox-stream']);
  const linux = await detectCloudStorage('/home/someone/Dropbox/repo', {
    platform: 'linux',
    homedir: '/home/someone',
    env: {},
    read: async () => JSON.stringify({ business: { path: '/home/someone/Dropbox' } }),
  });
  assert.deepEqual(linux, { provider: 'dropbox', root: '/home/someone/Dropbox', markers: ['dropbox-xattr-linux'] });
  assert.equal(await detectCloudStorage('/home/someone/code', { platform: 'linux', homedir: '/home/someone', env: {}, read: noDropbox }), null);
});

test('excludeDirectoryFromCloudSync writes each marker once and leaves existing ones alone', async () => {
  const tools = fakeTools();
  assert.equal(await excludeDirectoryFromCloudSync('/r/node_modules', ['file-provider', 'dropbox-xattr'], { run: tools.run }), true);
  assert.equal(tools.marked(FILE_PROVIDER_IGNORE_XATTR, '/r/node_modules'), '1');
  assert.equal(tools.marked(DROPBOX_IGNORE_XATTR, '/r/node_modules'), '1');
  const writes = tools.calls.filter((call) => call[1] === '-w').length;
  assert.equal(await excludeDirectoryFromCloudSync('/r/node_modules', ['file-provider', 'dropbox-xattr'], { run: tools.run }), false);
  assert.equal(tools.calls.filter((call) => call[1] === '-w').length, writes);

  assert.equal(await excludeDirectoryFromCloudSync('/r/dist', ['dropbox-xattr-linux'], { run: tools.run }), true);
  assert.equal(tools.marked(DROPBOX_IGNORE_XATTR_LINUX, '/r/dist'), '1');
  assert.equal(await excludeDirectoryFromCloudSync("C:\\r\\it's\\dist", ['dropbox-stream'], { run: tools.run }), true);
  assert.equal(tools.marked(DROPBOX_IGNORE_STREAM, "C:\\r\\it's\\dist"), '1');
  assert.equal(await excludeDirectoryFromCloudSync("C:\\r\\it's\\dist", ['dropbox-stream'], { run: tools.run }), false);
});

test('the guard marks existing artifact trees, re-marks recreated ones, and ignores deleted ones', async () => {
  const root = await temporaryRepository();
  try {
    const tools = fakeTools({ domains: { [path.dirname(root)]: ICLOUD_DOMAIN } });
    const log = fakeLog();
    const guard = new CloudSyncGuard(root, { log, platform: 'darwin', homedir: '/nowhere', env: {}, run: tools.run, remarkDelayMs: 10 });
    assert.deepEqual(await guard.protectAll(), ['node_modules', 'packages/web/dist', 'packages/web/node_modules']);
    for (const relative of ['node_modules', 'packages/web/dist', 'packages/web/node_modules']) {
      assert.equal(tools.marked(FILE_PROVIDER_IGNORE_XATTR, path.join(root, relative)), '1', relative);
    }
    assert.equal(tools.marked(FILE_PROVIDER_IGNORE_XATTR, path.join(root, '.git', 'node_modules')), undefined);
    assert.equal(log.lines.info.length, 1);
    assert.match(log.lines.info[0], /^iCloud Drive: excluded node_modules, packages\/web\/dist, packages\/web\/node_modules/);

    // Nothing to do the second time — and no rewrite that would wake the watcher.
    assert.deepEqual(await guard.protectAll(), []);
    assert.equal(log.lines.info.length, 1);

    // `rm -rf node_modules && npm install`: the marker is gone with the tree.
    await rm(path.join(root, 'node_modules'), { recursive: true });
    tools.markers.delete(`${FILE_PROVIDER_IGNORE_XATTR}\0${path.join(root, 'node_modules')}`);
    await mkdir(path.join(root, 'node_modules', 'fresh'), { recursive: true });
    guard.noteChange('node_modules');
    guard.noteChange('node_modules/fresh/index.js');
    guard.noteChange('src/app.js');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(tools.marked(FILE_PROVIDER_IGNORE_XATTR, path.join(root, 'node_modules')), '1');
    assert.equal(log.lines.info.length, 2);

    // An event for a tree that no longer exists does not create anything.
    await rm(path.join(root, 'packages', 'web', 'dist'), { recursive: true });
    guard.noteChange('packages/web/dist/bundle.js');
    assert.deepEqual(await guard.flush(), []);

    // A symlinked artifact tree already lives elsewhere: leave it alone.
    await symlink(path.join(root, 'src'), path.join(root, 'packages', 'web', 'dist'));
    guard.noteChange('packages/web/dist/x');
    assert.deepEqual(await guard.flush(), []);
    guard.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the guard is silent outside cloud storage and warns once where no marker exists', async () => {
  const root = await temporaryRepository();
  try {
    const tools = fakeTools();
    const log = fakeLog();
    const local = new CloudSyncGuard(root, { log, platform: 'darwin', homedir: '/nowhere', env: {}, run: tools.run });
    assert.deepEqual(await local.protectAll(), []);
    local.noteChange('node_modules/pkg/index.js');
    assert.deepEqual(await local.flush(), []);
    assert.equal(tools.calls.filter((call) => call[1] === '-w').length, 0);
    assert.deepEqual(log.lines.warn, []);

    const oneDrive = new CloudSyncGuard(root, {
      log, platform: 'win32', homedir: '/nowhere', env: { OneDrive: path.dirname(root) }, run: tools.run,
      read: async () => { throw new Error('ENOENT'); },
    });
    assert.deepEqual(await oneDrive.protectAll(), []);
    assert.deepEqual(await oneDrive.protectAll(), []);
    assert.equal(log.lines.warn.length, 1);
    assert.match(log.lines.warn[0], /OneDrive has no per-folder exclusion/);
    assert.match(log.lines.warn[0], /node_modules/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a marker tool failure is reported once, not on every sweep', async () => {
  const root = await temporaryRepository();
  try {
    const log = fakeLog();
    const run = async (command, args) => {
      if (args[0] === '-p' && args[1] === FILE_PROVIDER_DOMAIN_XATTR) {
        return { stdout: `${path.dirname(root)}: ${ICLOUD_DOMAIN}\n` };
      }
      throw new Error('xattr: Operation not permitted');
    };
    const guard = new CloudSyncGuard(root, { log, platform: 'darwin', homedir: '/nowhere', env: {}, run });
    assert.deepEqual(await guard.protectAll(), []);
    assert.deepEqual(await guard.protectAll(), []);
    assert.equal(log.lines.warn.length, 3);
    assert.match(log.lines.warn[0], /Could not exclude node_modules from iCloud Drive sync: xattr: Operation not permitted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cloudSyncedRoots finds every synced folder on a Mac, managed or not', async () => {
  const home = '/Users/someone';
  const desktop = path.join(home, 'Desktop');
  const documents = path.join(home, 'Documents');
  const cloudStorage = path.join(home, 'Library', 'CloudStorage');
  const dropboxRoot = path.join(cloudStorage, 'Dropbox');
  const container = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  const tools = fakeTools({ domains: { [documents]: ICLOUD_DOMAIN, [dropboxRoot]: DROPBOX_DOMAIN } });
  const existing = new Set([desktop, documents, cloudStorage, dropboxRoot, container, path.join(home, 'OneDrive')]);
  const stat = async (file) => {
    if (!existing.has(file)) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; }
    return { isDirectory: () => true, isSymbolicLink: () => false };
  };
  const list = async (directory) => {
    assert.equal(directory, cloudStorage);
    return [{ name: 'Dropbox', isDirectory: () => true }, { name: 'notes.txt', isDirectory: () => false }];
  };
  const roots = await cloudSyncedRoots({ platform: 'darwin', homedir: home, env: {}, run: tools.run, read: async () => { throw new Error('ENOENT'); }, stat, list });
  assert.deepEqual(roots, [
    { provider: 'icloud', root: documents, markers: ['file-provider'] },
    { provider: 'dropbox', root: dropboxRoot, markers: ['file-provider', 'dropbox-xattr'] },
    { provider: 'icloud', root: container, markers: ['file-provider'] },
    { provider: 'onedrive', root: path.join(home, 'OneDrive'), markers: [] },
  ]);
  // Desktop exists but carries no File Provider domain: not synced, not listed.
  assert.ok(!roots.some((entry) => entry.root === desktop));
});

test('sweepCloudStorage excludes every tooling directory under a synced root, once', async () => {
  const root = await temporaryRepository();
  try {
    await mkdir(path.join(root, 'unmanaged-project', 'node_modules', 'left-pad'), { recursive: true });
    await mkdir(path.join(root, 'unmanaged-project', '.git', 'node_modules'), { recursive: true });
    const tools = fakeTools();
    const log = fakeLog();
    const roots = [{ provider: 'icloud', root, markers: ['file-provider'] }];
    const first = await sweepCloudStorage({ log, roots, run: tools.run });
    assert.equal(first.length, 1);
    assert.equal(first[0].found, 4);
    assert.deepEqual(first[0].marked, ['node_modules', 'packages/web/dist', 'packages/web/node_modules', 'unmanaged-project/node_modules']);
    assert.deepEqual(first[0].failed, []);
    assert.equal(tools.marked(FILE_PROVIDER_IGNORE_XATTR, path.join(root, 'unmanaged-project', 'node_modules')), '1');
    assert.equal(tools.marked(FILE_PROVIDER_IGNORE_XATTR, path.join(root, 'unmanaged-project', '.git', 'node_modules')), undefined);
    assert.match(log.lines.info[0], /^iCloud Drive: excluded 4 tooling directories under /);
    const second = await sweepCloudStorage({ log, roots, run: tools.run });
    assert.deepEqual(second[0].marked, []);
    assert.equal(log.lines.info.length, 1);

    const warned = await sweepCloudStorage({ log, roots: [{ provider: 'onedrive', root, markers: [] }], run: tools.run });
    assert.deepEqual(warned[0].marked, []);
    assert.match(log.lines.warn.at(-1), /OneDrive has no per-folder exclusion, so 4 tooling directories under /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitPigeon's own .git/gitpigeon cache is a tooling artifact; the rest of .git is untouched", async () => {
  const root = await temporaryRepository();
  try {
    await mkdir(path.join(root, '.git', 'gitpigeon', 'chunks'), { recursive: true });
    await mkdir(path.join(root, 'packages', 'web', '.git', 'objects'), { recursive: true });
    assert.deepEqual(await findToolingDirectories(root), [
      '.git/gitpigeon', 'node_modules', 'packages/web/dist', 'packages/web/node_modules',
    ]);
    assert.equal(toolingDirectoryOf('.git/gitpigeon/chunks/abc'), '.git/gitpigeon');
    assert.equal(toolingDirectoryOf('.git/objects/ab/cdef'), null);
    assert.equal(toolingDirectoryOf('.git/index'), null);
    const tools = fakeTools({ domains: { [path.dirname(root)]: ICLOUD_DOMAIN } });
    const guard = new CloudSyncGuard(root, { log: fakeLog(), platform: 'darwin', homedir: '/nowhere', env: {}, run: tools.run });
    assert.ok((await guard.protectAll()).includes('.git/gitpigeon'));
    assert.equal(tools.marked(FILE_PROVIDER_IGNORE_XATTR, path.join(root, '.git', 'gitpigeon')), '1');
    assert.equal(tools.marked(FILE_PROVIDER_IGNORE_XATTR, path.join(root, '.git')), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
