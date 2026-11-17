/**
 * writeback.test.js — 专注时长回写日程的单元测试
 */

import assert from 'node:assert/strict';
import { atDateTime, dateKey, makeSlot, minutesBetween, startOfWeek } from '../src/model.js';
import { buildSlotInstances } from '../src/scheduler.js';
import { applyFocusWriteBack, maxDuration, planMinutes, restorePlanned } from '../src/writeback.js';

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

const BASE = startOfWeek(new Date(2026, 10, 18));
const MON = dateKey(BASE);
const dur = (a) => minutesBetween(new Date(a.start), new Date(a.end));
const hm = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function setup(slotPatch = {}) {
  const slot = makeSlot({ id: 's1', weekday: 1, start: '09:00', end: '12:00', ...slotPatch });
  return { instances: buildSlotInstances([slot], BASE, 7) };
}

function alloc(startHM, endHM, id = 'a1') {
  return {
    id,
    taskId: 't1',
    date: MON,
    slotId: 's1',
    start: atDateTime(MON, startHM).toISOString(),
    end: atDateTime(MON, endHM).toISOString(),
    locked: false,
    source: 'auto',
  };
}

console.log('\n[1] 缩短：专注时间少于计划');

test('计划 60 分钟、实际 25 分钟 → 分片缩到 25', () => {
  const { instances } = setup();
  const allocations = [alloc('09:00', '10:00')];
  const r = applyFocusWriteBack({ allocations, instances, allocId: 'a1', actualMin: 25 });

  assert.ok(r.ok, r.reason);
  const a = r.allocations[0];
  assert.equal(dur(a), 25);
  assert.equal(hm(a.end), '09:25');
  assert.equal(a.actualMin, 25);
  assert.equal(a.plannedMin, 60, '要记住原计划时长');
  assert.equal(a.locked, true, '实际记录应被锁定，避免被重排冲掉');
  assert.equal(r.changed, true);
});

test('实际与计划一致时不改动时长', () => {
  const { instances } = setup();
  const allocations = [alloc('09:00', '10:00')];
  const r = applyFocusWriteBack({ allocations, instances, allocId: 'a1', actualMin: 60 });
  assert.ok(r.ok);
  assert.equal(r.changed, false);
  assert.equal(dur(r.allocations[0]), 60);
  assert.equal(r.allocations[0].actualMin, 60);
});

console.log('\n[2] 延长：专注时间超过计划');

test('后面没安排时可以延长', () => {
  const { instances } = setup();
  const allocations = [alloc('09:00', '10:00')];
  const r = applyFocusWriteBack({ allocations, instances, allocId: 'a1', actualMin: 90 });
  assert.ok(r.ok);
  assert.equal(dur(r.allocations[0]), 90);
  assert.equal(hm(r.allocations[0].end), '10:30');
  assert.equal(r.clamped, false);
});

test('后面有分片时延长被挡住', () => {
  const { instances } = setup();
  const allocations = [alloc('09:00', '10:00', 'a1'), alloc('10:15', '11:00', 'a2')];
  const r = applyFocusWriteBack({ allocations, instances, allocId: 'a1', actualMin: 90 });

  assert.ok(r.ok);
  assert.equal(dur(r.allocations[0]), 75, '只能延到 10:15');
  assert.equal(r.clamped, true);
  assert.equal(r.wanted, 90, '但要如实记录用户实际专注了 90 分钟');
  assert.equal(r.allocations[0].actualMin, 90);
});

test('时段容量上限会挡住延长', () => {
  const { instances } = setup({ capacityMin: 60 });
  const allocations = [alloc('09:00', '10:00')];
  const r = applyFocusWriteBack({ allocations, instances, allocId: 'a1', actualMin: 120 });
  assert.ok(r.ok);
  assert.equal(dur(r.allocations[0]), 60, '容量只有 60 分钟');
  assert.equal(r.clamped, true);
});

test('时段右侧边界会挡住延长', () => {
  const { instances } = setup({ capacityMin: null });
  // 时段 09:00-10:30，分片 09:00-10:00，最多只能延到 10:30
  const short = makeSlot({ id: 's1', weekday: 1, start: '09:00', end: '10:30' });
  const insts = buildSlotInstances([short], BASE, 7);
  const allocations = [alloc('09:00', '10:00')];
  const r = applyFocusWriteBack({ allocations, instances: insts, allocId: 'a1', actualMin: 120 });
  assert.equal(dur(r.allocations[0]), 90);
});

console.log('\n[3] 边界与异常');

test('实际时长为 0 时拒绝回写', () => {
  const { instances } = setup();
  const allocations = [alloc('09:00', '10:00')];
  const r = applyFocusWriteBack({ allocations, instances, allocId: 'a1', actualMin: 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不足/);
});

test('分片不存在时安全失败', () => {
  const r = applyFocusWriteBack({ allocations: [], instances: [], allocId: 'nope', actualMin: 10 });
  assert.equal(r.ok, false);
});

test('最短保留 5 分钟，不会算出零时长分片', () => {
  const { instances } = setup();
  const allocations = [alloc('09:00', '10:00')];
  const r = applyFocusWriteBack({ allocations, instances, allocId: 'a1', actualMin: 1 });
  assert.equal(dur(r.allocations[0]), 5);
  assert.equal(r.allocations[0].actualMin, 1, '记录仍然是真实的 1 分钟');
});

console.log('\n[4] 还原计划时长');

test('还原回原计划', () => {
  const { instances } = setup();
  const allocations = [alloc('09:00', '10:00')];
  const w = applyFocusWriteBack({ allocations, instances, allocId: 'a1', actualMin: 25 });
  const back = restorePlanned({ allocations: w.allocations, instances, allocId: 'a1' });

  assert.ok(back.ok, back.reason);
  assert.equal(dur(back.allocations[0]), 60);
  assert.equal(back.allocations[0].actualMin, undefined, '还原后不再显示实际时长');
  assert.equal(back.truncated, false);
});

test('没有回写记录时无法还原', () => {
  const { instances } = setup();
  const r = restorePlanned({ allocations: [alloc('09:00', '10:00')], instances, allocId: 'a1' });
  assert.equal(r.ok, false);
});

test('还原时若时段已被改短，按可用上限还原', () => {
  const { instances } = setup({ capacityMin: 40 });
  const allocations = [alloc('09:00', '10:00')];
  const w = applyFocusWriteBack({ allocations, instances, allocId: 'a1', actualMin: 20 });
  const back = restorePlanned({ allocations: w.allocations, instances, allocId: 'a1' });
  assert.equal(dur(back.allocations[0]), 40, '容量只剩 40 分钟');
  assert.equal(back.truncated, true);
});

console.log('\n[5] 辅助函数');

test('planMinutes 读计划时长', () => {
  assert.equal(planMinutes(alloc('09:00', '10:15')), 75);
});

test('maxDuration 考虑后一个分片', () => {
  const { instances } = setup();
  const allocations = [alloc('09:00', '10:00', 'a1'), alloc('10:40', '11:00', 'a2')];
  assert.equal(maxDuration(allocations[0], allocations, instances), 100);
});

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} / ${pass + fails.length}`);
if (fails.length) {
  for (const f of fails) console.log(`  · ${f.name}\n    ${f.err.stack.split('\n')[1]?.trim()}`);
  process.exit(1);
}
