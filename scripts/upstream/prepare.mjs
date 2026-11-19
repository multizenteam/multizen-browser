import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export function prepare({ repo = process.cwd(), target = 'upstream/master', destination, branch }) {
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  if (git('status', '--porcelain')) throw new Error('Commit or stash local changes before preparing upstream.');
  const base = git('rev-parse', 'HEAD');
  const sha = git('rev-parse', '--verify', `${target}^{commit}`);
  try { git('merge-base', '--is-ancestor', sha, base); return { status: 'current', base, upstream: sha }; } catch {}
  if (!destination) throw new Error('An isolated worktree destination is required.');
  const name = branch ?? `feature/upstream-${sha.slice(0, 12)}`;
  git('worktree', 'add', '-b', name, destination, base);
  const work = (...args) => execFileSync('git', ['-C', destination, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try { work('merge', '--no-ff', '--no-commit', sha); }
  catch {
    const conflicts = work('diff', '--name-only', '--diff-filter=U');
    throw new Error(`Merge stopped in ${destination}. Main is unchanged. Resolve and review:\n${conflicts || 'See git status in the worktree.'}`);
  }
  // Never silently accept upstream edits to fork-owned functionality, even if Git
  // can merge them cleanly. Shared-file edits still require full regression tests.
  const policy = JSON.parse(readFileSync(resolve(repo, 'branding/upstream-policy.json'), 'utf8'));
  const changed = work('diff', '--name-only', base).split('\n');
  const protectedChanges = changed.filter(path => policy.protected.some(prefix => path === prefix || path.startsWith(`${prefix}/`)));
  if (protectedChanges.length) throw new Error(`Manual review required in ${destination}; fork-owned files changed:\n${protectedChanges.join('\n')}`);
  return { status: 'prepared', branch: name, directory: destination, base, upstream: sha };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = resolve(process.argv[2] ?? '../sekvona-upstream-review');
  const url = 'https://github.com/multizenteam/multizen-browser.git';
  execFileSync('git', ['fetch', '--no-tags', url, 'master:refs/remotes/upstream/master'], { stdio: 'inherit' });
  if (existsSync(destination)) throw new Error(`Review directory already exists: ${destination}`);
  console.log(JSON.stringify(prepare({ destination }), null, 2));
}
