/**
 * css.test.js — 布局契约检查（静态）
 *
 * jsdom 没有排版引擎，测不出真实宽度。这里退一步，把「手机端不横向溢出」
 * 依赖的几条关键规则钉死，防止以后被无意改回去。
 *
 * 这些问题都是在 iPhone 上真实踩过的：
 *   1. grid 子项默认 min-width:auto，被 7 列日程的 min-content 撑破整页
 *   2. .overlay 没写 grid-template-columns，隐式列按内容撑开，弹窗的
 *      max-width:100% 变成「相对自己」，等于没限制
 *   3. .field-row 两列的 input 有固有最小宽度，把弹窗撑出屏幕
 *   4. 顶栏不换行，右侧按钮被挤出可视区
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8');
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

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

/** 取某个选择器块的内容（只取第一段，足够做契约检查） */
function block(selector) {
  const idx = css.indexOf(`${selector} {`);
  assert.notEqual(idx, -1, `找不到规则 ${selector}`);
  const end = css.indexOf('}', idx);
  return css.slice(idx, end);
}

/** 取媒体查询块的内容 */
function media(query) {
  const idx = css.indexOf(`@media ${query}`);
  assert.notEqual(idx, -1, `找不到媒体查询 ${query}`);
  // 配平花括号
  let depth = 0;
  let i = css.indexOf('{', idx);
  const start = i;
  for (; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return css.slice(start, i + 1);
}

console.log('\n[1] 基础约束');

test('页面声明了 viewport，否则手机上会按 980px 缩放', () => {
  assert.match(html, /<meta[^>]+name="viewport"[^>]+width=device-width/);
});

test('.layout 使用 minmax(0, 1fr)，避免被 7 列日程撑破', () => {
  assert.match(block('.layout'), /minmax\(0,\s*1fr\)/);
});

test('1080 断点下单列也用 minmax(0, 1fr)', () => {
  assert.match(media('(max-width: 1080px)'), /minmax\(0,\s*1fr\)/);
  assert.doesNotMatch(media('(max-width: 1080px)'), /grid-template-columns:\s*1fr\s*;/);
});

test('网格子项允许收缩', () => {
  assert.match(css, /\.layout > \*\s*\{[^}]*min-width:\s*0/);
  assert.match(block('.panel'), /min-width:\s*0/);
});

console.log('\n[2] 弹窗宽度');

test('.overlay 显式声明 1fr 列（否则 max-width:100% 失效）', () => {
  assert.match(block('.overlay'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('.modal 宽度用 min() 夹在视口内', () => {
  assert.match(block('.modal'), /width:\s*min\(520px,\s*100%\)/);
  assert.match(block('.modal-sm'), /width:\s*min\(420px,\s*100%\)/);
});

test('表单行子项设置了 min-width:0', () => {
  assert.match(css, /\.field-row > \*[^{]*\{[^}]*min-width:\s*0/);
});

console.log('\n[3] 触摸拖拽');

test('可拖拽元素声明了 touch-action: none', () => {
  // 少了这条，手指一移动浏览器就拿去滚页面，pointermove 会被 pointercancel 打断
  const m = /touch-action:\s*none/g;
  assert.ok(m.test(css), '整份样式里没有 touch-action: none');
  for (const sel of ['.alloc', '.dv-alloc', '.alloc-rz', '.slot-rz']) {
    const idx = css.indexOf(`${sel},`);
    const idx2 = css.indexOf(`${sel} {`);
    assert.ok(idx !== -1 || idx2 !== -1, `${sel} 没有声明 touch-action`);
  }
});

console.log('\n[3] 手机断点');

test('存在 720px 断点', () => {
  assert.ok(css.includes('@media (max-width: 720px)'));
});

test('小屏上弹窗铺满、表单单列', () => {
  const m = media('(max-width: 720px)');
  assert.match(m, /\.modal[^{]*\{[^}]*width:\s*100%/);
  assert.match(m, /\.field-row\s*\{[^}]*grid-template-columns:\s*1fr\s*;/);
});

test('小屏上顶栏换行，按钮不会被挤出去', () => {
  const m = media('(max-width: 720px)');
  assert.match(m, /\.topbar\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(m, /\.topstats\s*\{[^}]*width:\s*100%/);
});

test('周视图在窄屏横向滚动而不是撑破页面', () => {
  const m = media('(max-width: 720px)');
  assert.match(m, /\.week-grid\s*\{[^}]*grid-template-columns/);
  assert.match(block('.week-grid'), /overflow-x:\s*auto/);
});

test('分片上的 ✓/✕ 按钮默认可见', () => {
  // 教训：opacity:0 一旦放在基础规则里，就全靠另一条更高优先级的规则去救，
  // 那条规则的类名对不上（或样式没更新）时按钮就整个消失，且没有任何报错。
  assert.doesNotMatch(block('.alloc-tools'), /opacity:\s*0/, '基础规则不能藏按钮');
  assert.match(block('.alloc .alloc-tools'), /opacity:\s*0/, '周视图才用 hover 隐藏');
  assert.match(block('.dv-alloc .alloc-tools'), /opacity:\s*1/, '日视图必须常显');
});

test('✓ / ✕ 平时就带语义色', () => {
  assert.match(block('.tool-btn.ok'), /color:\s*#0f9d58/);
  assert.match(block('.tool-btn.bad'), /color:\s*#d63031/);
});

test('样式表花括号配平', () => {
  assert.equal(
    (css.match(/\{/g) || []).length,
    (css.match(/\}/g) || []).length,
  );
});

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} / ${pass + fails.length}`);
if (fails.length) {
  for (const f of fails) console.log(`  · ${f.name}\n    ${f.err.stack.split('\n')[1]?.trim()}`);
  process.exit(1);
}
