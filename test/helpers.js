import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GitRepository } from '../src/git.js';

export async function createRepository(directory, content = null) {
  await mkdir(directory, { recursive: true });
  const repo = await GitRepository.init(directory);
  await repo.git(['config', 'user.name', 'GitPigeon Tests']);
  await repo.git(['config', 'user.email', 'gitpigeon@example.test']);
  if (content !== null) await commitFile(repo, 'file.txt', content, 'initial');
  return repo;
}

export async function commitFile(repository, filename, content, message) {
  await writeFile(path.join(repository.root, filename), content);
  await repository.git(['add', '--', filename]);
  await repository.git(['commit', '-m', message]);
  return (await repository.git(['rev-parse', 'HEAD'])).stdout.trim();
}
