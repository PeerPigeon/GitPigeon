// Match artifacts excluded from both private and live workspace snapshots.
const GENERATED_DIRECTORIES = new Set([
  '.hg', '.svn', 'node_modules', 'vendor', '.venv', 'venv', 'dist', 'build',
  'out', 'target', 'coverage', '.cache', '__pycache__', '.next', '.nuxt',
  '.turbo', '.vinext', '.wrangler', '.gitpigeon-build',
]);

export function shouldScanRepository(filename) {
  const file = String(filename ?? '').replaceAll('\\', '/');
  if (!file || file === '.git') return true; // An unspecified event must not lose an edit.
  if (file.startsWith('.git/')) {
    // Object writes, remote imports, locks and our own caches are not local edits.
    // Keep branch switches, commits, tags and Git ignore/config changes observable.
    return /^(?:HEAD|packed-refs|config|info\/exclude|refs\/(?:heads|tags)(?:\/.*)?)$/.test(file.slice(5));
  }
  if (file.split('/').some((part) => GENERATED_DIRECTORIES.has(part))) return false;
  return !/(?:^|\/)(?:\.ds_store|thumbs\.db)$|\.(?:log|tmp|tsbuildinfo)$/i.test(file);
}
