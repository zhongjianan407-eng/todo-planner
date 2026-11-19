/**
 * model.js — 领域模型与时间工具
 * 纯函数模块，浏览器与 Node 均可导入（用于单元测试）。
 */

export const WEEKDAYS = [
  { v: 1, label: '周一', short: '一' },
  { v: 2, label: '周二', short: '二' },
  { v: 3, label: '周三', short: '三' },
  { v: 4, label: '周四', short: '四' },
  { v: 5, label: '周五', short: '五' },
  { v: 6, label: '周六', short: '六' },
  { v: 7, label: '周日', short: '日' },
];

/** 属性强度：require=硬性要求，prefer=尽量满足，forbid=绝不能排到 */
export const STRENGTH = ['require', 'prefer', 'forbid'];
export const STRENGTH_LABEL = { require: '必须', prefer: '偏好', forbid: '排除' };

/** 属性可选颜色，改色时按这个顺序轮换 */
export const ATTR_PALETTE = [
  '#6c5ce7', '#00b894', '#e17055', '#0984e3',
  '#e1a100', '#8e9aaf', '#d63031', '#00cec9',
];

export const DEFAULT_ATTRIBUTES = [
  { id: 'attr_deep', name: '深度工作', color: '#6c5ce7' },
  { id: 'attr_light', name: '浅层事务', color: '#00b894' },
  { id: 'attr_meeting', name: '会议沟通', color: '#e17055' },
  { id: 'attr_study', name: '学习输入', color: '#0984e3' },
  { id: 'attr_body', name: '运动', color: '#e1a100' },
  { id: 'attr_life', name: '生活杂事', color: '#8e9aaf' },
];

export const PRIORITY_LABEL = { 3: '高', 2: '中', 1: '低' };

let seq = 0;
export function uid(prefix = 'id') {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ---------------- 时间工具（全部使用本地时区） ---------------- */

export function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 'HH:MM' -> {h, m} */
export function parseHM(hm) {
  const [h, m] = hm.split(':').map(Number);
  return { h: h || 0, m: m || 0 };
}

export function hmToMinutes(hm) {
  const { h, m } = parseHM(hm);
  return h * 60 + m;
}

export function minutesToHM(total) {
  const t = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** 由 'YYYY-MM-DD' + 'HH:MM' 生成本地 Date */
export function atDateTime(key, hm) {
  const d = parseDateKey(key);
  const { h, m } = parseHM(hm);
  d.setHours(h, m, 0, 0);
  return d;
}

export function addMinutes(d, min) {
  return new Date(d.getTime() + min * 60000);
}

export function minutesBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

export function fmtHM(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtTime(d) {
  return fmtHM(d);
}

export function fmtDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtDuration(min) {
  if (!min) return '0m';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h && m) return `${h}h${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** 周一为一周起点 */
export function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay(); // 0=Sun
  const diff = dow === 0 ? -6 : 1 - dow;
  x.setDate(x.getDate() + diff);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function isoWeekday(d) {
  const dow = d.getDay();
  return dow === 0 ? 7 : dow;
}

/* ---------------- 数值工具 ---------------- */

export const SNAP_MIN = 5;

/** 吸附到最近的 step 分钟（拖动时的粒度控制） */
export function snap(min, step = SNAP_MIN) {
  return Math.round(min / step) * step;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 时段的展示名，如「周一 09:00–11:30 深度工作」 */
export function slotLabel(slot) {
  if (!slot) return '';
  const day = slot.kind === 'once'
    ? `${slot.date ?? '某日'}`
    : WEEKDAYS.find((w) => w.v === Number(slot.weekday))?.label ?? '';
  return `${day} ${slot.start}–${slot.end} ${slot.name}`.trim();
}

/* ---------------- 实体构造 ---------------- */

/** 排程约束：任务侧对「能排进哪些时段」的限定 */
export function makeConstraints(patch = {}) {
  return {
    allowSlotIds: [], // 非空时为白名单：只能排进这些时段模板
    denySlotIds: [], // 黑名单：绝不排进
    weekdays: [], // 非空时限定星期（1-7）
    ...patch,
  };
}

export function makeTask(patch = {}) {
  const now = new Date();
  return {
    id: uid('task'),
    title: '未命名任务',
    note: '',
    status: 'todo', // todo | doing | done | dropped
    priority: 2,
    dueAt: null, // ISO 字符串
    estMin: 60,
    attrs: [], // [{ attrId, strength }]
    constraints: makeConstraints(),
    parentId: null,
    order: 0,
    minChunk: 25,
    maxChunk: 120,
    weeklyQuota: 0, // 每周最多排几块；0 = 不限（一次性排完为止）
    source: 'manual', // manual | ai
    createdAt: now.toISOString(),
    completedAt: null,
    ...patch,
  };
}

export function makeSlot(patch = {}) {
  return {
    id: uid('slot'),
    kind: 'weekly', // weekly=每周重复 | once=仅某一天
    weekday: 1,
    date: null, // kind==='once' 时生效，'YYYY-MM-DD'
    start: '09:00',
    end: '11:00',
    name: '新时段',
    attrs: [],
    capacityMin: null, // 可被占用的分钟上限，null=全部时长
    maxTasks: null, // 最多容纳几个任务，null=不限
    ...patch,
  };
}

export function makeAllocation(patch = {}) {
  return {
    id: uid('alloc'),
    taskId: null,
    date: null,
    slotId: null,
    start: null, // ISO
    end: null, // ISO
    locked: false,
    source: 'auto', // auto | manual
    ...patch,
  };
}

/* ---------------- 演示数据 ---------------- */

export function seedState() {
  const now = new Date();
  const due = (days, hm) => {
    const d = addDays(now, days);
    const [h, m] = hm.split(':').map(Number);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };

  const tasks = [
    makeTask({
      title: '写毕业论文第二章',
      note: '需要先整理访谈材料，再出初稿',
      priority: 3,
      dueAt: due(9, '23:59'),
      estMin: 300,
      attrs: [{ attrId: 'attr_deep', strength: 'require' }],
      minChunk: 45,
      maxChunk: 120,
    }),
    makeTask({
      title: '复习微积分第 5 章',
      priority: 2,
      dueAt: due(3, '18:00'),
      estMin: 150,
      attrs: [{ attrId: 'attr_study', strength: 'require' }],
      minChunk: 30,
      maxChunk: 90,
    }),
    makeTask({
      title: '预约体检',
      priority: 2,
      dueAt: due(2, '12:00'),
      estMin: 20,
      attrs: [{ attrId: 'attr_life', strength: 'require' }],
      minChunk: 15,
      maxChunk: 30,
    }),
    makeTask({
      title: '健身房力量训练',
      priority: 1,
      dueAt: due(4, '21:00'),
      estMin: 60,
      attrs: [{ attrId: 'attr_body', strength: 'prefer' }],
      minChunk: 30,
      maxChunk: 60,
    }),
    makeTask({
      title: '组会汇报准备',
      priority: 3,
      dueAt: due(5, '14:00'),
      estMin: 90,
      attrs: [{ attrId: 'attr_meeting', strength: 'require' }],
      minChunk: 30,
      maxChunk: 60,
    }),
  ];

  const slots = [
    makeSlot({ weekday: 1, start: '09:00', end: '11:30', name: '深度工作', attrs: ['attr_deep'] }),
    makeSlot({ weekday: 1, start: '14:00', end: '16:00', name: '学习输入', attrs: ['attr_study'] }),
    makeSlot({ weekday: 1, start: '19:00', end: '20:00', name: '运动', attrs: ['attr_body'] }),
    makeSlot({ weekday: 2, start: '09:00', end: '11:30', name: '深度工作', attrs: ['attr_deep'] }),
    makeSlot({ weekday: 2, start: '14:00', end: '15:30', name: '会议沟通', attrs: ['attr_meeting'] }),
    makeSlot({ weekday: 3, start: '09:00', end: '12:00', name: '深度工作', attrs: ['attr_deep'] }),
    makeSlot({ weekday: 3, start: '15:00', end: '17:00', name: '学习输入', attrs: ['attr_study'] }),
    makeSlot({ weekday: 4, start: '09:00', end: '11:00', name: '深度工作', attrs: ['attr_deep'] }),
    makeSlot({ weekday: 4, start: '16:00', end: '17:00', name: '浅层事务', attrs: ['attr_light', 'attr_life'] }),
    makeSlot({ weekday: 4, start: '19:00', end: '20:30', name: '运动', attrs: ['attr_body'] }),
    makeSlot({ weekday: 5, start: '09:00', end: '12:00', name: '深度工作', attrs: ['attr_deep'] }),
    makeSlot({ weekday: 5, start: '14:00', end: '16:00', name: '学习输入', attrs: ['attr_study'] }),
    makeSlot({ weekday: 6, start: '10:00', end: '12:00', name: '杂事处理', attrs: ['attr_life', 'attr_light'] }),
    makeSlot({ weekday: 7, start: '10:00', end: '12:00', name: '深度工作', attrs: ['attr_deep'] }),
  ];

  return {
    version: 1,
    attributes: DEFAULT_ATTRIBUTES.map((a) => ({ ...a })),
    tasks,
    slots,
    allocations: [],
    focusSessions: [],
    updatedAt: new Date().toISOString(),
    settings: {
      horizonDays: 14,
      maxSteps: 5,
      writeBack: true, // 专注结束后是否回写日程
      llm: { baseUrl: '', apiKey: '', model: '' },
    },
  };
}
