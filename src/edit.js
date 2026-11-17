/**
 * edit.js — 手动调整分配的纯函数
 *
 * 界面的拖拽/拉伸最终只调用这四个函数，它们负责：
 *   · 夹紧到时段边界与容量上限
 *   · 吸附到 5 分钟网格
 *   · 不与同槽已有分片重叠
 *   · 尊重单段时长上下限与时段容量
 *
 * 之所以独立成模块而不是写在事件回调里：这部分最容易出错，但脱离像素坐标就能单测。
 */

import { addMinutes, clamp, minutesBetween, snap, uid } from './model.js';

export const MAX_CHUNK_LIMIT = 24 * 60;

const slotKey = (a) => `${a.date}#${a.slotId}`;

function othersInSlot(allocations, instanceId, excludeId) {
  return allocations
    .filter((a) => slotKey(a) === instanceId && a.id !== excludeId)
    .map((a) => ({ start: new Date(a.start), end: new Date(a.end), taskId: a.taskId }))
    .sort((x, y) => x.start - y.start);
}

function distinctTasks(allocations, instanceId, excludeId) {
  return new Set(
    allocations.filter((a) => slotKey(a) === instanceId && a.id !== excludeId).map((a) => a.taskId),
  );
}

/**
 * 指针位置 → 相对时段开始的分钟偏移
 *
 * 关键：比例必须由「时段元素高度 ÷ 时段时长」现算，不能写死常量。
 * 周视图是 0.8px/分钟，日视图是 1.1px/分钟，未来加视图也不用改这里。
 *
 * @param {number} p.pointerY        指针的 clientY
 * @param {number} p.areaTop         时段时间区域的 rect.top
 * @param {number} p.areaHeight      时段时间区域的 rect.height
 * @param {number} p.slotDurationMin 该时段的实际时长（分钟）
 * @param {number} [p.grabMin]       抓住点位于分片内的第几分钟（保证拖拽手感）
 */
export function pointerToOffsetMin({
  pointerY,
  areaTop,
  areaHeight,
  slotDurationMin,
  grabMin = 0,
}) {
  if (!areaHeight || !slotDurationMin) return 0;
  const scale = areaHeight / slotDurationMin;
  const raw = (pointerY - areaTop) / scale;
  return Math.max(0, raw - grabMin);
}

/** 按下时记录「抓住的是分片内第几分钟」 */
export function grabOffsetMin({ pointerY, allocTop, areaHeight, slotDurationMin }) {
  if (!areaHeight || !slotDurationMin) return 0;
  const scale = areaHeight / slotDurationMin;
  return Math.max(0, (pointerY - allocTop) / scale);
}

/**
 * 把一个已有分片移动到目标时段的某个偏移位置（保持时长不变）
 * @param {object} p
 * @param {string} p.targetInstId  目标时段实例 id（`日期#slotId`）
 * @param {number} p.offsetMin     相对时段开始的分钟数
 * @param {boolean}[p.lock]        手动调整后是否钉住，默认 true
 */
export function moveAllocation({ allocations, instances, allocId, targetInstId, offsetMin, lock = true }) {
  const alloc = allocations.find((a) => a.id === allocId);
  if (!alloc) return { ok: false, error: '分片不存在' };

  const inst = instances.find((i) => i.id === targetInstId);
  if (!inst) return { ok: false, error: '目标时段不存在' };

  const duration = minutesBetween(new Date(alloc.start), new Date(alloc.end));
  const limit = inst.fillEnd ?? inst.end;
  const capacity = minutesBetween(inst.start, limit);

  if (duration > capacity) {
    return { ok: false, error: `目标时段容量 ${capacity} 分钟，放不下 ${duration} 分钟` };
  }

  const maxOffset = capacity - duration;
  const offset = clamp(snap(offsetMin), 0, maxOffset);
  const start = addMinutes(inst.start, offset);
  const end = addMinutes(start, duration);

  const others = othersInSlot(allocations, inst.id, allocId);
  const conflict = others.some(
    (o) => start.getTime() < o.end.getTime() && end.getTime() > o.start.getTime(),
  );
  if (conflict) return { ok: false, error: '与该时段已有内容重叠' };

  if (inst.maxTasks != null) {
    const set = distinctTasks(allocations, inst.id, allocId);
    set.add(alloc.taskId);
    if (set.size > inst.maxTasks) {
      return { ok: false, error: `该时段最多容纳 ${inst.maxTasks} 个任务` };
    }
  }

  const next = {
    ...alloc,
    date: inst.dateKey,
    slotId: inst.slotId,
    start: start.toISOString(),
    end: end.toISOString(),
    locked: lock,
    source: 'manual',
  };
  return { ok: true, allocations: allocations.map((a) => (a.id === allocId ? next : a)) };
}

/**
 * 调整分片时长（拖底边），deltaMin 为正延长、为负缩短
 */
export function resizeAllocation({
  allocations,
  instances,
  allocId,
  deltaMin,
  minChunk = 5,
  maxChunk = MAX_CHUNK_LIMIT,
  lock = true,
}) {
  const alloc = allocations.find((a) => a.id === allocId);
  if (!alloc) return { ok: false, error: '分片不存在' };

  const instKey = slotKey(alloc);
  const inst = instances.find((i) => i.id === instKey);
  const limit = inst ? inst.fillEnd ?? inst.end : new Date(alloc.end);

  const start = new Date(alloc.start);
  const curDuration = minutesBetween(start, limit);
  const duration = minutesBetween(start, new Date(alloc.end));

  // 下界：minChunk；上界：min(maxChunk, 到容量上限, 下一个分片的开始)
  let upper = Math.min(maxChunk, curDuration);
  const others = othersInSlot(allocations, instKey, allocId);
  for (const o of others) {
    if (o.start.getTime() >= start.getTime() && o.start.getTime() < limit.getTime()) {
      upper = Math.min(upper, minutesBetween(start, o.start));
    }
  }

  const wanted = clamp(snap(duration + deltaMin), Math.max(5, minChunk), Math.max(5, upper));
  if (wanted === duration) {
    return { ok: false, error: '已经到边界了' };
  }

  const next = {
    ...alloc,
    end: addMinutes(start, wanted).toISOString(),
    locked: lock,
    source: 'manual',
  };
  return { ok: true, allocations: allocations.map((a) => (a.id === allocId ? next : a)) };
}

/**
 * 在指定时段的指定偏移处新建一个手动分片
 */
export function createAllocation({
  allocations,
  instances,
  taskId,
  targetInstId,
  offsetMin = 0,
  minutes = 30,
  lock = true,
}) {
  const inst = instances.find((i) => i.id === targetInstId);
  if (!inst) return { ok: false, error: '目标时段不存在' };

  const limit = inst.fillEnd ?? inst.end;
  const capacity = minutesBetween(inst.start, limit);
  if (capacity <= 0) return { ok: false, error: '该时段没有可用容量' };

  if (inst.maxTasks != null) {
    const set = distinctTasks(allocations, inst.id, null);
    if (!set.has(taskId) && set.size >= inst.maxTasks) {
      return { ok: false, error: `该时段最多容纳 ${inst.maxTasks} 个任务` };
    }
  }

  const size = clamp(snap(minutes), 5, capacity);
  const maxOffset = capacity - size;
  let offset = clamp(snap(offsetMin), 0, Math.max(0, maxOffset));

  const others = othersInSlot(allocations, inst.id, null);

  // 从期望位置向后找第一个放得下的空档；找不到再从头找
  const fits = (o) => {
    const s = inst.start.getTime() + o * 60000;
    const e = s + size * 60000;
    if (e > limit.getTime()) return false;
    return !others.some((x) => s < x.end.getTime() && e > x.start.getTime());
  };

  let chosen = null;
  for (let o = offset; o <= maxOffset; o += 5) {
    if (fits(o)) {
      chosen = o;
      break;
    }
  }
  if (chosen === null) {
    for (let o = 0; o <= maxOffset; o += 5) {
      if (fits(o)) {
        chosen = o;
        break;
      }
    }
  }
  if (chosen === null) return { ok: false, error: '该时段没有足够连续空闲' };

  const start = addMinutes(inst.start, chosen);
  const alloc = {
    id: uid('alloc'),
    taskId,
    date: inst.dateKey,
    slotId: inst.slotId,
    start: start.toISOString(),
    end: addMinutes(start, size).toISOString(),
    locked: lock,
    source: 'manual',
  };
  return { ok: true, allocations: [...allocations, alloc], alloc };
}

/** 删除分片 */
export function deleteAllocation({ allocations, allocId }) {
  if (!allocations.some((a) => a.id === allocId)) return { ok: false, error: '分片不存在' };
  return { ok: true, allocations: allocations.filter((a) => a.id !== allocId) };
}

/** 切换锁定 */
export function toggleLock({ allocations, allocId }) {
  if (!allocations.some((a) => a.id === allocId)) return { ok: false, error: '分片不存在' };
  return {
    ok: true,
    allocations: allocations.map((a) => (a.id === allocId ? { ...a, locked: !a.locked } : a)),
  };
}

/** 调整时段模板的结束时间（拖时段底边），返回新的 end: 'HH:MM' */
export function resizeSlotEnd(slot, deltaMin, { minDuration = 15, step = 5 } = {}) {
  const toMin = (hm) => {
    const [h, m] = hm.split(':').map(Number);
    return h * 60 + m;
  };
  const fromMin = (v) => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;

  const startMin = toMin(slot.start);
  const endMin = toMin(slot.end);
  // 上限取 23:55：既保持在 5 分钟网格上，也避免生成 '24:00'（<input type="time"> 不接受）
  const wanted = Math.max(
    startMin + minDuration,
    Math.min(24 * 60 - step, snap(endMin + deltaMin, step)),
  );
  return fromMin(wanted);
}
