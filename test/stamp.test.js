/**
 * stamp.test.js — 部署前的版本号注入脚本
 *
 * 这个脚本决定「用户刷新后能不能看到新版本」，出错的表现是
 * 「代码部署了但界面没变」，而且完全没有报错。所以必须测。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const script = join(root, 'scripts', 'stamp.mjs');

let pass = 0;
const fails = [];
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fails.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

/** 在临时目录里造一份副本，避免动到仓库本身 */
function withCopy(fn) {
  const dir = mkdtempSync(join(root, '.stamp-'));
  try {
    cpSync(join(root, 'index.html'), join(dir, 'index.html'));
    cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const run = (stamp, dir) =>
  execFileSync(process.execPath, [script, stamp, dir], { encoding: 'utf8' });

console.log('\n[1] 注入版本号');

test('index.html 的 css / js 都带上版本号', () => {
  withCopy((dir) => {
    run('abc1234', dir);
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    assert.match(html, /styles\.css\?v=abc1234/);
    assert.match(html, /src\/app\.js\?v=abc1234/);
  });
});

test('模块之间的相对 import 都带上版本号', () => {
  withCopy((dir) => {
    run('abc1234', dir);
    const app = readFileSync(join(dir, 'src', 'app.js'), 'utf8');
    assert.match(app, /from '\.\/model\.js\?v=abc1234'/);
    assert.match(app, /from '\.\/scheduler\.js\?v=abc1234'/);
    // 不能有漏网之鱼，否则那个模块还是会被缓存
    assert.doesNotMatch(app, /from '\.\/[a-zA-Z]+\.js'/);
  });
});

test('注入后仍然是合法 JS', () => {
  withCopy((dir) => {
    run('abc1234', dir);
    execFileSync(process.execPath, ['--check', join(dir, 'src', 'app.js')]);
  });
});

console.log('\n[2] 幂等与替换');

test('同版本号跑两次不会叠加', () => {
  withCopy((dir) => {
    run('abc1234', dir);
    run('abc1234', dir);
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    assert.equal((html.match(/\?v=/g) ?? []).length, 2, '应只有 css 和 js 各一处');
    assert.doesNotMatch(html, /\?v=abc1234\?v=/);
  });
});

test('换版本号会覆盖而不是追加', () => {
  withCopy((dir) => {
    run('abc1234', dir);
    run('cafe999', dir);
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    assert.match(html, /\?v=cafe999/);
    assert.doesNotMatch(html, /abc1234/);
  });
});

console.log('\n[3] 失败要吵');

test('不给版本号时直接报错退出', () => {
  withCopy((dir) => {
    assert.throws(
      () => execFileSync(process.execPath, [script, '', dir], { stdio: 'pipe' }),
      '缺少版本号时应当报错',
    );
  });
});

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} / ${pass + fails.length}`);
if (fails.length) {
  for (const f of fails) console.log(`  · ${f.name}\n    ${f.err.stack.split('\n')[1]?.trim()}`);
  process.exit(1);
}
