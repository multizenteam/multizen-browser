import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepare } from './prepare.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sekvona-merge-')), repo = join(root, 'repo');
  mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git('init', '-b', 'main'); git('config','user.email','test@example.invalid'); git('config','user.name','Test');
  const write = (path, content) => writeFileSync(join(repo,path),content);
  mkdirSync(join(repo,'branding'));
  write('branding/upstream-policy.json', JSON.stringify({protected:['branding','custom.txt']}));
  write('shared.txt','base\n'); write('custom.txt','sync remains\n');
  git('add','.'); git('commit','-m','base'); git('branch','upstream');
  return { repo, git, write, destination: join(root,'review') };
}
test('prepares a real merge separately while preserving fork and current branch', t => {
  const f=fixture(t);
  f.git('checkout','upstream'); f.write('fix.txt','upstream improvement'); f.git('add','.'); f.git('commit','-m','fix');
  f.git('checkout','main'); f.write('brand.txt','Sekvona'); f.git('add','.'); f.git('commit','-m','fork');
  const before=f.git('rev-parse','HEAD');
  const result=prepare({...f,target:'upstream'});
  assert.equal(result.status,'prepared'); assert.equal(f.git('rev-parse','HEAD'),before);
  assert.equal(f.git('branch','--show-current'),'main'); assert.equal(f.git('status','--porcelain'),'');
  assert.equal(readFileSync(join(f.destination,'fix.txt'),'utf8'),'upstream improvement');
  assert.equal(readFileSync(join(f.destination,'custom.txt'),'utf8'),'sync remains\n');
  assert.equal(readFileSync(join(f.destination,'brand.txt'),'utf8'),'Sekvona');
});
test('blocks clean upstream deletion of custom functionality',t=>{
  const f=fixture(t); f.git('checkout','upstream'); f.git('rm','custom.txt'); f.git('commit','-m','remove'); f.git('checkout','main');
  assert.throws(()=>prepare({...f,target:'upstream'}),/Manual review required/);
  assert.equal(readFileSync(join(f.repo,'custom.txt'),'utf8'),'sync remains\n');
});
test('keeps merge conflicts isolated and never overwrites main',t=>{
  const f=fixture(t); f.git('checkout','upstream'); f.write('shared.txt','upstream\n'); f.git('commit','-am','upstream');
  f.git('checkout','main'); f.write('shared.txt','fork\n'); f.git('commit','-am','fork');
  assert.throws(()=>prepare({...f,target:'upstream'}),/Merge stopped/);
  assert.equal(readFileSync(join(f.repo,'shared.txt'),'utf8'),'fork\n');
  assert.equal(f.git('status','--porcelain'),'');
});
test('does nothing when upstream already merged',t=>{
  const f=fixture(t); assert.equal(prepare({...f,target:'upstream'}).status,'current');
});
test('refuses to start from uncommitted changes',t=>{
  const f=fixture(t); f.write('custom.txt','unsaved work');
  assert.throws(()=>prepare({...f,target:'upstream'}),/Commit or stash/);
});
