#!/usr/bin/env node
/**
 * stamp.mjs — 给静态资源地址注入版本号，绕开浏览器缓存
 *
 * 背景：GitHub Pages 给所有静态资源的响应头都是 `cache-control: max-age=600`，
 * 浏览器 10 分钟内不会重新请求。结果就是「代码明明部署了，用户却看到旧界面」，
 * 而且没有任何报错，极难排查。
 *
 * 做法：部署前把 index.html 的 css/js 地址、以及 src/*.js 之间的相对 import，
 * 全部加上 `?v=<本次提交短哈希>`。URL 变了，浏览器就必须重新拉取。
 *
 * 用法：node scripts/stamp.mjs <stamp> [根目录]
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stamp = process.argv[2];
const root = resolve(process.argv[3] ?? join(here, '..'));

if (!stamp) {
  console.error('用法: node scripts/stamp.mjs <stamp> [根目录]');
  process.exit(1);
}

let changed = 0;

/* ---------- 1. index.html：入口的 css / js ---------- */

const indexPath = join(root, 'index.html');
if (!existsSync(indexPath)) {
  console.error(`找不到 ${indexPath}`);
  process.exit(1);
}

let index = readFileSync(indexPath, 'utf8');
const before = index;

// 已经带过 ?v= 的先去掉，避免重复执行时越加越长
index = index.replace(/(\.\/(?:styles\.css|src\/app\.js))(?:\?v=[^"']*)?/g, `$1?v=${stamp}`);

if (index !== before) {
  writeFileSync(indexPath, index);
  changed += 1;
}

/* ---------- 2. src/*.js：模块之间的相对 import ---------- */

const srcDir = join(root, 'src');
if (existsSync(srcDir)) {
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith('.js')) continue;
    const path = join(srcDir, file);
    const code = readFileSync(path, 'utf8');
    const stamped = code.replace(
      /from '(\.\/[a-zA-Z]+\.js)(?:\?v=[^']*)?'/g,
      `from '$1?v=${stamp}'`,
    );
    if (stamped !== code) {
      writeFileSync(path, stamped);
      changed += 1;
    }
  }
}

/* ---------- 3. 自检：注入失败就让构建挂掉，别静默发旧版 ---------- */

const checkIndex = readFileSync(indexPath, 'utf8');
const checkApp = readFileSync(join(srcDir, 'app.js'), 'utf8');

if (!checkIndex.includes(`styles.css?v=${stamp}`)) {
  console.error('❌ index.html 的样式表没注入成功');
  process.exit(1);
}
if (!checkApp.includes(`model.js?v=${stamp}`)) {
  console.error('❌ 模块 import 没注入成功');
  process.exit(1);
}

console.log(`✓ 版本号 ${stamp} 已注入，共修改 ${changed} 个文件`);
