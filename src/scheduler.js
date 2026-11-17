/**
 * scheduler.js — 排程引擎（纯函数，无 DOM / 无副作用）
 *
 * 问题定义：
 *   把「可排程单元」（叶子任务或拆分出的步骤）放进「时段实例」里，
 *   每个单元有：预计耗时、属性需求（require/prefer/forbid）、DDL、
 *              可切块粒度、以及「能/不能排进哪些时段」的约束。
 *   每个时段有：起止时间、提供的属性、可被填满的容量上限、可容纳任务数上限。
 *
 * 约束：
 *   硬 — 属性 require 必须被时段覆盖；forbid 属性不得出现；同一时段不重叠；
 *        单段时长 ≥ minChunk（收尾段例外）；单段 ≤ maxChunk；同父步骤按序执行；
 *        任务侧 allow/deny 时段与限定星期必须满足；时段容量与任务数上限不得超出
 *   软 — prefer 属性优先命中；slack 小的任务先排；尽量不晚于 DDL
 *
 * 算法：按 slack 升序的贪心 + 时段顺序装箱，两轮（严格守 DDL / 放宽 DDL）
 */

import {
  addDays,
  addMinutes,
  atDateTime,
  dateKey,
  isoWeekday,
  makeConstraints,
  minutesBetween,
  startOfWeek,
} from './model.js';
import { childrenOf } from './sort.js';

/* ---------------- 时段实例 ---------------- */

/**
 * 由时段模板展开成未来 N 天的具体时段
 * @returns {Array<{id,dateKey,slotId,weekday,name,attrs,start:Date,end:Date,fillEnd:Date,capacityMin,maxTasks,kind}>}
 */
export function buildSlotInstances(slots, weekStart, days = 7) {
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const day = addDays(weekStart, i);
    const key = dateKey(day);
    const wd = isoWeekday(day);
    for (const slot of slots) {
      const isOnce = slot.kind === 'once';
      if (isOnce) {
        if (slot.date !== key) continue;
      } else if (Number(slot.weekday) !== wd) {
        continue;
      }

      const start = atDateTime(key, slot.start);
      const end = atDateTime(key, slot.end);
      const duration = minutesBetween(start, end);
      if (duration <= 0) continue; // 非法/跨天时段跳过

      const capacityMin = Math.max(
        0,
        Math.min(duration, slot.capacityMin == null ? duration : Number(slot.capacityMin)),
      );

      out.push({
        id: `${key}#${slot.id}`,
        dateKey: key,
        slotId: slot.id,
        weekday: wd,
        name: slot.name,
        attrs: slot.attrs || [],
        start,
        end,
        fillEnd: addMinutes(start, capacityMin), // 容量上限对应的绝对时间
        capacityMin,
        maxTasks: slot.maxTasks == null ? null : Number(slot.maxTasks),
        kind: slot.kind ?? 'weekly',
      });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/* ---------------- 属性匹配 ---------------- */

/**
 * 时段是否满足单元属性要求
 * @returns {null | {preferHit:number}} null 表示不匹配
 */
export function matchSlot(instance, unit) {
  const attrs = unit.attrs || [];
  const req = attrs.filter((a) => a.strength === 'require').map((a) => a.attrId);
  const forb = attrs.filter((a) => a.strength === 'forbid').map((a) => a.attrId);
  const pref = attrs.filter((a) => a.strength === 'prefer').map((a) => a.attrId);

  const provided = instance.attrs || [];
  if (forb.some((id) => provided.includes(id))) return null;
  if (!req.every((id) => provided.includes(id))) return null;

  return { preferHit: pref.filter((id) => provided.includes(id)).length };
}

/* ---------------- 任务侧约束 ---------------- */

/**
 * 任务自定的「只能/不能排进哪些时段」
 * allowSlotIds 非空即白名单（必须命中其一），denySlotIds 永远排除
 * weekdays 非空时限定星期
 */
export function constrainSlot(unit, instance) {
  const c = unit.constraints || makeConstraints();
  const allow = c.allowSlotIds || [];
  const deny = c.denySlotIds || [];
  const wds = c.weekdays || [];

  if (deny.includes(instance.slotId)) return false;
  if (allow.length > 0 && !allow.includes(instance.slotId)) return false;
  if (wds.length > 0 && !wds.includes(instance.weekday)) return false;
  return true;
}

/** 子任务继承父任务的时段约束（父任务没设就用自己的） */
export function effectiveConstraints(unit, tasks) {
  if (!unit.parentId) return unit.constraints || makeConstraints();
  const parent = tasks.find((t) => t.id === unit.parentId);
  const mine = unit.constraints || makeConstraints();
  const theirs = parent?.constraints || makeConstraints();
  return {
    allowSlotIds: mine.allowSlotIds?.length ? mine.allowSlotIds : theirs.allowSlotIds ?? [],
    denySlotIds: [...new Set([...(mine.denySlotIds ?? []), ...(theirs.denySlotIds ?? [])])],
    weekdays: mine.weekdays?.length ? mine.weekdays : theirs.weekdays ?? [],
  };
}

/* ---------------- 占用与空闲窗口 ---------------- */

export function occupancyFor(instanceId, allocations) {
  return allocations
    .filter((a) => `${a.date}#${a.slotId}` === instanceId)
    .map((a) => ({ start: new Date(a.start), end: new Date(a.end) }))
    .sort((x, y) => x.start - y.start);
}

/** 在时段内找第一个长度 > 0 的空闲窗口，起点不早于 after，终点不超过容量上限 */
export function firstFreeWindow(instance, occ, after) {
  const limit = instance.fillEnd ?? instance.end;
  let cursor = new Date(Math.max(instance.start.getTime(), after.getTime()));
  if (cursor >= limit) return null;

  for (const o of occ) {
    if (o.end <= cursor) continue;
    if (o.start >= limit) break;
    if (o.start > cursor) {
      return { start: cursor, end: new Date(Math.min(o.start.getTime(), limit.getTime())) };
    }
    cursor = new Date(Math.max(cursor.getTime(), o.end.getTime()));
    if (cursor >= limit) return null;
  }
  return { start: cursor, end: limit };
}

/** 某时段实例已被占用的分钟数 */
export function usedMinutes(instanceId, allocations) {
  return occupancyFor(instanceId, allocations).reduce((s, o) => s + minutesBetween(o.start, o.end), 0);
}

/* ---------------- 可排程单元 ---------------- */

/**
 * 把任务树摊平成「执行组」：每组有统一的 DDL，组内按 order 顺序执行
 */
export function buildGroups(tasks) {
  const groups = [];
  for (const root of tasks) {
    if (root.parentId) continue;
    if (root.status === 'done' || root.status === 'dropped') continue;
    const kids = childrenOf(tasks, root.id);
    const units = kids.length > 0 ? kids : [root];
    groups.push({
      rootId: root.id,
      dueAt: root.dueAt ?? null,
      priority: root.priority ?? 2,
      title: root.title,
      units,
    });
  }
  return groups;
}

function scheduledMinutesOf(taskId, allocations) {
  return allocations
    .filter((a) => a.taskId === taskId)
    .reduce((sum, a) => sum + minutesBetween(new Date(a.start), new Date(a.end)), 0);
}

/* ---------------- 主排程 ---------------- */

/**
 * @param {object} opts
 * @param {object} opts.state        完整状态 {tasks, slots, allocations, settings}
 * @param {Date}   opts.weekStart    本周周一
 * @param {Date}   [opts.now]
 * @param {boolean}[opts.dryRun]     只计算不落库
 * @returns {{allocations, created, kept, removedIds, unscheduled, warnings, stats}}
 */
export function schedule({ state, weekStart = new Date(), now = new Date(), dryRun = false }) {
  const { tasks, slots } = state;
  // 排程跨度：允许跨周。1~180 天，防止误设成几年导致卡死
  const days = Math.max(1, Math.min(180, Number(state.settings?.horizonDays) || 7));
  const anchor = startOfWeek(weekStart);
  const instancesAll = buildSlotInstances(slots, anchor, days);
  const instances = instancesAll.filter((i) => i.end > now);

  // 清理范围按「日期」算，而不是按「有没有时段」算：
  // 否则跨度里没排时段的那些天，旧分片会残留下来
  const rangeKeys = new Set();
  for (let i = 0; i < days; i += 1) rangeKeys.add(dateKey(addDays(anchor, i)));
  const inRange = (a) => rangeKeys.has(a.date);

  const kept = (state.allocations || []).filter((a) => !inRange(a) || a.locked);
  const removedIds = (state.allocations || []).filter((a) => inRange(a) && !a.locked).map((a) => a.id);

  const created = [];
  const warnings = [];
  const working = [...kept];

  const groupSlack = (g) => {
    if (!g.dueAt) return Number.POSITIVE_INFINITY;
    const left = minutesBetween(now, new Date(g.dueAt));
    const remaining = g.units.reduce(
      (sum, u) => sum + Math.max(0, (u.estMin ?? 0) - scheduledMinutesOf(u.id, working)),
      0,
    );
    return left - remaining;
  };

  const groups = buildGroups(tasks).sort((a, b) => {
    const sa = groupSlack(a);
    const sb = groupSlack(b);
    if (sa !== sb) return sa - sb;
    return (b.priority ?? 0) - (a.priority ?? 0);
  });

  const unscheduledMap = new Map();

  for (const group of groups) {
    const due = group.dueAt ? new Date(group.dueAt) : null;
    let cursor = new Date(now);

    for (const unit of [...group.units].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      if (unit.status === 'done' || unit.status === 'dropped') continue;

      const already = scheduledMinutesOf(unit.id, working);
      let remaining = Math.max(0, (unit.estMin ?? 0) - already);
      if (remaining <= 0) continue;

      const minChunk = Math.max(5, unit.minChunk ?? 25);
      const maxChunk = Math.max(minChunk, unit.maxChunk ?? 120);
      const total = remaining;
      const constrained = { ...unit, constraints: effectiveConstraints(unit, tasks) };

      let placed = 0;
      let sawMatching = false; // 同时通过属性 + 任务约束的时段
      let sawAttrOnly = false; // 仅属性匹配（说明是被任务约束挡掉的）

      for (const pass of ['strict', 'lenient']) {
        if (remaining <= 0) break;
        for (const inst of instances) {
          if (remaining <= 0) break;
          if (!matchSlot(inst, unit)) continue;
          sawAttrOnly = true;
          if (!constrainSlot(constrained, inst)) continue;
          sawMatching = true;

          const occ = occupancyFor(inst.id, working);
          if (inst.maxTasks != null && occ.length >= inst.maxTasks) continue;
          if (usedMinutes(inst.id, working) >= inst.capacityMin) continue;

          const win = firstFreeWindow(inst, occ, cursor);
          if (!win) continue;

          const free = minutesBetween(win.start, win.end);
          if (free < Math.min(minChunk, remaining)) continue;

          // 单段时长同时受三件事约束：剩余量、时段空闲、用户设定的单块上限
          const chunk = Math.min(remaining, free, maxChunk);
          if (chunk < minChunk && remaining >= minChunk) continue;

          const end = addMinutes(win.start, chunk);
          if (pass === 'strict' && due && end > due) continue;

          const alloc = {
            id: `a_${inst.dateKey}_${unit.id}_${created.length}`,
            taskId: unit.id,
            date: inst.dateKey,
            slotId: inst.slotId,
            start: win.start.toISOString(),
            end: end.toISOString(),
            locked: false,
            source: 'auto',
          };
          created.push(alloc);
          working.push(alloc);
          cursor = end;
          remaining -= chunk;
          placed += chunk;
        }
      }

      if (remaining > 0) {
        let reason = 'no_capacity';
        // 整个跨度里没有任何"还没过去"的时段——这时说"没有属性匹配的时段"是误导
        if (instances.length === 0) reason = 'empty_horizon';
        else if (!sawMatching) reason = sawAttrOnly ? 'constraint_blocked' : 'no_matching_slot';
        else if (placed > 0) reason = 'partial';
        unscheduledMap.set(unit.id, {
          taskId: unit.id,
          parentId: group.rootId,
          title: unit.title,
          need: total,
          placed,
          remaining,
          reason,
          due: group.dueAt,
        });
      } else if (due) {
        const lastEnd = working
          .filter((a) => a.taskId === unit.id)
          .reduce((max, a) => Math.max(max, new Date(a.end).getTime()), 0);
        if (lastEnd > due.getTime()) {
          warnings.push(`「${unit.title}」排到了 DDL 之后（放宽约束）`);
        }
      }
    }
  }

  const unscheduled = [...unscheduledMap.values()];
  const lastDate = created.reduce((max, a) => (a.date > max ? a.date : max), '');
  const stats = {
    days,
    horizonStart: dateKey(anchor),
    horizonEnd: dateKey(addDays(anchor, days - 1)),
    lastPlannedDate: lastDate || null,
    totalUnits: groups.reduce((sum, g) => sum + g.units.length, 0),
    placedUnits: groups.reduce((sum, g) => sum + g.units.length, 0) - unscheduled.length,
    allocCount: created.length,
    capacityMin: instances.reduce((sum, i) => sum + i.capacityMin, 0),
    filledMin: created.reduce((s, a) => s + minutesBetween(new Date(a.start), new Date(a.end)), 0),
  };

  return {
    allocations: dryRun ? [...kept] : [...kept, ...created],
    created,
    kept,
    removedIds,
    unscheduled,
    warnings,
    stats,
  };
}
