/**
 * sync.test.js — 设备同步的纯逻辑测试
 *
 * 网络请求没法在这里测，但「哪些字段能上传、哪些必须留在本机」
 * 恰好是最容易出事、也最容易测的部分。
 */

import assert from 'node:assert/strict';
import {
  buildPayload,
  describeHttpError,
  loadSyncConfig,
  mergeRemote,
  saveSyncConfig,
  clearSyncConfig,
  stripForSync,
} from '../src/sync.js';

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

// 最小 localStorage 垫片
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const sampleState = () => ({
  version: 1,
  attributes: [{ id: 'a1', name: '深度工作', color: '#000' }],
  tasks: [{ id: 't1', title: '写论文', estMin: 60 }],
  slots: [],
  allocations: [],
  focusSessions: [],
  updatedAt: '2026-11-17T10:00:00.000Z',
  settings: {
    horizonDays: 14,
    maxSteps: 5,
    llm: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret-123', model: 'gpt-4o-mini' },
  },
});

console.log('\n[1] 上传内容整形');

test('上传前会把 LLM Key 抹掉', () => {
  const stripped = stripForSync(sampleState());
  assert.equal(stripped.settings.llm.apiKey, '');
  assert.equal(stripped.settings.llm.model, 'gpt-4o-mini', '其它字段要保留');
});

test('整形不会改动原始 state', () => {
  const original = sampleState();
  stripForSync(original);
  assert.equal(original.settings.llm.apiKey, 'sk-secret-123', '原对象的 Key 不能被清掉');
});

test('payload 结构正确且是合法 JSON', () => {
  const text = buildPayload(sampleState(), new Date('2026-11-17T12:00:00.000Z'));
  const payload = JSON.parse(text);
  assert.equal(payload.app, 'todo-planner');
  assert.equal(payload.version, 1);
  assert.equal(payload.updatedAt, '2026-11-17T12:00:00.000Z');
  assert.equal(payload.state.tasks.length, 1);
  assert.ok(!text.includes('sk-secret-123'), 'payload 里绝不能出现 Key');
});

console.log('\n[2] 拉取合并');

test('合并云端数据时保留本机 LLM Key', () => {
  const remote = sampleState();
  remote.settings.llm.apiKey = ''; // 云端一定是空的
  const local = sampleState();

  const merged = mergeRemote(remote, local);
  assert.equal(merged.settings.llm.apiKey, 'sk-secret-123', '应回填本机 Key');
  assert.equal(merged.settings.horizonDays, 14);
});

test('云端缺字段时补成空数组，避免界面炸掉', () => {
  const merged = mergeRemote({ settings: {} }, {});
  assert.deepEqual(merged.tasks, []);
  assert.deepEqual(merged.slots, []);
  assert.deepEqual(merged.allocations, []);
  assert.deepEqual(merged.attributes, []);
  assert.deepEqual(merged.focusSessions, []);
});

test('合并不改动入参', () => {
  const remote = sampleState();
  const merged = mergeRemote(remote, sampleState());
  merged.tasks.push({ id: 'x' });
  assert.equal(remote.tasks.length, 1, '远端对象不应被改动');
});

console.log('\n[3] 错误文案');

test('401 / 403 / 404 都有可读提示', () => {
  assert.match(describeHttpError(401), /Token/);
  assert.match(describeHttpError(403), /权限/);
  assert.match(describeHttpError(404, 'get'), /找不到/);
  assert.match(describeHttpError(500), /GitHub/);
});

console.log('\n[4] 本机凭证');

test('默认未连接', () => {
  const cfg = loadSyncConfig();
  assert.equal(cfg.token, '');
  assert.equal(cfg.gistId, '');
});

test('保存与读取', () => {
  saveSyncConfig({ token: 'tkn', gistId: 'g1' });
  const cfg = loadSyncConfig();
  assert.equal(cfg.token, 'tkn');
  assert.equal(cfg.gistId, 'g1');
});

test('断开后清空', () => {
  clearSyncConfig();
  const cfg = loadSyncConfig();
  assert.equal(cfg.token, '');
  assert.equal(cfg.gistId, '');
});

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} / ${pass + fails.length}`);
if (fails.length) {
  for (const f of fails) console.log(`  · ${f.name}\n    ${f.err.stack.split('\n')[1]?.trim()}`);
  process.exit(1);
}
