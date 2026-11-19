import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { collectRelease } from './collect-release.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'multizen-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, 'input'), output = join(root, 'output');
  for (const [platform, arch, extensions, feed] of [
    ['mac', 'arm64', ['zip', 'dmg'], 'latest-mac.yml'],
    ['mac', 'x64', ['zip', 'dmg'], 'latest-mac.yml'],
    ['win', 'x64', ['exe'], 'latest.yml'],
    ['linux', 'x64', ['AppImage'], 'latest-linux.yml'],
  ]) {
    const dir = join(input, `release-${platform}-${arch}`);
    mkdirSync(dir, { recursive: true });
    const files = extensions.map(ext => {
      const url = `Sekvona-${platform}-${arch}.${ext}`;
      const bytes = Buffer.from(url);
      writeFileSync(join(dir, url), bytes);
      return { url, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') };
    });
    writeFileSync(join(dir, feed), stringify({ version: '0.4.3', files }));
  }
  return { input, output };
}
test('combines both Mac architectures and verifies all update checksums', t => {
  const { input, output } = fixture(t);
  assert.deepEqual(collectRelease(input, output, '0.4.3'), { assets: 8, feeds: 3 });
  assert.deepEqual(readFileSync(join(output, 'MultiZen-mac-arm64.dmg')),
    readFileSync(join(output, 'Sekvona-mac-arm64.dmg')));
  const feed = parse(readFileSync(join(output, 'latest-mac.yml'), 'utf8'));
  assert.equal(feed.files.length, 4);
  assert.ok(feed.files.some(f => f.url.endsWith('arm64.zip')));
  assert.ok(feed.files.some(f => f.url.endsWith('x64.zip')));
  assert.equal(readFileSync(join(output, 'SHA256SUMS'), 'utf8').trim().split('\n').length, 8);
});
test('refuses a mismatched version', t => {
  const { input, output } = fixture(t);
  assert.throws(() => collectRelease(input, output, '0.4.4'), /Invalid version/);
});
test('refuses corrupted downloads', t => {
  const { input, output } = fixture(t);
  writeFileSync(join(input, 'release-mac-arm64/Sekvona-mac-arm64.zip'), 'corrupt');
  assert.throws(() => collectRelease(input, output, '0.4.3'), /checksum/);
});
test('refuses a missing architecture', t => {
  const { input, output } = fixture(t);
  rmSync(join(input, 'release-mac-x64'), { recursive: true });
  assert.throws(() => collectRelease(input, output, '0.4.3'), /Missing Mac x64/);
});
