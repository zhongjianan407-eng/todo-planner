/**
 * sort.js — 排序 / 分组 / 进度统计
 * 核心指标 slack（松弛时间）= 距 DDL 剩余时间 − 剩余未排工时
 * slack 越小越紧急，排序与排程共用同一函数，保证「看到的顺序」与「排的程度」一致。
 */

import { minutesBetween } from './model.js';

export function childrenOf(tasks, parentId) {
  return tasks
    .filter((t) => t.parentId === parentId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** 可排程的最小单元：没有子任务的任务 */
export function leafTasks(tasks) {
  const parents = new Set(tasks.filter((t) => t.parentId).map((t) => t.parentId));
  return tasks.filter((t) => t.parentId === null && !parents.has(t.id));
}

/** 某任务（含其子任务）已被排程的分钟数 */
export function scheduledMin(task, tasks, allocations) {
  const kids = childrenOf(tasks, task.id);
  if (kids.length === 0) {
    return allocations
      .filter((a) => a.taskId === task.id)
      .reduce((sum, a) => sum + minutesBetween(new Date(a.start), new Date(a.end)), 0);
  }
  return kids.reduce((sum, k) => sum + scheduledMin(k, tasks, allocations), 0);
}

export function taskTotals(task, tasks, allocations) {
  const kids = childrenOf(tasks, task.id);
  if (kids.length === 0) {
    const est = task.estMin || 0;
    const done = scheduledMin(task, tasks, allocations);
    return { est, scheduled: done, remaining: Math.max(0, est - done) };
  }
  return kids.reduce(
    (acc, k) => {
      const t = taskTotals(k, tasks, allocations);
      return {
        est: acc.est + t.est,
        scheduled: acc.scheduled + t.scheduled,
        remaining: acc.remaining + t.remaining,
      };
    },
    { est: 0, scheduled: 0, remaining: 0 },
  );
}

/** 已完成百分比（按排程量 / 按状态） */
export function progressOf(task, tasks, allocations) {
  if (task.status === 'done') return 100;
  const { est, scheduled } = taskTotals(task, tasks, allocations);
  if (!est) return 0;
  return Math.min(100, Math.round((scheduled / est) * 100));
}

/**
 * slack：距 DDL 的剩余分钟数 − 剩余未排工时
 * 返回 null 表示无 DDL（视为最不紧急）
 */
export function computeSlack(task, tasks, allocations, now = new Date()) {
  if (!task.dueAt) return null;
  const due = new Date(task.dueAt);
  const left = minutesBetween(now, due);
  const { remaining } = taskTotals(task, tasks, allocations);
  return left - remaining;
}

export function dueState(task, now = new Date()) {
  if (!task.dueAt) return 'none';
  const due = new Date(task.dueAt);
  if (due < now) return 'overdue';
  if (minutesBetween(now, due) < 24 * 60) return 'soon';
  return 'ok';
}

export const SORT_MODES = [
  { v: 'slack', label: '紧急度 (slack)' },
  { v: 'due', label: 'DDL 时间' },
  { v: 'priority', label: '优先级' },
  { v: 'est', label: '预计耗时' },
  { v: 'created', label: '创建时间' },
];

export const GROUP_MODES = [
  { v: 'none', label: '不分组' },
  { v: 'status', label: '按状态' },
  { v: 'attr', label: '按属性' },
  { v: 'due', label: '按 DDL 紧迫度' },
];

function cmpNullLast(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

export function sortTasks(list, mode, ctx) {
  const { tasks, allocations, now = new Date() } = ctx;
  const arr = [...list];
  if (mode === 'slack') {
    arr.sort((a, b) => {
      const sa = computeSlack(a, tasks, allocations, now);
      const sb = computeSlack(b, tasks, allocations, now);
      const c = cmpNullLast(sa, sb);
      return c !== 0 ? c : (b.priority ?? 0) - (a.priority ?? 0);
    });
  } else if (mode === 'due') {
    arr.sort((a, b) => {
      const da = a.dueAt ? new Date(a.dueAt).getTime() : null;
      const db = b.dueAt ? new Date(b.dueAt).getTime() : null;
      return cmpNullLast(da, db);
    });
  } else if (mode === 'priority') {
    arr.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  } else if (mode === 'est') {
    arr.sort((a, b) => (b.estMin ?? 0) - (a.estMin ?? 0));
  } else if (mode === 'created') {
    arr.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  return arr;
}

/**
 * 分组。按属性分组时，一个任务可能属于多个属性组
 * （require 优先归组；无 require 则用 prefer；都没有归入「未分类」）
 */
export function groupTasks(list, mode, ctx) {
  const { attributes, tasks, allocations, now = new Date() } = ctx;
  if (mode === 'none') return [{ key: 'all', label: '', color: null, tasks: list }];

  if (mode === 'status') {
    const meta = {
      todo: { label: '待办', color: '#636e72' },
      doing: { label: '进行中', color: '#0984e3' },
      done: { label: '已完成', color: '#00b894' },
      dropped: { label: '已放弃', color: '#b2bec3' },
    };
    return Object.entries(meta)
      .map(([key, m]) => ({
        key,
        label: `${m.label} (${list.filter((t) => t.status === key).length})`,
        color: m.color,
        tasks: list.filter((t) => t.status === key),
      }))
      .filter((g) => g.tasks.length > 0);
  }

  if (mode === 'due') {
    const buckets = [
      { key: 'overdue', label: '已逾期', color: '#d63031', test: (t) => dueState(t, now) === 'overdue' },
      { key: 'soon', label: '24 小时内', color: '#e17055', test: (t) => dueState(t, now) === 'soon' },
      { key: 'week', label: '7 天内', color: '#e1a100', test: (t) => t.dueAt && minutesBetween(now, new Date(t.dueAt)) <= 7 * 1440 },
      { key: 'later', label: '更晚', color: '#0984e3', test: (t) => !!t.dueAt },
      { key: 'none', label: '无 DDL', color: '#b2bec3', test: () => true },
    ];
    const used = new Set();
    return buckets
      .map((b) => {
        const matched = list.filter((t) => !used.has(t.id) && b.test(t));
        matched.forEach((t) => used.add(t.id));
        return { key: b.key, label: b.label, color: b.color, tasks: matched };
      })
      .filter((g) => g.tasks.length > 0);
  }

  // mode === 'attr'
  const groups = [];
  for (const attr of attributes) {
    const matched = list.filter((t) => {
      const tags = (t.attrs || []).filter((a) => a.attrId === attr.id);
      return tags.some((a) => a.strength === 'require') || tags.some((a) => a.strength === 'prefer');
    });
    if (matched.length) groups.push({ key: attr.id, label: attr.name, color: attr.color, tasks: matched });
  }
  const assigned = new Set(groups.flatMap((g) => g.tasks.map((t) => t.id)));
  const rest = list.filter((t) => !assigned.has(t.id));
  if (rest.length) groups.push({ key: 'none', label: '未分类', color: '#b2bec3', tasks: rest });
  return groups;
}
