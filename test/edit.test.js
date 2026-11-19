/**
 * edit.test.js — 手动调整（移动 / 拉伸 / 新建）的单元测试
 * 运行：node test/edit.test.js
 */

import assert from 'node:assert/strict';
import { atDateTime, dateKey, makeSlot, minutesBetween, startOfWeek } from '../src/model.js';
import { buildSlotInstances } from '../src/scheduler.js';
import {
  addTaskChunkOnDate,
  allocationsOnDate,
  createAllocation,
  findRescheduleTarget,
  grabOffsetMin,
  markDone,
  markMissed,
  minutesByDateForTask,
  moveAllocation,
  pointerToOffsetMin,
  removeTaskFromDate,
  resizeAllocation,
  resizeSlotEnd,
} from '../src/edit.js';

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
const TUE = dateKey(new Date(BASE.getTime() + 86400000));

const slot = makeSlot({ id: 's1', weekday: 1, start: '09:00', end: '12:00', name: '深度' });
const instances = buildSlotInstances([slot], BASE, 7);
const MON_INST = instances[0].id;

function mkAlloc(id, taskId, startHM, endHM, day = MON) {
  return {
    id,
    taskId,
    date: day,
    slotId: 's1',
    start: atDateTime(day, startHM).toISOString(),
    end: atDateTime(day, endHM).toISOString(),
    locked: false,
    source: 'auto',
  };
}

const dur = (a) => minutesBetween(new Date(a.start), new Date(a.end));

console.log('\n[1] 移动分片');

test('在原时段内换位置', () => {
  const allocations = [mkAlloc('a1', 't1', '09:00', '10:00')];
  const r = moveAllocation({
    allocations,
    instances,
    allocId: 'a1',
    targetInstId: MON_INST,
    offsetMin: 60, // 10:00 起
  });
  assert.ok(r.ok, r.error);
  const a = r.allocations[0];
  assert.equal(new Date(a.start).getHours(), 10);
  assert.equal(dur(a), 60, '时长不变');
  assert.equal(a.locked, true, '手动调整后自动锁定');
});

test('偏移超出容量时被夹紧到末尾', () => {
  const allocations = [mkAlloc('a1', 't1', '09:00', '10:00')];
  const r = moveAllocation({
    allocations,
    instances,
    allocId: 'a1',
    targetInstId: MON_INST,
    offsetMin: 999,
  });
  assert.ok(r.ok, r.error);
  const a = r.allocations[0];
  assert.equal(new Date(a.end).getHours(), 12, '贴到时段末尾');
});

test('负偏移被夹紧到 0', () => {
  const allocations = [mkAlloc('a1', 't1', '10:00', '11:00')];
  const r = moveAllocation({
    allocations,
    instances,
    allocId: 'a1',
    targetInstId: MON_INST,
    offsetMin: -120,
  });
  assert.ok(r.ok, r.error);
  assert.equal(new Date(r.allocations[0].start).getHours(), 9);
});

test('与已有分片重叠时拒绝', () => {
  const allocations = [
    mkAlloc('a1', 't1', '09:00', '10:00'),
    mkAlloc('a2', 't2', '10:00', '11:00'),
  ];
  const r = moveAllocation({
    allocations,
    instances,
    allocId: 'a1',
    targetInstId: MON_INST,
    offsetMin: 30, // 09:30-10:30，压到 a2
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /重叠/);
});

test('分片比时段还长时拒绝', () => {
  const allocations = [mkAlloc('a1', 't1', '09:00', '13:00')]; // 4h > 3h
  const r = moveAllocation({
    allocations,
    instances,
    allocId: 'a1',
    targetInstId: MON_INST,
    offsetMin: 0,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /容量/);
});

test('maxTasks 限制生效', () => {
  const capped = buildSlotInstances(
    [makeSlot({ id: 's2', weekday: 1, start: '09:00', end: '12:00', maxTasks: 1 })],
    BASE,
    7,
  );
  const allocations = [
    { id: 'a1', taskId: 't1', date: MON, slotId: 's2', start: atDateTime(MON, '09:00').toISOString(), end: atDateTime(MON, '09:30').toISOString(), locked: false, source: 'auto' },
    { id: 'a2', taskId: 't2', date: MON, slotId: 's2', start: atDateTime(MON, '10:00').toISOString(), end: atDateTime(MON, '10:30').toISOString(), locked: false, source: 'auto' },
  ];
  // 移到 10:30 起：与 a1 不重叠，只该被 maxTasks 拦住
  const r = moveAllocation({
    allocations,
    instances: capped,
    allocId: 'a2',
    targetInstId: capped[0].id,
    offsetMin: 90,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /最多容纳/);
});

console.log('\n[2] 拉伸分片');

test('延长到下一个分片之前', () => {
  const allocations = [
    mkAlloc('a1', 't1', '09:00', '10:00'),
    mkAlloc('a2', 't2', '10:30', '11:00'),
  ];
  const r = resizeAllocation({
    allocations,
    instances,
    allocId: 'a1',
    deltaMin: 120,
    minChunk: 15,
  });
  assert.ok(r.ok, r.error);
  assert.equal(dur(r.allocations[0]), 90, '只能延到 10:30');
});

test('不能超过容量上限', () => {
  const capped = buildSlotInstances(
    [makeSlot({ id: 's3', weekday: 1, start: '09:00', end: '12:00', capacityMin: 60 })],
    BASE,
    7,
  );
  const allocations = [
    { id: 'a1', taskId: 't1', date: MON, slotId: 's3', start: atDateTime(MON, '09:00').toISOString(), end: atDateTime(MON, '09:30').toISOString(), locked: false, source: 'auto' },
  ];
  const r = resizeAllocation({
    allocations,
    instances: capped,
    allocId: 'a1',
    deltaMin: 300,
    minChunk: 5,
  });
  assert.ok(r.ok, r.error);
  assert.equal(dur(r.allocations[0]), 60, '容量只有 60 分钟');
});

test('缩短不低于 minChunk', () => {
  const allocations = [mkAlloc('a1', 't1', '09:00', '10:00')];
  const r = resizeAllocation({
    allocations,
    instances,
    allocId: 'a1',
    deltaMin: -600,
    minChunk: 25,
  });
  assert.ok(r.ok, r.error);
  assert.equal(dur(r.allocations[0]), 25);
});

console.log('\n[3] 新建分片');

test('在空时段放入', () => {
  const r = createAllocation({
    allocations: [],
    instances,
    taskId: 't1',
    targetInstId: MON_INST,
    offsetMin: 0,
    minutes: 45,
  });
  assert.ok(r.ok, r.error);
  assert.equal(dur(r.allocations[0]), 45);
  assert.equal(new Date(r.allocations[0].start).getHours(), 9);
});

test('位置被占时自动往后找空档', () => {
  const allocations = [mkAlloc('a1', 't1', '09:00', '10:00')];
  const r = createAllocation({
    allocations,
    instances,
    taskId: 't2',
    targetInstId: MON_INST,
    offsetMin: 0,
    minutes: 30,
  });
  assert.ok(r.ok, r.error);
  const created = r.allocations.find((a) => a.taskId === 't2');
  assert.equal(new Date(created.start).getHours(), 10, '应跳到 10:00');
});

test('时段塞满后拒绝', () => {
  const allocations = [mkAlloc('a1', 't1', '09:00', '12:00')];
  const r = createAllocation({
    allocations,
    instances,
    taskId: 't2',
    targetInstId: MON_INST,
    offsetMin: 0,
    minutes: 30,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /空闲/);
});

test('跨天时段实例不同', () => {
  const tue = buildSlotInstances([makeSlot({ id: 's4', weekday: 2, start: '09:00', end: '12:00' })], BASE, 7);
  assert.equal(tue[0].dateKey, TUE);
});

console.log('\n[4] 时段边界调整');

test('拖时段底边按 5 分钟吸附', () => {
  const s = makeSlot({ start: '09:00', end: '11:00' });
  assert.equal(resizeSlotEnd(s, 37), '11:35');
  assert.equal(resizeSlotEnd(s, -18), '10:40');
});

test('时段最短 15 分钟', () => {
  const s = makeSlot({ start: '09:00', end: '09:20' });
  assert.equal(resizeSlotEnd(s, -600, { minDuration: 15 }), '09:15');
});

test('不能跨过午夜', () => {
  const s = makeSlot({ start: '23:00', end: '23:40' });
  assert.equal(resizeSlotEnd(s, 600), '23:55', '应被夹在 24:00 内');
});

console.log('\n[5] 指针位置换算（跨视图比例）');

// 周视图：60 分钟 = 48px（0.8px/min）；日视图：60 分钟 = 66px（1.1px/min）
const VIEWS = [
  { name: '周视图', heightFor60: 48 },
  { name: '日视图', heightFor60: 66 },
];

for (const v of VIEWS) {
  test(`${v.name}：指针下移 1 小时 = 偏移 60 分钟`, () => {
    const areaHeight = v.heightFor60 * 3; // 3 小时时段
    const offset = pointerToOffsetMin({
      pointerY: 200 + v.heightFor60, // 从顶部往下 60 分钟
      areaTop: 200,
      areaHeight,
      slotDurationMin: 180,
    });
    assert.equal(Math.round(offset), 60);
  });
}

test('抓住分片中间拖动时保持手感（不跳到指针处）', () => {
  const areaHeight = 48 * 3;
  // 分片顶部在 200+48（即第 60 分钟），指针按在分片内第 15 分钟处
  const grabMin = grabOffsetMin({
    pointerY: 200 + 48 + 12,
    allocTop: 200 + 48,
    areaHeight,
    slotDurationMin: 180,
  });
  assert.equal(Math.round(grabMin), 15);

  // 指针移到第 120 分钟的位置，落点应是 120 - 15 = 105
  const offset = pointerToOffsetMin({
    pointerY: 200 + 96,
    areaTop: 200,
    areaHeight,
    slotDurationMin: 180,
    grabMin,
  });
  assert.equal(Math.round(offset), 105);
});

test('拖到时段上方时偏移被夹在 0', () => {
  const offset = pointerToOffsetMin({
    pointerY: 100,
    areaTop: 200,
    areaHeight: 144,
    slotDurationMin: 180,
  });
  assert.equal(offset, 0);
});

test('高度为 0 时安全返回 0（未布局的环境）', () => {
  assert.equal(
    pointerToOffsetMin({ pointerY: 300, areaTop: 0, areaHeight: 0, slotDurationMin: 120 }),
    0,
  );
  assert.equal(
    grabOffsetMin({ pointerY: 300, allocTop: 0, areaHeight: 0, slotDurationMin: 120 }),
    0,
  );
});

console.log('\n[6] 按时完成 / 没完成顺延');

const TASK = {
  id: 't1', title: '写论文', estMin: 300, minChunk: 15, maxChunk: 120,
  attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  constraints: { allowSlotIds: [], denySlotIds: [], weekdays: [] },
  parentId: null, order: 0,
};
const TASKS = [TASK];

function weekInstances() {
  return buildSlotInstances(
    [makeSlot({ id: 's1', weekday: 1, start: '09:00', end: '11:00', attrs: ['attr_deep'] }),
     makeSlot({ id: 's2', weekday: 3, start: '09:00', end: '11:00', attrs: ['attr_deep'] })],
    BASE,
    14,
  );
}

test('✅ 标记完成后变成 done，并自动锁定', () => {
  const allocations = [mkAlloc('a1', 't1', '09:00', '10:00')];
  const r = markDone({ allocations, allocId: 'a1' });
  assert.ok(r.ok);
  const a = r.allocations[0];
  assert.equal(a.status, 'done');
  assert.equal(a.locked, true, '完成的分片要冻结，避免被重排冲掉');
  assert.ok(a.doneAt);
});

test('标记完成不影响其它分片', () => {
  const allocations = [mkAlloc('a1', 't1', '09:00', '10:00'), mkAlloc('a2', 't2', '10:00', '11:00')];
  const r = markDone({ allocations, allocId: 'a1' });
  assert.equal(r.allocations[1].status, undefined);
  assert.equal(r.allocations[1].locked, false);
});

test('❌ 同一天后面还有空档时，就放在后面', () => {
  const allocations = [mkAlloc('a1', 't1', '09:00', '10:00')];
  const target = findRescheduleTarget({
    allocations,
    instances: weekInstances(),
    allocId: 'a1',
    tasks: TASKS,
    now: atDateTime(MON, '08:00'), // 还没到这块的时间
  });
  assert.ok(target, '应该能找到位置');
  assert.equal(target.date, MON, '同一天还有位置就用同一天');
  assert.equal(target.offsetMin, 60, '应落在 10:00 开始的空档');
});

test('❌ 不会把分片挪到已经过去的时间', () => {
  const allocations = [mkAlloc('a1', 't1', '09:00', '10:00')];
  // 现在是周一中午，上午的时段都过去了
  const target = findRescheduleTarget({
    allocations,
    instances: weekInstances(),
    allocId: 'a1',
    tasks: TASKS,
    now: atDateTime(MON, '12:00'),
  });
  assert.ok(target, '应该顺延到后面');
  assert.notEqual(target.date, MON, '不能留在已经过去的周一');
  assert.equal(target.date, dateKey(new Date(BASE.getTime() + 2 * 86400000)), '应顺延到周三');
});

test('顺延后的位置不能和已有分片重叠', () => {
  // 周一 09-11 被 a2 占满（a1 除外），只能去周三
  const allocations = [
    mkAlloc('a1', 't1', '09:00', '10:00'),
    mkAlloc('a2', 't9', '10:00', '11:00'),
  ];
  const target = findRescheduleTarget({
    allocations, instances: weekInstances(), allocId: 'a1', tasks: TASKS,
    now: atDateTime(MON, '08:00'),
  });
  assert.ok(target);
  assert.equal(target.date, dateKey(new Date(BASE.getTime() + 2 * 86400000)), '应顺延到周三');
});

test('属性不匹配的时段不会被选为落点', () => {
  const instances = buildSlotInstances(
    [makeSlot({ id: 's3', weekday: 2, start: '09:00', end: '11:00', attrs: ['attr_study'] })],
    BASE, 7,
  );
  const target = findRescheduleTarget({
    allocations: [mkAlloc('a1', 't1', '09:00', '10:00')], instances, allocId: 'a1', tasks: TASKS,
  });
  assert.equal(target, null, '属性不符就不该有落点');
});

test('任务约束（只能排某时段）也会被尊重', () => {
  const constrained = [{ ...TASK, constraints: { allowSlotIds: ['s2'], denySlotIds: [], weekdays: [] } }];
  const target = findRescheduleTarget({
    allocations: [mkAlloc('a1', 't1', '09:00', '10:00')],
    instances: weekInstances(), allocId: 'a1', tasks: constrained,
  });
  assert.ok(target);
  assert.ok(target.instId.endsWith('#s2'), '只能落在被允许的时段');
});

test('找不到空档时返回 null', () => {
  const instances = buildSlotInstances(
    [makeSlot({ id: 's9', weekday: 1, start: '09:00', end: '10:00', attrs: ['attr_deep'] })],
    BASE, 7,
  );
  const target = findRescheduleTarget({
    allocations: [mkAlloc('a1', 't1', '09:00', '10:00')], instances, allocId: 'a1', tasks: TASKS,
  });
  assert.equal(target, null);
});

test('❌ 标记未完成会留下 missed 状态', () => {
  const r = markMissed({ allocations: [mkAlloc('a1', 't1', '09:00', '10:00')], allocId: 'a1' });
  assert.ok(r.ok);
  assert.equal(r.allocations[0].status, 'missed');
  assert.ok(r.allocations[0].missedAt);
});

console.log('\n[7] 按日期查看 / 修改任务排期');

const richTasks = [{
  id: 'T1', title: '微积分', estMin: 240, minChunk: 30, maxChunk: 120,
  attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  constraints: { allowSlotIds: [], denySlotIds: [], weekdays: [] },
  parentId: null, order: 0,
}];

test('能统计出任务每天的排程时长', () => {
  const allocations = [
    mkAlloc('a1', 'T1', '09:00', '10:00'),
    mkAlloc('a2', 'T1', '10:00', '11:00'),
    mkAlloc('a3', 'OTHER', '09:00', '12:00'),
  ];
  const map = minutesByDateForTask(allocations, 'T1');
  assert.equal(map.get(MON), 120, '同一天的两块应累加');
  assert.equal(map.size, 1, '别的任务不该算进来');
});

test('能查出某一天属于该任务的块', () => {
  const allocations = [mkAlloc('a1', 'T1', '09:00', '10:00'), mkAlloc('a2', 'T1', '10:00', '11:00')];
  assert.equal(allocationsOnDate(allocations, 'T1', MON).length, 2);
  assert.equal(allocationsOnDate(allocations, 'T1', '2026-01-01').length, 0);
});

test('取消某一天的安排只删那一天的', () => {
  const allocations = [
    mkAlloc('a1', 'T1', '09:00', '10:00'),
    mkAlloc('a2', 'T1', '10:00', '11:00', TUE),
    mkAlloc('a3', 'OTHER', '09:00', '10:00'),
  ];
  const r = removeTaskFromDate({ allocations, taskId: 'T1', date: MON });
  assert.ok(r.ok);
  assert.equal(r.removed, 1);
  assert.equal(r.allocations.length, 2);
  assert.ok(!r.allocations.some((a) => a.id === 'a1'));
  assert.ok(r.allocations.some((a) => a.id === 'a3'), '别的任务不受影响');
});

test('这一天没安排时取消会失败而不是报错', () => {
  const r = removeTaskFromDate({ allocations: [], taskId: 'T1', date: MON });
  assert.equal(r.ok, false);
});

test('能在指定日期加一块，自动找该日的空位', () => {
  const instances = buildSlotInstances(
    [makeSlot({ id: 's1', weekday: 1, start: '09:00', end: '12:00', attrs: ['attr_deep'] })],
    BASE, 7,
  );
  const r = addTaskChunkOnDate({
    allocations: [],
    instances,
    tasks: richTasks,
    taskId: 'T1',
    date: MON,
    minutes: 120,
  });
  assert.ok(r.ok, r.error);
  assert.equal(r.allocations.length, 1);
  assert.equal(dur(r.allocations[0]), 120);
});

test('当天时段已满时给出可读原因', () => {
  const instances = buildSlotInstances(
    [makeSlot({ id: 's1', weekday: 1, start: '09:00', end: '10:00', attrs: ['attr_deep'] })],
    BASE, 7,
  );
  const r = addTaskChunkOnDate({
    allocations: [mkAlloc('full', 'OTHER', '09:00', '10:00')],
    instances,
    tasks: richTasks,
    taskId: 'T1',
    date: MON,
    minutes: 60,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /满/);
});

test('当天没有匹配属性的时段时原因不同', () => {
  const instances = buildSlotInstances(
    [makeSlot({ id: 's1', weekday: 1, start: '09:00', end: '12:00', attrs: ['attr_study'] })],
    BASE, 7,
  );
  const r = addTaskChunkOnDate({
    allocations: [], instances, tasks: richTasks, taskId: 'T1', date: MON, minutes: 60,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /属性/);
});

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} / ${pass + fails.length}`);
if (fails.length) {
  for (const f of fails) console.log(`  · ${f.name}\n    ${f.err.stack.split('\n')[1]?.trim()}`);
  process.exit(1);
}
