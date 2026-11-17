/**
 * focus.test.js — 专注计时逻辑的单元测试
 * 关键点：计时靠时间戳推算，不靠每秒递减，所以能任意「快进」测试。
 */

import assert from 'node:assert/strict';
import {
  actualMinutes,
  createSession,
  elapsedMs,
  finishSession,
  fmtClock,
  isFinished,
  pauseSession,
  progress,
  remainingMs,
  resetSession,
  resumeSession,
  setPlannedMinutes,
  startSession,
} from '../src/focus.js';

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

const T0 = 1_700_000_000_000;

console.log('\n[1] 时钟格式');

test('格式化 mm:ss', () => {
  assert.equal(fmtClock(0), '00:00');
  assert.equal(fmtClock(59_000), '00:59');
  assert.equal(fmtClock(60_000), '01:00');
  assert.equal(fmtClock(25 * 60_000), '25:00');
  assert.equal(fmtClock(90 * 60_000), '90:00');
});

test('向上取整，避免一开始就显示 24:59', () => {
  assert.equal(fmtClock(25 * 60_000 - 1), '25:00');
});

console.log('\n[2] 会话生命周期');

test('新建会话默认未开始', () => {
  const s = createSession({ taskId: 't1', plannedMin: 25, now: T0 });
  assert.equal(s.running, false);
  assert.equal(s.totalMs, 25 * 60_000);
  assert.equal(s.accumulatedMs, 0);
  assert.equal(elapsedMs(s, T0), 0);
});

test('开始后按真实时间推进', () => {
  const s = startSession(createSession({ taskId: 't1', plannedMin: 25, now: T0 }), T0);
  assert.equal(elapsedMs(s, T0 + 60_000), 60_000);
  assert.equal(remainingMs(s, T0 + 60_000), 24 * 60_000);
});

test('暂停后计时冻结', () => {
  const s0 = startSession(createSession({ taskId: 't1', plannedMin: 25, now: T0 }), T0);
  const s1 = pauseSession(s0, T0 + 5 * 60_000);
  assert.equal(s1.running, false);
  assert.equal(elapsedMs(s1, T0 + 99 * 60_000), 5 * 60_000, '暂停后不再增长');
});

test('继续后累计时长接着涨', () => {
  const s0 = startSession(createSession({ taskId: 't1', plannedMin: 25, now: T0 }), T0);
  const s1 = pauseSession(s0, T0 + 5 * 60_000);
  const s2 = resumeSession(s1, T0 + 60 * 60_000);
  assert.equal(elapsedMs(s2, T0 + 60 * 60_000 + 3 * 60_000), 8 * 60_000);
});

test('重置清零且停止', () => {
  const s = startSession(createSession({ taskId: 't1', plannedMin: 25, now: T0 }), T0);
  const r = resetSession(pauseSession(s, T0 + 5 * 60_000));
  assert.equal(r.accumulatedMs, 0);
  assert.equal(r.running, false);
  assert.equal(elapsedMs(r, T0 + 10 * 60_000), 0);
});

console.log('\n[3] 进度与完成判定');

test('进度按比例递增', () => {
  const s = startSession(createSession({ plannedMin: 10, now: T0 }), T0);
  assert.equal(progress(s, T0 + 5 * 60_000), 0.5);
  assert.equal(progress(s, T0 + 10 * 60_000), 1);
});

test('超时后剩余归零、进度封顶，但实际时长如实增长', () => {
  const s = startSession(createSession({ plannedMin: 10, now: T0 }), T0);
  assert.equal(remainingMs(s, T0 + 60 * 60_000), 0, '剩余不会为负');
  assert.equal(progress(s, T0 + 60 * 60_000), 1, '进度封顶 100%');
  assert.equal(elapsedMs(s, T0 + 60 * 60_000), 60 * 60_000, '实际时长如实记录');
});

test('到点判定', () => {
  const s = startSession(createSession({ plannedMin: 10, now: T0 }), T0);
  assert.equal(isFinished(s, T0 + 9 * 60_000), false);
  assert.equal(isFinished(s, T0 + 10 * 60_000), true);
});

console.log('\n[4] 调整目标时长');

test('可以中途改目标时长', () => {
  const s = createSession({ plannedMin: 25, now: T0 });
  const s2 = setPlannedMinutes(s, 50, T0);
  assert.equal(s2.plannedMin, 50);
  assert.equal(s2.totalMs, 50 * 60_000);
});

test('目标时长不能小于已专注的时长', () => {
  const s0 = startSession(createSession({ plannedMin: 25, now: T0 }), T0);
  const s1 = pauseSession(s0, T0 + 30 * 60_000);
  const s2 = setPlannedMinutes(s1, 5, T0 + 30 * 60_000);
  assert.equal(s2.plannedMin, 30, '应被抬到已完成的 30 分钟');
});

console.log('\n[5] 结束并产出记录');

test('结束时写入实际分钟数与状态', () => {
  const s0 = startSession(createSession({ taskId: 't1', allocId: 'a1', plannedMin: 40, now: T0 }), T0);
  const rec = finishSession(s0, 'completed', T0 + 25 * 60_000);
  assert.equal(rec.actualMin, 25);
  assert.equal(rec.status, 'completed');
  assert.equal(rec.running, false);
  assert.equal(rec.taskId, 't1');
  assert.equal(rec.allocId, 'a1');
});

test('提前中止也如实记录', () => {
  const s0 = startSession(createSession({ plannedMin: 40, now: T0 }), T0);
  const rec = finishSession(s0, 'stopped', T0 + 3 * 60_000);
  assert.equal(rec.status, 'stopped');
  assert.equal(actualMinutes(rec, T0 + 3 * 60_000), 3);
});

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} / ${pass + fails.length}`);
if (fails.length) {
  for (const f of fails) console.log(`  · ${f.name}\n    ${f.err.stack.split('\n')[1]?.trim()}`);
  process.exit(1);
}
