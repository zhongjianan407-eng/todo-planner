/**
 * writeback.js — 把专注实际时长回写到日程分片
 *
 * 语义：
 *   分片原本的时长是「计划」，专注结束后的实际时长是「事实」。
 *   回写 = 把分片结束时间改成 实际开始 + 实际专注时长，让日程反映真相。
 *
 * 三个必须守住的边界：
 *   1. 不能超出时段的容量上限（fillEnd）
 *   2. 不能压到同一时段里排在后面的分片
 *   3. 第一次回写时把原计划时长存进 plannedMin，之后可以一键还原
 *
 * 纯函数，不碰 DOM，可直接单测。
 */

import { addMinutes, clamp, minutesBetween } from './model.js';

export function planMinutes(alloc) {
  return minutesBetween(new Date(alloc.start), new Date(alloc.end));
}

const slotKey = (a) => `${a.date}#${a.slotId}`;

/**
 * 从某个分片开始，最多还能延长多少分钟
 * 受「时段容量上限」和「后面的分片」双重限制
 */
export function maxDuration(alloc, allocations, instances) {
  const start = new Date(alloc.start);
  const inst = instances.find((i) => i.id === slotKey(alloc));

  let upper = 24 * 60;
  if (inst) {
    const limit = inst.fillEnd ?? inst.end;
    upper = Math.max(0, minutesBetween(start, limit));
  }

  for (const other of allocations) {
    if (other.id === alloc.id) continue;
    if (slotKey(other) !== slotKey(alloc)) continue;
    const os = new Date(other.start);
    if (os.getTime() >= start.getTime()) {
      upper = Math.min(upper, minutesBetween(start, os));
    }
  }
  return Math.max(0, upper);
}

/**
 * 回写实际专注时长
 * @returns {{ok:boolean, reason?:string, allocations?:Array, planned?:number,
 *            applied?:number, wanted?:number, clamped?:boolean, changed?:boolean}}
 */
export function applyFocusWriteBack({
  allocations,
  instances = [],
  allocId,
  actualMin,
  lock = true,
  minMinutes = 5,
}) {
  const alloc = allocations.find((a) => a.id === allocId);
  if (!alloc) return { ok: false, reason: '分片不存在，可能已被删除' };

  const planned = planMinutes(alloc);
  const wanted = Math.round(Number(actualMin) || 0);
  if (wanted < 1) return { ok: false, reason: '专注时长不足 1 分钟，不回写' };

  const upper = Math.max(minMinutes, maxDuration(alloc, allocations, instances));
  const applied = clamp(wanted, minMinutes, upper);
  const changed = applied !== planned;

  const next = {
    ...alloc,
    end: addMinutes(new Date(alloc.start), applied).toISOString(),
    actualMin: wanted, // 记录用户真实专注的分钟数（不受夹紧影响）
    plannedMin: alloc.plannedMin ?? planned,
    locked: lock ? true : alloc.locked,
    source: 'manual',
  };

  return {
    ok: true,
    allocations: allocations.map((a) => (a.id === allocId ? next : a)),
    planned,
    applied,
    wanted,
    clamped: applied !== wanted,
    changed,
  };
}

/**
 * 还原成计划时长（撤销回写）
 */
export function restorePlanned({ allocations, instances = [], allocId }) {
  const alloc = allocations.find((a) => a.id === allocId);
  if (!alloc) return { ok: false, reason: '分片不存在' };
  if (!alloc.plannedMin) return { ok: false, reason: '这个分片没有回写记录' };

  const upper = Math.max(5, maxDuration(alloc, allocations, instances));
  const target = clamp(alloc.plannedMin, 5, upper);
  const next = {
    ...alloc,
    end: addMinutes(new Date(alloc.start), target).toISOString(),
  };
  delete next.actualMin;
  // 还原后保留 plannedMin，方便再次对比
  return {
    ok: true,
    allocations: allocations.map((a) => (a.id === allocId ? next : a)),
    applied: target,
    truncated: target !== alloc.plannedMin,
  };
}
