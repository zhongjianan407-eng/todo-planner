/**
 * scheduler.test.js — 排程引擎与相关纯函数的单元测试
 * 运行：node test/scheduler.test.js
 */

import assert from 'node:assert/strict';
import {
  addDays,
  makeSlot,
  makeTask,
  startOfWeek,
  dateKey,
  atDateTime,
} from '../src/model.js';
import { buildSlotInstances, matchSlot, schedule, firstFreeWindow } from '../src/scheduler.js';
import { computeSlack, groupTasks, sortTasks, taskTotals } from '../src/sort.js';
import { pickTemplate, stepsFromTemplate } from '../src/decompose.js';

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

const ATTRS = [
  { id: 'attr_deep', name: '深度工作', color: '#6c5ce7' },
  { id: 'attr_study', name: '学习输入', color: '#0984e3' },
  { id: 'attr_life', name: '生活杂事', color: '#8e9aaf' },
];

// 固定时间基准：2026-11-16 那一周的周一
const BASE = startOfWeek(new Date(2026, 10, 18));
const NOW = new Date(2026, 10, 1, 8, 0, 0); // 远早于所有时段
const MON = dateKey(BASE);

function mkState({ tasks = [], slots = [], allocations = [] } = {}) {
  return {
    attributes: ATTRS,
    tasks,
    slots,
    allocations,
    settings: { horizonDays: 7, maxSteps: 5, llm: { baseUrl: '', apiKey: '', model: '' } },
  };
}

function deepSlot(overrides = {}) {
  return makeSlot({
    weekday: 1,
    start: '09:00',
    end: '12:00',
    name: '深度工作',
    attrs: ['attr_deep'],
    ...overrides,
  });
}

const dur = (a) => (new Date(a.end) - new Date(a.start)) / 60000;

/* ============ 1. 时段展开 ============ */

console.log('\n[1] 时段实例展开');

test('周一的模板只展开到周一', () => {
  const slots = [deepSlot()];
  const inst = buildSlotInstances(slots, BASE, 7);
  assert.equal(inst.length, 1);
  assert.equal(inst[0].dateKey, MON);
  assert.equal(inst[0].start.getHours(), 9);
  assert.equal(inst[0].end.getHours(), 12);
});

test('两个不同星期各自展开', () => {
  const slots = [deepSlot(), deepSlot({ weekday: 3, start: '14:00', end: '16:00' })];
  const inst = buildSlotInstances(slots, BASE, 7);
  assert.equal(inst.length, 2);
  assert.ok(inst[0].start < inst[1].start, '应按时间升序');
});

test('结束早于开始的非法时段被丢弃', () => {
  const inst = buildSlotInstances([deepSlot({ start: '12:00', end: '09:00' })], BASE, 7);
  assert.equal(inst.length, 0);
});

/* ============ 2. 属性匹配 ============ */

console.log('\n[2] 属性匹配语义');

const instDeep = { attrs: ['attr_deep'] };
const instStudy = { attrs: ['attr_study'] };

test('require 命中才算匹配', () => {
  const unit = { attrs: [{ attrId: 'attr_deep', strength: 'require' }] };
  assert.ok(matchSlot(instDeep, unit));
  assert.equal(matchSlot(instStudy, unit), null);
});

test('forbid 命中直接排除', () => {
  const unit = { attrs: [{ attrId: 'attr_study', strength: 'forbid' }] };
  assert.equal(matchSlot(instStudy, unit), null);
  assert.ok(matchSlot(instDeep, unit));
});

test('require 与 forbid 同时存在时 forbid 优先', () => {
  const unit = {
    attrs: [
      { attrId: 'attr_deep', strength: 'require' },
      { attrId: 'attr_study', strength: 'forbid' },
    ],
  };
  const instBoth = { attrs: ['attr_deep', 'attr_study'] };
  assert.equal(matchSlot(instBoth, unit), null);
});

test('prefer 只影响优先级不影响可行性', () => {
  const unit = {
    attrs: [
      { attrId: 'attr_deep', strength: 'require' },
      { attrId: 'attr_study', strength: 'prefer' },
    ],
  };
  assert.ok(matchSlot(instDeep, unit));
  assert.ok(matchSlot({ attrs: ['attr_deep', 'attr_study'] }, unit));
  assert.equal(matchSlot(instStudy, unit), null, '缺 require 时不匹配');
});

test('无属性的任务可以进任意时段', () => {
  assert.ok(matchSlot(instStudy, { attrs: [] }));
});

/* ============ 3. 基本排入 ============ */

console.log('\n[3] 基本排入');

test('短任务完整排入匹配时段', () => {
  const task = makeTask({
    title: '写摘要',
    estMin: 60,
    dueAt: addDays(BASE, 3).toISOString(),
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
    maxChunk: 120,
  });
  const st = mkState({ tasks: [task], slots: [deepSlot()] });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });

  assert.equal(r.unscheduled.length, 0);
  assert.equal(r.created.length, 1);
  assert.equal(dur(r.created[0]), 60);
  assert.equal(new Date(r.created[0].start).getHours(), 9);
});

test('无匹配时段的任务进入未排队列并给出原因', () => {
  const task = makeTask({
    title: '读书',
    estMin: 60,
    attrs: [{ attrId: 'attr_study', strength: 'require' }],
  });
  const st = mkState({ tasks: [task], slots: [deepSlot()] });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.equal(r.created.length, 0);
  assert.equal(r.unscheduled.length, 1);
  assert.equal(r.unscheduled[0].reason, 'no_matching_slot');
});

/* ============ 4. 长任务切块 ============ */

console.log('\n[4] 长任务自动切块');

test('120 分钟任务受 maxChunk=60 切成两段', () => {
  const task = makeTask({
    title: '写第二章',
    estMin: 120,
    maxChunk: 60,
    minChunk: 30,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  });
  const st = mkState({ tasks: [task], slots: [deepSlot()] });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });

  assert.equal(r.created.length, 2);
  assert.deepEqual(r.created.map(dur), [60, 60]);
  assert.ok(new Date(r.created[0].end) <= new Date(r.created[1].start), '两段不重叠');
});

test('跨多个时段连续填充直到排满', () => {
  const task = makeTask({
    title: '大任务',
    estMin: 300,
    maxChunk: 120,
    minChunk: 60,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  });
  const slots = [
    deepSlot({ weekday: 1, start: '09:00', end: '11:00' }), // 120
    deepSlot({ weekday: 2, start: '09:00', end: '11:00' }), // 120
    deepSlot({ weekday: 3, start: '09:00', end: '11:00' }), // 120
  ];
  const st = mkState({ tasks: [task], slots });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });

  const total = r.created.reduce((s, a) => s + dur(a), 0);
  assert.equal(total, 300, '应排满 300 分钟');
  assert.equal(r.unscheduled.length, 0);
});

test('剩余空隙小于 minChunk 时跳过该时段', () => {
  // 时段只有 20 分钟，任务 minChunk=30 → 排不进去
  const task = makeTask({
    title: '需要整块时间',
    estMin: 60,
    minChunk: 30,
    maxChunk: 60,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  });
  const st = mkState({
    tasks: [task],
    slots: [deepSlot({ start: '09:00', end: '09:20' })],
  });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.equal(r.created.length, 0);
  assert.equal(r.unscheduled[0].reason, 'no_capacity');
});

/* ============ 5. DDL 约束 ============ */

console.log('\n[5] DDL 约束与放宽');

test('排不进 DDL 时会放宽并产生 warning', () => {
  const due = atDateTime(MON, '09:30');
  const task = makeTask({
    title: '急事',
    estMin: 60,
    dueAt: due.toISOString(),
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  });
  const st = mkState({ tasks: [task], slots: [deepSlot()] });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });

  assert.equal(r.created.length, 1, '最终仍然排入（放宽）');
  assert.ok(new Date(r.created[0].end) > due, '确实超出了 DDL');
  assert.ok(r.warnings.length >= 1, '应有 warning');
});

test('DDL 充裕时严格不超期', () => {
  const due = atDateTime(MON, '11:00');
  const task = makeTask({
    title: '正常任务',
    estMin: 60,
    dueAt: due.toISOString(),
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  });
  const st = mkState({ tasks: [task], slots: [deepSlot()] });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.equal(r.created.length, 1);
  assert.ok(new Date(r.created[0].end) <= due);
  assert.equal(r.warnings.length, 0);
});

test('紧急任务（slack 小）先占用时段', () => {
  const urgent = makeTask({
    title: '急',
    estMin: 120,
    dueAt: addDays(BASE, 1).toISOString(),
    priority: 1,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  });
  const relaxed = makeTask({
    title: '缓',
    estMin: 120,
    dueAt: addDays(BASE, 6).toISOString(),
    priority: 3,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  });
  const st = mkState({ tasks: [relaxed, urgent], slots: [deepSlot()] });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });

  const firstAlloc = r.created[0];
  assert.equal(firstAlloc.taskId, urgent.id, 'slack 更小的应先排');
  assert.equal(r.unscheduled.length, 1);
  assert.equal(r.unscheduled[0].taskId, relaxed.id);
});

/* ============ 6. 拆分步骤的顺序 ============ */

console.log('\n[6] 拆分步骤按序执行');

test('同一父任务的步骤按 order 先后占用时间', () => {
  const parent = makeTask({ title: '论文', estMin: 120, dueAt: addDays(BASE, 3).toISOString() });
  const s1 = makeTask({ title: '步骤1', estMin: 60, parentId: parent.id, order: 0, attrs: [{ attrId: 'attr_deep', strength: 'require' }] });
  const s2 = makeTask({ title: '步骤2', estMin: 60, parentId: parent.id, order: 1, attrs: [{ attrId: 'attr_deep', strength: 'require' }] });

  const st = mkState({ tasks: [parent, s1, s2], slots: [deepSlot()] });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });

  assert.equal(r.created.length, 2);
  const byStep = Object.fromEntries(r.created.map((a) => [a.taskId, a]));
  assert.ok(
    new Date(byStep[s1.id].end) <= new Date(byStep[s2.id].start),
    '步骤2 不得早于步骤1',
  );
});

test('父任务不再单独排程，只排叶子步骤', () => {
  const parent = makeTask({ title: '论文', estMin: 120 });
  const s1 = makeTask({ title: '步骤1', estMin: 60, parentId: parent.id, order: 0 });
  const st = mkState({ tasks: [parent, s1], slots: [deepSlot()] });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].taskId, s1.id);
});

/* ============ 7. 锁定与重排 ============ */

console.log('\n[7] 锁定项在重排中保留');

test('locked 分片保留，未锁定的重算', () => {
  const task = makeTask({
    title: '任务',
    estMin: 60,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  });
  const lockedAlloc = {
    id: 'locked1',
    taskId: task.id,
    date: MON,
    slotId: 'x',
    start: atDateTime(MON, '09:00').toISOString(),
    end: atDateTime(MON, '09:30').toISOString(),
    locked: true,
    source: 'manual',
  };
  const st = mkState({ tasks: [task], slots: [deepSlot()], allocations: [lockedAlloc] });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });

  const keptLocked = r.allocations.find((a) => a.id === 'locked1');
  assert.ok(keptLocked, '锁定项必须保留');

  const total = r.allocations.reduce((s, a) => s + dur(a), 0);
  assert.equal(total, 60, '含锁定项在内刚好 60 分钟，不重复排');
});

/* ============ 8. 排序与统计 ============ */

console.log('\n[8] 排序 / 分组 / slack');

test('slack = 距 DDL 分钟 − 未排工时', () => {
  const task = makeTask({ estMin: 60, dueAt: addDays(NOW, 1).toISOString() });
  const st = mkState({ tasks: [task] });
  const slack = computeSlack(task, st.tasks, [], NOW);
  assert.equal(slack, 24 * 60 - 60);
});

test('无 DDL 的 slack 为 null', () => {
  const task = makeTask({ estMin: 60 });
  assert.equal(computeSlack(task, [task], [], NOW), null);
});

test('按 slack 排序时紧急的在前、无 DDL 的垫底', () => {
  const a = makeTask({ title: 'A', estMin: 60, dueAt: addDays(NOW, 1).toISOString() });
  const b = makeTask({ title: 'B', estMin: 60, dueAt: addDays(NOW, 5).toISOString() });
  const c = makeTask({ title: 'C', estMin: 60, dueAt: null });
  const st = mkState({ tasks: [c, b, a] });
  const sorted = sortTasks([a, b, c], 'slack', { tasks: st.tasks, allocations: [], now: NOW });
  assert.deepEqual(sorted.map((t) => t.title), ['A', 'B', 'C']);
});

test('按属性分组时无属性任务归入未分类', () => {
  const a = makeTask({ title: 'A', attrs: [{ attrId: 'attr_deep', strength: 'require' }] });
  const b = makeTask({ title: 'B' });
  const st = mkState({ tasks: [a, b] });
  const groups = groupTasks([a, b], 'attr', { ...st, now: NOW });
  const names = groups.map((g) => g.key);
  assert.ok(names.includes('attr_deep'));
  assert.ok(names.includes('none'));
});

test('已排量会从剩余工时中扣除', () => {
  const task = makeTask({ id: 't1', estMin: 120 });
  const alloc = {
    id: 'a1', taskId: 't1', date: MON, slotId: 's1',
    start: atDateTime(MON, '09:00').toISOString(),
    end: atDateTime(MON, '09:45').toISOString(),
    locked: false, source: 'auto',
  };
  const totals = taskTotals(task, [task], [alloc]);
  assert.equal(totals.scheduled, 45);
  assert.equal(totals.remaining, 75);
});

/* ============ 9. 拆分规则 ============ */

console.log('\n[9] 拆分模板');

test('写作类任务命中写作模板', () => {
  const tpl = pickTemplate(makeTask({ title: '写毕业论文第二章' }));
  assert.equal(tpl.key, 'writing');
});

test('拆分出的步骤耗时之和接近原估时', () => {
  const task = makeTask({ title: '写报告', estMin: 200 });
  const steps = stepsFromTemplate(task, pickTemplate(task), 5);
  const sum = steps.reduce((s, x) => s + x.estMin, 0);
  assert.ok(Math.abs(sum - 200) <= 40, `实际合计 ${sum}，应接近 200`);
});

test('步骤继承父任务的 require 属性', () => {
  const task = makeTask({
    title: '写报告',
    estMin: 100,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  });
  const steps = stepsFromTemplate(task, pickTemplate(task), 5);
  for (const s of steps) {
    assert.ok(
      s.attrs.some((a) => a.attrId === 'attr_deep' && a.strength === 'require'),
      '每个步骤都应保留 require 属性',
    );
  }
});

test('步骤数不超过 maxSteps', () => {
  const task = makeTask({ title: '写开发文档', estMin: 300 });
  const steps = stepsFromTemplate(task, pickTemplate(task), 3);
  assert.ok(steps.length <= 3);
});

/* ============ 10. 空闲窗口 ============ */

console.log('\n[10] 空闲窗口计算');

test('已有占用时返回其后的空隙', () => {
  const inst = {
    start: atDateTime(MON, '09:00'),
    end: atDateTime(MON, '12:00'),
    attrs: [],
    id: 'i1',
  };
  const occ = [{ start: atDateTime(MON, '09:00'), end: atDateTime(MON, '10:00') }];
  const w = firstFreeWindow(inst, occ, inst.start);
  assert.equal(w.start.getHours(), 10);
  assert.equal(w.end.getHours(), 12);
});

test('时段排满时返回 null', () => {
  const inst = { start: atDateTime(MON, '09:00'), end: atDateTime(MON, '10:00'), attrs: [], id: 'i2' };
  const occ = [{ start: atDateTime(MON, '09:00'), end: atDateTime(MON, '10:00') }];
  assert.equal(firstFreeWindow(inst, occ, inst.start), null);
});

/* ============ 11. 任务侧时段约束 ============ */

console.log('\n[11] 任务侧时段约束');

const WED = dateKey(new Date(BASE.getTime() + 2 * 86400000));

function twoDaySlots() {
  return [
    makeSlot({ id: 's_mon', weekday: 1, start: '09:00', end: '11:00', name: '周一深度', attrs: ['attr_deep'] }),
    makeSlot({ id: 's_wed', weekday: 3, start: '09:00', end: '11:00', name: '周三深度', attrs: ['attr_deep'] }),
  ];
}

test('allowSlotIds 白名单：只能排进指定时段', () => {
  const task = makeTask({
    title: '只能周三做',
    estMin: 60,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
    constraints: { allowSlotIds: ['s_wed'], denySlotIds: [], weekdays: [] },
  });
  const st = mkState({ tasks: [task], slots: twoDaySlots() });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].date, WED, '应排在周三');
});

test('denySlotIds 黑名单：排除指定时段', () => {
  const task = makeTask({
    title: '别排周一',
    estMin: 60,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
    constraints: { allowSlotIds: [], denySlotIds: ['s_mon'], weekdays: [] },
  });
  const st = mkState({ tasks: [task], slots: twoDaySlots() });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.equal(r.created[0].date, WED);
});

test('weekdays 限定星期', () => {
  const task = makeTask({
    title: '只周三',
    estMin: 60,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
    constraints: { allowSlotIds: [], denySlotIds: [], weekdays: [3] },
  });
  const st = mkState({ tasks: [task], slots: twoDaySlots() });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.equal(r.created[0].date, WED);
  assert.equal(r.created.length, 1);
});

test('约束把所有候选时段挡掉时报 constraint_blocked', () => {
  const task = makeTask({
    title: '被自己锁死',
    estMin: 60,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
    constraints: { allowSlotIds: [], denySlotIds: ['s_mon', 's_wed'], weekdays: [] },
  });
  const st = mkState({ tasks: [task], slots: twoDaySlots() });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.equal(r.created.length, 0);
  assert.equal(r.unscheduled[0].reason, 'constraint_blocked');
});

test('子任务继承父任务的时段约束', () => {
  const parent = makeTask({
    title: '父任务',
    estMin: 60,
    constraints: { allowSlotIds: ['s_wed'], denySlotIds: [], weekdays: [] },
  });
  const step = makeTask({
    title: '步骤1',
    estMin: 60,
    parentId: parent.id,
    order: 0,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  });
  const st = mkState({ tasks: [parent, step], slots: twoDaySlots() });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].date, WED);
});

/* ============ 12. 时段容量与任务数上限 ============ */

console.log('\n[12] 时段容量与任务数上限');

test('capacityMin 限制单个时段可填充的总量', () => {
  const task = makeTask({
    title: '两小时任务',
    estMin: 120,
    maxChunk: 60,
    minChunk: 15,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  });
  const slots = [makeSlot({ id: 's_cap', weekday: 1, start: '09:00', end: '12:00', attrs: ['attr_deep'], capacityMin: 60 })];
  const st = mkState({ tasks: [task], slots });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  const total = r.created.reduce((s, a) => s + dur(a), 0);
  assert.equal(total, 60, '只能填满 60 分钟容量');
  assert.equal(r.unscheduled[0].reason, 'partial');
  assert.equal(r.unscheduled[0].remaining, 60);
});

test('maxTasks 限制单时段容纳的任务数', () => {
  const mk = (t) => makeTask({ title: t, estMin: 60, attrs: [{ attrId: 'attr_deep', strength: 'require' }] });
  const a = mk('A');
  const b = mk('B');
  const slots = [makeSlot({ id: 's_max', weekday: 1, start: '09:00', end: '12:00', attrs: ['attr_deep'], maxTasks: 1 })];
  const st = mkState({ tasks: [a, b], slots });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.equal(r.created.length, 1, '只放得下 1 个任务');
  assert.equal(r.unscheduled.length, 1);
});

test('capacityMin 对应的统计口径正确', () => {
  const slots = [makeSlot({ id: 's_cap2', weekday: 1, start: '09:00', end: '12:00', capacityMin: 90 })];
  const st = mkState({ tasks: [], slots });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.equal(r.stats.capacityMin, 90, '统计应使用容量上限而非时段全长');
});

/* ============ 13. 单次时段 ============ */

console.log('\n[13] 单次（仅某一天）时段');

test('once 时段只在指定日期展开一次', () => {
  const slots = [makeSlot({ id: 's_once', kind: 'once', date: WED, weekday: 1, start: '14:00', end: '16:00' })];
  const inst = buildSlotInstances(slots, BASE, 7);
  assert.equal(inst.length, 1);
  assert.equal(inst[0].dateKey, WED);
  assert.equal(inst[0].kind, 'once');
});

test('once 日期不在本周时不出现', () => {
  const slots = [makeSlot({ id: 's_once2', kind: 'once', date: '2020-01-01', weekday: 1, start: '14:00', end: '16:00' })];
  assert.equal(buildSlotInstances(slots, BASE, 7).length, 0);
});

/* ============ 14. 跨周排程 ============ */

console.log('\n[14] 跨周排程');

function mondaySlots() {
  return [makeSlot({ id: 's_mon', weekday: 1, start: '09:00', end: '11:00', name: '深度', attrs: ['attr_deep'] })];
}

function bigTask() {
  return makeTask({
    title: '十小时的大活',
    estMin: 600,
    minChunk: 60,
    maxChunk: 120,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  });
}

test('跨度 7 天：10 小时任务只排得下 2 小时', () => {
  const st = mkState({ tasks: [bigTask()], slots: mondaySlots() });
  st.settings.horizonDays = 7;
  const r = schedule({ state: st, weekStart: BASE, now: NOW });

  const total = r.created.reduce((s, a) => s + dur(a), 0);
  assert.equal(total, 120, '7 天里只有 1 个周一');
  assert.equal(r.unscheduled.length, 1);
  assert.equal(r.unscheduled[0].reason, 'partial');
});

test('跨度 35 天：同一个任务摊到 5 个周一，跨 4 周', () => {
  const st = mkState({ tasks: [bigTask()], slots: mondaySlots() });
  st.settings.horizonDays = 35;
  const r = schedule({ state: st, weekStart: BASE, now: NOW });

  const total = r.created.reduce((s, a) => s + dur(a), 0);
  assert.equal(total, 600, '35 天里有 5 个周一，刚好排满');
  assert.equal(r.unscheduled.length, 0);

  const dates = [...new Set(r.created.map((a) => a.date))].sort();
  assert.equal(dates.length, 5, '应分布在 5 个不同的日期');
  assert.equal(dates[0], MON, '第一段在本周一');
  assert.equal(dates[4], dateKey(addDays(BASE, 28)), '最后一段在第 5 个周一');
});

test('长任务每段都不超过 maxChunk', () => {
  const st = mkState({ tasks: [bigTask()], slots: mondaySlots() });
  st.settings.horizonDays = 35;
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  for (const a of r.created) {
    assert.ok(dur(a) <= 120, `单段 ${dur(a)} 分钟超过了 maxChunk`);
  }
});

test('统计里带上跨度边界', () => {
  const st = mkState({ tasks: [], slots: mondaySlots() });
  st.settings.horizonDays = 21;
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.equal(r.stats.days, 21);
  assert.equal(r.stats.horizonStart, MON);
  assert.equal(r.stats.horizonEnd, dateKey(addDays(BASE, 20)));
});

test('跨度之外的分片原样保留，不被重排清掉', () => {
  const outsideDate = dateKey(addDays(BASE, 40));
  const outside = {
    id: 'keep_me',
    taskId: 'someone',
    date: outsideDate,
    slotId: 's_mon',
    start: atDateTime(outsideDate, '09:00').toISOString(),
    end: atDateTime(outsideDate, '10:00').toISOString(),
    locked: false,
    source: 'auto',
  };
  const st = mkState({ tasks: [], slots: mondaySlots(), allocations: [outside] });
  st.settings.horizonDays = 7;
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.ok(r.allocations.some((a) => a.id === 'keep_me'), '跨度外的分片应保留');
});

test('跨度内没有时段的日子，残留分片也会被清掉', () => {
  const wed = dateKey(addDays(BASE, 2)); // 周三，测试里没有任何时段
  const orphan = {
    id: 'orphan',
    taskId: 'x',
    date: wed,
    slotId: 'gone',
    start: atDateTime(wed, '09:00').toISOString(),
    end: atDateTime(wed, '10:00').toISOString(),
    locked: false,
    source: 'auto',
  };
  const st = mkState({ tasks: [], slots: mondaySlots(), allocations: [orphan] });
  st.settings.horizonDays = 7;
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.ok(!r.allocations.some((a) => a.id === 'orphan'), '跨度内的残留应被清理');
});

test('跨度设为 0 或非法值时回落到 7 天', () => {
  const st = mkState({ tasks: [], slots: mondaySlots() });
  st.settings.horizonDays = 0;
  assert.equal(schedule({ state: st, weekStart: BASE, now: NOW }).stats.days, 7);
  st.settings.horizonDays = 'abc';
  assert.equal(schedule({ state: st, weekStart: BASE, now: NOW }).stats.days, 7);
});

test('跨度会自动延伸到最远的 DDL，不会被 7 天窗口卡住', () => {
  const due = addDays(BASE, 20); // 三周后到期
  const task = makeTask({
    title: '三周后交的论文',
    estMin: 360,
    minChunk: 60,
    maxChunk: 120,
    dueAt: due.toISOString(),
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  });
  const st = mkState({ tasks: [task], slots: mondaySlots() });
  st.settings.horizonDays = 7; // 用户设的跨度很短

  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.ok(r.stats.days >= 21, `跨度应自动延伸到至少 21 天，实际 ${r.stats.days}`);

  const total = r.created.reduce((s, a) => s + dur(a), 0);
  assert.equal(total, 360, '应完整排入 360 分钟');
  assert.equal(r.unscheduled.length, 0);

  const dates = [...new Set(r.created.map((a) => a.date))].sort();
  assert.ok(dates.length >= 3, `应跨至少 3 个周一，实际 ${dates.length}`);
});

test('没有 DDL 的任务不会把跨度撑大', () => {
  const task = makeTask({ title: '无期限', estMin: 60, attrs: [{ attrId: 'attr_deep', strength: 'require' }] });
  const st = mkState({ tasks: [task], slots: mondaySlots() });
  st.settings.horizonDays = 7;
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.equal(r.stats.days, 7);
});

test('DDL 再远也不会超过 180 天上限', () => {
  const task = makeTask({
    title: '两年后',
    estMin: 60,
    dueAt: addDays(BASE, 730).toISOString(),
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  });
  const st = mkState({ tasks: [task], slots: mondaySlots() });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.ok(r.stats.days <= 180, `跨度被夹在 180 天内，实际 ${r.stats.days}`);
});

/* ============ 15. 跨度内无可用时段 ============ */

console.log('\n[15] 跨度内没有可用时段时的原因');

test('所有时段都在过去时，原因报 empty_horizon 而不是「没有属性匹配的时段」', () => {
  const task = makeTask({
    title: '任意任务',
    estMin: 60,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
  });
  const st = mkState({ tasks: [task], slots: [deepSlot()] });
  st.settings.horizonDays = 7;
  // now 放到这一周之后：所有实例都被 "end > now" 过滤掉
  const future = addDays(BASE, 30);
  const r = schedule({ state: st, weekStart: BASE, now: future });

  assert.equal(r.created.length, 0);
  assert.equal(r.unscheduled.length, 1);
  assert.equal(r.unscheduled[0].reason, 'empty_horizon');
  assert.equal(r.stats.capacityMin, 0, '容量应为 0');
});

test('完全没配时段时也报 empty_horizon', () => {
  const task = makeTask({ title: '任务', estMin: 60, attrs: [{ attrId: 'attr_deep', strength: 'require' }] });
  const st = mkState({ tasks: [task], slots: [] });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.equal(r.unscheduled[0].reason, 'empty_horizon');
});

test('有可用时段但属性不匹配时，仍然报 no_matching_slot', () => {
  const task = makeTask({
    title: '要学习时段',
    estMin: 60,
    attrs: [{ attrId: 'attr_study', strength: 'require' }],
  });
  const st = mkState({ tasks: [task], slots: [deepSlot()] });
  const r = schedule({ state: st, weekStart: BASE, now: NOW });
  assert.equal(r.unscheduled[0].reason, 'no_matching_slot');
});

/* ============ 汇总 ============ */

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.log('\n失败详情：');
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.err.stack.split('\n')[1]?.trim()}`);
  process.exit(1);
}
