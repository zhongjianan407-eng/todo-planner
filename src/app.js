/**
 * app.js — 界面与交互
 * 单文件渲染 + 事件委托，无框架依赖。
 */

import {
  WEEKDAYS,
  ATTR_PALETTE,
  PRIORITY_LABEL,
  STRENGTH_LABEL,
  addDays,
  atDateTime,
  dateKey,
  fmtDate,
  fmtDuration,
  fmtHM,
  isoWeekday,
  makeConstraints,
  makeSlot,
  makeTask,
  minutesBetween,
  minutesToHM,
  parseDateKey,
  slotLabel,
  startOfWeek,
  uid,
} from './model.js';
import { getState, update, resetToSeed, subscribe } from './store.js';
import {
  GROUP_MODES,
  SORT_MODES,
  childrenOf,
  computeSlack,
  dueState,
  groupTasks,
  progressOf,
  sortTasks,
  taskTotals,
} from './sort.js';
import { buildSlotInstances, schedule, usedMinutes } from './scheduler.js';
import {
  createAllocation,
  grabOffsetMin,
  moveAllocation,
  pointerToOffsetMin,
  resizeAllocation,
  resizeSlotEnd,
} from './edit.js';
import { decomposeTask } from './decompose.js';
import { applyFocusWriteBack, restorePlanned } from './writeback.js';
import { REPO_URL, SITE, SITE_TITLE } from './config.js';
import {
  clearSyncConfig,
  loadSyncConfig,
  mergeRemote,
  pullState,
  pushState,
  saveSyncConfig,
} from './sync.js';
import {
  createSession,
  finishSession,
  fmtClock,
  pauseSession,
  progress,
  remainingMs,
  resetSession,
  resumeSession,
  setPlannedMinutes,
  startSession,
} from './focus.js';

/** 时间轴比例：1 分钟 = 0.8px */
const PX_PER_MIN = 0.8;

/* ---------------- UI 状态（不持久化） ---------------- */

const ui = {
  weekStart: startOfWeek(new Date()),
  groupBy: 'none',
  sortBy: 'slack',
  query: '',
  filterAttrs: new Set(),
  showDone: false,
  expanded: new Set(),
  taskModal: null, // {mode:'create'|'edit', draft:{...}}
  slotModal: null,
  settingsOpen: false,
  attrsOpen: false,
  selectedAlloc: null,
  busy: false,
  toast: null,
  view: 'week', // 'day' | 'week' | 'month'
  dayDate: new Date(),
  monthDate: new Date(),
  focusOpen: false,
  syncMsg: '',
  syncBusy: false,
};

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' -> 'M/D'（本地时区，别用 new Date(key) 会按 UTC 解析） */
function fmtDateKey(key) {
  if (!key) return '';
  const d = parseDateKey(key);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 秒表图标：内联 SVG 而不是 emoji，跨平台尺寸和颜色都可控 */
function focusIcon(px = 14) {
  return `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none"
    stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">
    <circle cx="12" cy="13.5" r="7.5"/>
    <path d="M12 6V3.5"/>
    <path d="M9 3.5h6"/>
    <path d="M12 13.5V9.5"/>
    <path d="M12 13.5l2.8 1.8"/>
  </svg>`;
}

function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function attrById(state, id) {
  return state.attributes.find((a) => a.id === id);
}

function toast(msg, kind = 'info') {
  ui.toast = { msg, kind, t: Date.now() };
  render();
  setTimeout(() => {
    if (ui.toast && Date.now() - ui.toast.t >= 2400) {
      ui.toast = null;
      render();
    }
  }, 2600);
}

/* ---------------- 片段渲染 ---------------- */

function renderAttrChip(state, attrId, strength) {
  const a = attrById(state, attrId);
  if (!a) return '';
  const cls = strength ? `chip strength-${strength}` : 'chip';
  const label = strength ? STRENGTH_LABEL[strength] : '';
  return `<span class="${cls}" style="--c:${a.color}">${esc(a.name)}${
    label ? `<i>${label}</i>` : ''
  }</span>`;
}

function renderTaskCard(state, task, { isChild = false } = {}) {
  const kids = childrenOf(state.tasks, task.id);
  const totals = taskTotals(task, state.tasks, state.allocations);
  const slack = computeSlack(task, state.tasks, state.allocations);
  const ds = dueState(task);
  const pct = progressOf(task, state.tasks, state.allocations);
  const expanded = ui.expanded.has(task.id);
  const remaining = totals.remaining;

  const dueTxt = task.dueAt
    ? `${fmtDate(new Date(task.dueAt))} ${fmtHM(new Date(task.dueAt))}`
    : '无 DDL';

  const slackTxt =
    slack === null
      ? '—'
      : slack < 0
        ? `超期 ${fmtDuration(Math.abs(slack))}`
        : `余量 ${fmtDuration(slack)}`;

  const cons = task.constraints || makeConstraints();
  const consTxt = (() => {
    const parts = [];
    if (cons.allowSlotIds?.length) parts.push(`限 ${cons.allowSlotIds.length} 个时段`);
    if (cons.denySlotIds?.length) parts.push(`排除 ${cons.denySlotIds.length} 个`);
    if (cons.weekdays?.length) {
      parts.push(cons.weekdays.map((d) => WEEKDAYS.find((w) => w.v === d)?.short ?? '').join(''));
    }
    return parts.join(' · ');
  })();

  return `
  <div class="task ${isChild ? 'task-child' : ''} ${task.status === 'done' ? 'is-done' : ''}"
       draggable="true" data-task="${task.id}">
    <div class="task-row">
      <button class="tick" data-action="toggle-done" data-id="${task.id}"
        title="标记完成">${task.status === 'done' ? '✓' : ''}</button>
      <div class="task-body">
        <div class="task-title">
          ${kids.length ? `<button class="caret" data-action="toggle-expand" data-id="${task.id}">${expanded ? '▾' : '▸'}</button>` : ''}
          <span class="prio p${task.priority}">${PRIORITY_LABEL[task.priority] ?? '中'}</span>
          <span class="title-text">${esc(task.title)}</span>
          ${kids.length ? `<span class="tag-steps">${kids.length} 步</span>` : ''}
          ${consTxt ? `<span class="tag-cons" title="排程约束">⧗ ${esc(consTxt)}</span>` : ''}
        </div>
        <div class="task-meta">
          <span class="due ${ds}">${dueTxt}</span>
          <span class="est">${fmtDuration(totals.est)}</span>
          <span class="remain ${remaining > 0 ? 'warn' : 'ok'}">${
            remaining > 0 ? `未排 ${fmtDuration(remaining)}` : '已排满'
          }</span>
          <span class="slack">${slackTxt}</span>
          ${pct > 0 ? `<span class="pct">${pct}%</span>` : ''}
        </div>
        <div class="task-attrs">
          ${(task.attrs || []).map((a) => renderAttrChip(state, a.attrId, a.strength)).join('')}
        </div>
      </div>
      <div class="task-actions">
        ${kids.length ? '' : `<button data-action="decompose" data-id="${task.id}" title="自动拆分">拆</button>`}
        <button data-action="edit-task" data-id="${task.id}" title="编辑">改</button>
        <button data-action="del-task" data-id="${task.id}" title="删除">删</button>
      </div>
    </div>
    ${
      kids.length && expanded
        ? `<div class="children">${kids
            .map((k) => renderTaskCard(state, k, { isChild: true }))
            .join('')}</div>`
        : ''
    }
  </div>`;
}

function renderTaskPanel(state) {
  let list = state.tasks.filter((t) => t.parentId === null);
  if (!ui.showDone) list = list.filter((t) => t.status !== 'done' && t.status !== 'dropped');
  if (ui.query.trim()) {
    const q = ui.query.trim().toLowerCase();
    list = list.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.note || '').toLowerCase().includes(q),
    );
  }
  if (ui.filterAttrs.size) {
    list = list.filter((t) =>
      [...ui.filterAttrs].every((id) => (t.attrs || []).some((a) => a.attrId === id)),
    );
  }

  const ctx = { tasks: state.tasks, allocations: state.allocations, attributes: state.attributes };
  const sorted = sortTasks(list, ui.sortBy, ctx);
  const groups = groupTasks(sorted, ui.groupBy, ctx);

  const body = groups
    .map(
      (g) => `
    <div class="group">
      ${g.label ? `<div class="group-head" style="--c:${g.color ?? 'var(--line)'}">${esc(g.label)}</div>` : ''}
      ${g.tasks.map((t) => renderTaskCard(state, t)).join('')}
    </div>`,
    )
    .join('');

  return `
  <aside class="panel panel-tasks">
    <div class="panel-head">
      <h2>任务</h2>
      <div class="panel-head-actions">
        <button class="btn primary sm" data-action="new-task">+ 新建</button>
      </div>
    </div>

    <div class="filters">
      <input class="input sm" data-field="query" placeholder="搜索任务…" value="${esc(ui.query)}">
      <div class="filter-row">
        <select class="input sm" data-field="groupBy">
          ${GROUP_MODES.map(
            (m) => `<option value="${m.v}" ${ui.groupBy === m.v ? 'selected' : ''}>分组：${m.label}</option>`,
          ).join('')}
        </select>
        <select class="input sm" data-field="sortBy">
          ${SORT_MODES.map(
            (m) => `<option value="${m.v}" ${ui.sortBy === m.v ? 'selected' : ''}>排序：${m.label}</option>`,
          ).join('')}
        </select>
      </div>
      <div class="attr-filter">
        ${state.attributes
          .map(
            (a) =>
              `<button class="chip clickable ${ui.filterAttrs.has(a.id) ? 'on' : ''}"
                 style="--c:${a.color}" data-action="filter-attr" data-id="${a.id}">${esc(a.name)}</button>`,
          )
          .join('')}
        <button class="chip clickable attr-manage" data-action="open-attrs"
          title="管理属性">⚙ 属性</button>
        <label class="tiny-check"><input type="checkbox" data-field="showDone" ${
          ui.showDone ? 'checked' : ''
        }> 显示已完成</label>
      </div>
    </div>

    <div class="task-list" data-scroll-key="tasks">${body || '<div class="empty">还没有任务，点右上角新建</div>'}</div>
    <div class="panel-foot">
      <button class="link" data-action="open-attrs">管理属性</button>
      <button class="link" data-action="open-settings">设置</button>
      <button class="link danger" data-action="reset">重置演示数据</button>
    </div>
  </aside>`;
}

function allocsFor(state, dateK, slotId) {
  return state.allocations
    .filter((a) => a.date === dateK && a.slotId === slotId)
    .sort((x, y) => new Date(x.start) - new Date(y.start));
}

function renderWeek(state) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(ui.weekStart, i));
  const instances = buildSlotInstances(state.slots, ui.weekStart, 7);
  const now = new Date();

  const cols = days
    .map((day) => {
      const key = dateKey(day);
      const wd = isoWeekday(day);
      const todays = instances.filter((i) => i.dateKey === key);
      const isToday = key === dateKey(now);
      const usedMin = todays.reduce((s, i) => s + usedMinutes(i.id, state.allocations), 0);
      const capMin = todays.reduce((s, i) => s + i.capacityMin, 0);

      return `
      <div class="day ${isToday ? 'today' : ''}">
        <div class="day-head">
          <span class="wd">${WEEKDAYS.find((w) => w.v === wd).label}</span>
          <span class="dt">${fmtDate(day)}</span>
          ${capMin ? `<span class="load">${Math.round((usedMin / capMin) * 100)}%</span>` : ''}
        </div>
        <div class="day-slots">
          ${
            todays.length === 0
              ? '<div class="slot-empty">无时段</div>'
              : todays
                  .map((inst) => {
                    const allocs = allocsFor(state, key, inst.slotId);
                    const dur = minutesBetween(inst.start, inst.end);
                    const used = usedMinutes(inst.id, state.allocations);
                    const free = Math.max(0, inst.capacityMin - used);
                    const bodyH = Math.max(24, Math.round(dur * PX_PER_MIN));
                    const capBottom = Math.round((dur - inst.capacityMin) * PX_PER_MIN);
                    const capTop = Math.round(inst.capacityMin * PX_PER_MIN);

                    const allocHtml = allocs
                      .map((a) => {
                        const t = state.tasks.find((x) => x.id === a.taskId);
                        const parent = t?.parentId ? state.tasks.find((x) => x.id === t.parentId) : null;
                        const color = (t?.attrs || []).find((x) => x.strength === 'require');
                        const c = color ? attrById(state, color.attrId)?.color : null;
                        const label = parent ? `${parent.title} · ${t?.title}` : t?.title ?? '';
                        const offset = minutesBetween(inst.start, new Date(a.start));
                        const len = minutesBetween(new Date(a.start), new Date(a.end));
                        const top = Math.max(0, Math.round(offset * PX_PER_MIN));
                        // 夹紧在时段容器内：时段被改短后旧分片可能越界，不能任其溢出
                        const maxH = Math.max(15, bodyH - top);
                        const h = Math.min(Math.max(15, Math.round(len * PX_PER_MIN)), maxH);
                        return `<div class="alloc ${a.locked ? 'locked' : ''} ${
                          ui.selectedAlloc === a.id ? 'sel' : ''
                        }" data-alloc="${a.id}" style="--c:${c ?? '#636e72'};top:${top}px;height:${h}px"
                          title="${esc(label)}  ${fmtHM(new Date(a.start))}–${fmtHM(new Date(a.end))}">
                          <span class="alloc-t">${esc(label)}</span>
                          <span class="alloc-h">${fmtHM(new Date(a.start))}–${fmtHM(new Date(a.end))}${
                            a.actualMin != null ? ` · 实${a.actualMin}m` : ''
                          }</span>
                          ${a.locked ? '<span class="pin">锁</span>' : ''}
                          ${
                            h >= 26
                              ? `<button class="focus-btn" data-action="focus-open" data-id="${a.id}"
                                   title="开始专注计时" aria-label="开始专注计时">${focusIcon(14)}</button>`
                              : ''
                          }
                          <span class="alloc-rz" data-alloc-rz="${a.id}" title="拖动调整时长"></span>
                        </div>`;
                      })
                      .join('');

                    return `
            <div class="slot ${inst.kind === 'once' ? 'once' : ''}"
                 data-slot-inst="${inst.id}" data-date="${key}" data-slot="${inst.slotId}">
              <div class="slot-head">
                <span class="slot-name">${esc(inst.name)}</span>
                ${inst.kind === 'once' ? '<span class="badge">单次</span>' : ''}
                <button class="slot-edit" data-action="edit-slot" data-id="${inst.slotId}" title="编辑时段">✎</button>
              </div>
              <div class="slot-time">${fmtHM(inst.start)}–${fmtHM(inst.end)}</div>
              <div class="slot-attrs">
                ${(inst.attrs || [])
                  .map((id) => {
                    const a = attrById(state, id);
                    return a ? `<span class="dot" style="--c:${a.color}" title="${esc(a.name)}"></span>` : '';
                  })
                  .join('')}
                ${free > 0 ? `<span class="free">空 ${fmtDuration(free)}</span>` : '<span class="free full">已满</span>'}
                ${inst.maxTasks != null ? `<span class="free">上限 ${inst.maxTasks} 个</span>` : ''}
              </div>
              <div class="slot-body" data-body="${inst.id}" style="height:${bodyH}px">
                ${
                  capBottom > 0
                    ? `<div class="cap-zone" style="top:${capTop}px;height:${capBottom}px"
                         title="超出容量上限，不参与排程"></div>`
                    : ''
                }
                ${allocHtml}
              </div>
              <div class="slot-rz" data-slot-rz="${inst.slotId}" title="拖动调整时段结束时间"></div>
            </div>`;
                  })
                  .join('')
          }
        </div>
      </div>`;
    })
    .join('');

  return `
  <div class="week">
    <div class="week-nav">
      <button class="btn ghost sm" data-action="prev-week">← 上一周</button>
      <span class="week-label">${fmtDate(ui.weekStart)} – ${fmtDate(addDays(ui.weekStart, 6))}</span>
      <button class="btn ghost sm" data-action="next-week">下一周 →</button>
      <button class="btn ghost sm" data-action="this-week">回到本周</button>
      <button class="btn ghost sm" data-action="new-slot">+ 时段</button>
    </div>
    <div class="week-grid" data-scroll-key="week">${cols}</div>
  </div>`;
}
function renderUnscheduled(state, result) {
  if (!result) return '<div class="unsched empty-hint">点「自动排程」后，这里会列出排不进去的任务和原因。</div>';
  const { unscheduled, stats } = result;
  const reasonTxt = {
    empty_horizon: '排程范围内没有可用时段（都过去了或没配置）',
    no_matching_slot: '没有属性匹配的时段',
    constraint_blocked: '被任务的时段约束挡住了',
    no_capacity: '匹配时段容量已满',
    partial: '只排进去一部分',
  };
  return `
  <div class="unsched">
    <div class="unsched-head">
      <span>排程结果</span>
      <span class="stat">
        ${fmtDateKey(stats.horizonStart)}–${fmtDateKey(stats.horizonEnd)}（${stats.days} 天）
        · 容量 ${fmtDuration(stats.capacityMin)}
        · 已填 ${fmtDuration(stats.filledMin)}
        · 分片 ${stats.allocCount}
        ${stats.lastPlannedDate ? `· 已排到 ${fmtDateKey(stats.lastPlannedDate)}` : ''}
      </span>
    </div>
    ${
      unscheduled.length === 0
        ? '<div class="ok-banner">全部排进去了 ✓</div>'
        : `<ul class="unsched-list">${unscheduled
            .map((u) => {
              const t = state.tasks.find((x) => x.id === u.taskId);
              return `<li>
                <span class="u-title">${esc(t?.title ?? u.title)}</span>
                <span class="u-meta">还需 ${fmtDuration(u.remaining)} / 共 ${fmtDuration(u.need)}</span>
                <span class="u-reason">${reasonTxt[u.reason] ?? u.reason}</span>
                <button class="link" data-action="add-slot-for" data-id="${u.taskId}">加时段</button>
              </li>`;
            })
            .join('')}</ul>`
    }
  </div>`;
}

/* ---------------- 弹窗 ---------------- */

function renderTaskModal(state) {
  const m = ui.taskModal;
  if (!m) return '';
  const d = m.draft;
  const isEdit = m.mode === 'edit';
  return `
  <div class="overlay" data-action="close-modal">
    <div class="modal" data-stop="1">
      <div class="modal-head">
        <h3>${isEdit ? '编辑任务' : '新建任务'}</h3>
        <button class="x" data-action="close-modal">✕</button>
      </div>
      <div class="modal-body">
        <label class="field">
          <span>任务标题</span>
          <input class="input" data-draft="title" value="${esc(d.title)}" placeholder="例如：写毕业论文第二章">
        </label>
        <label class="field">
          <span>备注</span>
          <textarea class="input" rows="2" data-draft="note" placeholder="可写清交付物、上下文">${esc(d.note)}</textarea>
        </label>
        <div class="field-row">
          <label class="field">
            <span>优先级</span>
            <select class="input" data-draft="priority">
              <option value="3" ${d.priority === 3 ? 'selected' : ''}>高</option>
              <option value="2" ${d.priority === 2 ? 'selected' : ''}>中</option>
              <option value="1" ${d.priority === 1 ? 'selected' : ''}>低</option>
            </select>
          </label>
          <label class="field">
            <span>DDL</span>
            <input class="input" type="datetime-local" data-draft="dueAt" value="${isoToLocalInput(d.dueAt)}">
          </label>
        </div>
        <div class="field-row">
          <label class="field">
            <span>预计耗时（分钟）</span>
            <input class="input" type="number" min="10" step="5" data-draft="estMin" value="${d.estMin}">
          </label>
          <label class="field">
            <span>单块下限 / 上限（分钟）</span>
            <div class="pair">
              <input class="input" type="number" min="5" step="5" data-draft="minChunk" value="${d.minChunk}">
              <input class="input" type="number" min="5" step="5" data-draft="maxChunk" value="${d.maxChunk}">
            </div>
          </label>
        </div>
        <div class="field">
          <span>属性（点一下切换：必须 → 偏好 → 排除 → 关闭）</span>
          <div class="attr-picker">
            ${state.attributes
              .map((a) => {
                const cur = (d.attrs || []).find((x) => x.attrId === a.id)?.strength ?? null;
                return `<button class="chip clickable ${cur ? `on strength-${cur}` : ''}" style="--c:${a.color}"
                  data-action="cycle-attr" data-id="${a.id}">${esc(a.name)}${cur ? `<i>${STRENGTH_LABEL[cur]}</i>` : ''}</button>`;
              })
              .join('')}
          </div>
        </div>
        <div class="field cons-block">
          <span>排程约束 · 时段（点一下切换：只能排 → 排除 → 不限）</span>
          <div class="attr-picker">
            ${
              state.slots.length === 0
                ? '<span class="hint">还没有时段，先去日程表加一个</span>'
                : state.slots
                    .map((s) => {
                      const allow = (d.constraints?.allowSlotIds || []).includes(s.id);
                      const deny = (d.constraints?.denySlotIds || []).includes(s.id);
                      const cur = allow ? 'allow' : deny ? 'deny' : '';
                      return `<button class="chip clickable slot-chip ${cur}" data-action="cycle-slot-rule" data-id="${s.id}">
                        ${esc(slotLabel(s))}${cur ? `<i>${allow ? '只能' : '排除'}</i>` : ''}</button>`;
                    })
                    .join('')
            }
          </div>
          <div class="weekday-picker">
            <span class="mini">限定星期：</span>
            ${WEEKDAYS.map(
              (w) =>
                `<button class="chip clickable mini-chip ${
                  (d.constraints?.weekdays || []).includes(w.v) ? 'on' : ''
                }" data-action="toggle-weekday" data-id="${w.v}">${w.short}</button>`,
            ).join('')}
          </div>
          <div class="hint">不点时段 = 不限；点成「只能」后只在选中的时段里找位置。星期留空 = 不限。</div>
        </div>
        ${
          isEdit
            ? `<div class="field-row">
                 <label class="field">
                   <span>状态</span>
                   <select class="input" data-draft="status">
                     ${['todo', 'doing', 'done', 'dropped']
                       .map((s) => `<option value="${s}" ${d.status === s ? 'selected' : ''}>${{
                         todo: '待办', doing: '进行中', done: '已完成', dropped: '已放弃',
                       }[s]}</option>`)
                       .join('')}
                   </select>
                 </label>
               </div>`
            : ''
        }
      </div>
      <div class="modal-foot">
        ${isEdit ? `<button class="btn danger ghost" data-action="del-task" data-id="${d.id}">删除</button>` : ''}
        <span class="grow"></span>
        <button class="btn ghost" data-action="close-modal">取消</button>
        <button class="btn primary" data-action="save-task">保存</button>
      </div>
    </div>
  </div>`;
}

function renderSlotModal(state) {
  const m = ui.slotModal;
  if (!m) return '';
  const d = m.draft;
  return `
  <div class="overlay" data-action="close-modal">
    <div class="modal modal-sm" data-stop="1">
      <div class="modal-head">
        <h3>${m.mode === 'edit' ? '编辑时段' : '新建时段'}</h3>
        <button class="x" data-action="close-modal">✕</button>
      </div>
      <div class="modal-body">
        <div class="field-row">
          <label class="field">
            <span>类型</span>
            <select class="input" data-draft="kind">
              <option value="weekly" ${d.kind !== 'once' ? 'selected' : ''}>每周重复</option>
              <option value="once" ${d.kind === 'once' ? 'selected' : ''}>仅某一天</option>
            </select>
          </label>
          <label class="field">
            <span>名称</span>
            <input class="input" data-draft="name" value="${esc(d.name)}">
          </label>
        </div>
        ${
          d.kind === 'once'
            ? `<label class="field"><span>日期</span>
                 <input class="input" type="date" data-draft="date" value="${d.date ?? ''}">
               </label>`
            : `<label class="field"><span>星期</span>
                 <select class="input" data-draft="weekday">
                   ${WEEKDAYS.map((w) => `<option value="${w.v}" ${Number(d.weekday) === w.v ? 'selected' : ''}>${w.label}</option>`).join('')}
                 </select>
               </label>`
        }
        <div class="field-row">
          <label class="field"><span>开始</span><input class="input" type="time" data-draft="start" value="${d.start}"></label>
          <label class="field"><span>结束</span><input class="input" type="time" data-draft="end" value="${d.end}"></label>
        </div>
        <div class="field-row">
          <label class="field">
            <span>可被占用上限（分钟）</span>
            <input class="input" type="number" min="5" step="5" data-draft="capacityMin"
              placeholder="留空 = 全部时长" value="${d.capacityMin ?? ''}">
          </label>
          <label class="field">
            <span>最多容纳任务数</span>
            <input class="input" type="number" min="1" step="1" data-draft="maxTasks"
              placeholder="留空 = 不限" value="${d.maxTasks ?? ''}">
          </label>
        </div>
        <div class="field">
          <span>这个时段提供哪些属性</span>
          <div class="attr-picker">
            ${state.attributes
              .map(
                (a) => `<button class="chip clickable ${
                  (d.attrs || []).includes(a.id) ? 'on' : ''
                }" style="--c:${a.color}" data-action="toggle-slot-attr" data-id="${a.id}">${esc(a.name)}</button>`,
              )
              .join('')}
          </div>
        </div>
      </div>
      <div class="modal-foot">
        ${m.mode === 'edit' ? `<button class="btn danger ghost" data-action="del-slot" data-id="${d.id}">删除</button>` : ''}
        <span class="grow"></span>
        <button class="btn ghost" data-action="close-modal">取消</button>
        <button class="btn primary" data-action="save-slot">保存</button>
      </div>
    </div>
  </div>`;
}

function renderSettingsModal(state) {
  if (!ui.settingsOpen) return '';
  const s = state.settings;
  return `
  <div class="overlay" data-action="close-modal">
    <div class="modal modal-sm" data-stop="1">
      <div class="modal-head"><h3>设置</h3><button class="x" data-action="close-modal">✕</button></div>
      <div class="modal-body">
        <label class="field">
          <span>排程跨度下限</span>
          <select class="input" data-setting="horizonDays">
            ${[7, 14, 21, 30, 60]
              .map(
                (d) =>
                  `<option value="${d}" ${Number(s.horizonDays) === d ? 'selected' : ''}>${
                    d === 7 ? '至少 7 天' : `至少 ${d} 天（跨 ${Math.ceil(d / 7)} 周）`
                  }</option>`,
              )
              .join('')}
          </select>
          <span class="field-note">实际范围会自动延伸到最远的 DDL（上限 180 天）。</span>
        </label>
        <label class="field">
          <span>自动拆分最多几步</span>
          <input class="input" type="number" min="2" max="8" data-setting="maxSteps" value="${s.maxSteps}">
        </label>
        <label class="check-line">
          <input type="checkbox" data-setting="writeBack" ${s.writeBack !== false ? 'checked' : ''}>
          <span>专注结束后把实际时长回写到日程分片</span>
        </label>
        <div class="hint">
          LLM 配置留空时，拆分使用内置规则模板（离线可用）。
          填入 OpenAI 兼容接口后自动优先调用，失败会静默降级。
        </div>
        <label class="field"><span>Base URL</span>
          <input class="input" data-setting="llm.baseUrl" placeholder="https://api.openai.com/v1" value="${esc(s.llm.baseUrl)}">
        </label>
        <label class="field"><span>API Key</span>
          <input class="input" type="password" data-setting="llm.apiKey" placeholder="sk-..." value="${esc(s.llm.apiKey)}">
        </label>
        <label class="field"><span>模型</span>
          <input class="input" data-setting="llm.model" placeholder="gpt-4o-mini" value="${esc(s.llm.model)}">
        </label>

        ${renderSyncBlock()}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="btn primary" data-action="close-modal">完成</button>
      </div>
    </div>
  </div>`;
}

function renderAttrsModal(state) {
  if (!ui.attrsOpen) return '';

  const usage = (id) => {
    const tasks = state.tasks.filter((t) => (t.attrs || []).some((x) => x.attrId === id)).length;
    const slots = state.slots.filter((s) => (s.attrs || []).includes(id)).length;
    if (!tasks && !slots) return '未使用';
    return `${tasks} 任务 · ${slots} 时段`;
  };

  return `
  <div class="overlay" data-action="close-modal">
    <div class="modal modal-sm" data-stop="1">
      <div class="modal-head">
        <h3>属性管理</h3>
        <button class="x" data-action="close-modal">✕</button>
      </div>
      <div class="modal-body">
        <div class="hint">
          属性同时挂在<strong>任务</strong>和<strong>时段</strong>上，排程靠它做匹配。
          改名字、换颜色、调整顺序都会立刻生效。
        </div>

        <ul class="attr-list">
          ${
            state.attributes.length === 0
              ? '<li class="attr-empty">还没有属性，下面加一个</li>'
              : state.attributes
                  .map(
                    (a, i) => `
            <li class="attr-item">
              <button class="swatch" style="--c:${a.color}" data-action="cycle-attr-color"
                data-id="${a.id}" title="点击换颜色"></button>
              <input class="input sm attr-name" data-attr-name="${a.id}"
                value="${esc(a.name)}" maxlength="12" spellcheck="false">
              <span class="attr-usage">${usage(a.id)}</span>
              <span class="attr-ops">
                <button data-action="move-attr" data-id="${a.id}" data-dir="-1"
                  title="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
                <button data-action="move-attr" data-id="${a.id}" data-dir="1"
                  title="下移" ${i === state.attributes.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="link danger" data-action="del-attr" data-id="${a.id}">删</button>
              </span>
            </li>`,
                  )
                  .join('')
          }
        </ul>

        <div class="field-row">
          <input class="input" data-field="newAttrName" placeholder="新属性名称，如「深度工作」" maxlength="12">
          <button class="btn primary" data-action="add-attr">添加</button>
        </div>
        <div class="hint">删掉属性时，任务和时段上对应的标记会一起移除，但任务本身不会消失。</div>
      </div>
    </div>
  </div>`;
}

/* ---------------- 主渲染 ---------------- */

let lastResult = null;

function render() {
  const state = getState();
  const root = document.getElementById('app');

  // 重绘会重建整棵 DOM，滚动容器会回到顶部。
  // 先把各滚动容器和整页的位置记下来，画完再放回去。
  const scrollState = [];
  root.querySelectorAll('[data-scroll-key]').forEach((el) => {
    scrollState.push({ key: el.dataset.scrollKey, top: el.scrollTop, left: el.scrollLeft });
  });
  let pageY = 0;
  let pageX = 0;
  try {
    pageY = window.scrollY || 0;
    pageX = window.scrollX || 0;
  } catch {
    /* 无窗口环境忽略 */
  }

  const tasks = state.tasks.filter((t) => t.parentId === null && t.status !== 'done');
  const totalEst = tasks.reduce((s, t) => s + taskTotals(t, state.tasks, state.allocations).est, 0);
  const totalLeft = tasks.reduce((s, t) => s + taskTotals(t, state.tasks, state.allocations).remaining, 0);

  root.innerHTML = `
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="logo">◧</span>
        <div>
          <h1>${esc(SITE.name)}</h1>
          <p class="sub">${esc(SITE.tagline)}</p>
        </div>
      </div>
      <div class="topstats">
        <span><b>${tasks.length}</b> 个待办</span>
        <span>总工时 <b>${fmtDuration(totalEst)}</b></span>
        <span>待排 <b>${fmtDuration(totalLeft)}</b></span>
      </div>
      <div class="topactions">
        ${
          REPO_URL
            ? `<a class="btn ghost sm repo-link" href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>`
            : ''
        }
        <button class="btn primary" data-action="run-schedule" ${ui.busy ? 'disabled' : ''}
          title="从本周开始往后排，范围会自动延伸到最远的 DDL">
          ${ui.busy ? '排程中…' : '⚡ 自动排程'}
        </button>
      </div>
    </header>

    <main class="layout">
      ${renderTaskPanel(state)}
      <section class="panel panel-calendar">
        ${renderCalendarToolbar()}
        ${
          ui.view === 'month'
            ? renderMonth(state)
            : ui.view === 'day'
              ? renderDay(state)
              : renderWeek(state)
        }
        ${
          ui.selectedAlloc
            ? `<div class="alloc-toolbar">
                 <span>已选中 1 个分片</span>
                 ${
                   state.allocations.find((a) => a.id === ui.selectedAlloc)?.plannedMin
                     ? `<button class="btn ghost sm" data-action="restore-planned">还原计划时长</button>`
                     : ''
                 }
                 <button class="btn ghost sm" data-action="toggle-lock">锁定 / 解锁</button>
                 <button class="btn danger ghost sm" data-action="del-alloc">删除</button>
                 <button class="btn ghost sm" data-action="deselect-alloc">取消选择</button>
               </div>`
            : ''
        }
        ${renderUnscheduled(state, lastResult)}
      </section>
    </main>

    ${renderTaskModal(state)}
    ${renderSlotModal(state)}
    ${renderSettingsModal(state)}
    ${renderAttrsModal(state)}
    ${renderFocus(state)}
    ${ui.toast ? `<div class="toast ${ui.toast.kind}">${esc(ui.toast.msg)}</div>` : ''}
  </div>`;

  // 还原滚动位置：拖完分片、弹完 toast 都不该把视角弹回顶部
  for (const s0 of scrollState) {
    const el = root.querySelector(`[data-scroll-key="${s0.key}"]`);
    if (!el) continue;
    if (s0.top) el.scrollTop = s0.top;
    if (s0.left) el.scrollLeft = s0.left;
  }
  if (pageY || pageX) {
    try {
      window.scrollTo(pageX, pageY);
    } catch {
      /* 无窗口环境忽略 */
    }
  }
}

/* ---------------- 行为 ---------------- */

function openTaskModal(mode, task) {
  const cloneConstraints = (c) => ({
    allowSlotIds: [...(c?.allowSlotIds ?? [])],
    denySlotIds: [...(c?.denySlotIds ?? [])],
    weekdays: [...(c?.weekdays ?? [])],
  });
  const draft =
    mode === 'edit'
      ? {
          ...task,
          attrs: (task.attrs || []).map((a) => ({ ...a })),
          constraints: cloneConstraints(task.constraints),
        }
      : makeTask({ attrs: [], constraints: cloneConstraints(null) });
  ui.taskModal = { mode, draft };
  render();
}

function saveTaskModal() {
  const m = ui.taskModal;
  if (!m) return;
  const d = m.draft;
  if (!d.title.trim()) {
    toast('请填写任务标题', 'error');
    return;
  }
  update((s) => {
    const exists = s.tasks.some((t) => t.id === d.id);
    const tasks = exists ? s.tasks.map((t) => (t.id === d.id ? { ...t, ...d } : t)) : [...s.tasks, d];
    return { ...s, tasks };
  });
  ui.taskModal = null;
  toast('已保存');
}

function cycleAttr(attrId) {
  const m = ui.taskModal;
  if (!m) return;
  const attrs = m.draft.attrs || [];
  const idx = attrs.findIndex((a) => a.attrId === attrId);
  if (idx === -1) {
    attrs.push({ attrId, strength: 'require' });
  } else {
    const order = ['require', 'prefer', 'forbid'];
    const next = order[order.indexOf(attrs[idx].strength) + 1];
    if (!next) attrs.splice(idx, 1);
    else attrs[idx] = { attrId, strength: next };
  }
  m.draft.attrs = attrs;
  render();
}

/** 时段约束三态循环：不限 -> 只能 -> 排除 -> 不限 */
function cycleSlotRule(slotId) {
  const m = ui.taskModal;
  if (!m) return;
  if (!m.draft.constraints) m.draft.constraints = makeConstraints();
  const c = m.draft.constraints;
  c.allowSlotIds = c.allowSlotIds || [];
  c.denySlotIds = c.denySlotIds || [];

  if (c.allowSlotIds.includes(slotId)) {
    c.allowSlotIds = c.allowSlotIds.filter((x) => x !== slotId);
    c.denySlotIds.push(slotId);
  } else if (c.denySlotIds.includes(slotId)) {
    c.denySlotIds = c.denySlotIds.filter((x) => x !== slotId);
  } else {
    c.allowSlotIds.push(slotId);
  }
  render();
}

function toggleWeekday(wd) {
  const m = ui.taskModal;
  if (!m) return;
  if (!m.draft.constraints) m.draft.constraints = makeConstraints();
  const c = m.draft.constraints;
  c.weekdays = c.weekdays || [];
  if (c.weekdays.includes(wd)) c.weekdays = c.weekdays.filter((x) => x !== wd);
  else c.weekdays = [...c.weekdays, wd].sort((a, b) => a - b);
  render();
}

async function runDecompose(taskId) {
  const state = getState();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  if (childrenOf(state.tasks, taskId).length) {
    toast('该任务已经拆分过了');
    return;
  }
  ui.busy = true;
  render();
  try {
    const { steps, source, warning } = await decomposeTask(task, state);
    update((s) => {
      const tasks = [...s.tasks];
      steps.forEach((st) => {
        tasks.push(
          makeTask({
            ...st,
            parentId: taskId,
            dueAt: s.tasks.find((t) => t.id === taskId)?.dueAt ?? null,
            minChunk: task.minChunk,
            maxChunk: task.maxChunk,
            source: source === 'llm' ? 'ai' : 'manual',
            priority: task.priority,
          }),
        );
      });
      return { ...s, tasks };
    });
    ui.expanded.add(taskId);
    toast(
      `拆成 ${steps.length} 步（${source === 'llm' ? 'LLM' : '本地规则'}）${warning ? ` · ${warning}` : ''}`,
      warning ? 'warn' : 'ok',
    );
  } catch (err) {
    toast(`拆分失败：${err.message}`, 'error');
  } finally {
    ui.busy = false;
    render();
  }
}

function runSchedule() {
  const state = getState();
  // 始终从「今天所在周」开始，按设置的跨度往后铺，不受当前浏览到哪一周影响
  const result = schedule({ state, weekStart: new Date() });
  lastResult = result;
  update((s) => ({ ...s, allocations: result.allocations }));

  const span = `${fmtDateKey(result.stats.horizonStart)}–${fmtDateKey(result.stats.horizonEnd)}`;
  toast(
    result.unscheduled.length
      ? `${span} 内已排 ${result.created.length} 个分片，${result.unscheduled.length} 个任务排不进`
      : `${span} 内已排 ${result.created.length} 个分片，全部排入 ✓`,
    result.unscheduled.length ? 'warn' : 'ok',
  );
}

function placeManual(taskId, targetInstId) {
  update((s) => {
    const task = s.tasks.find((t) => t.id === taskId);
    if (!task) return s;

    const doneMin = s.allocations
      .filter((a) => a.taskId === taskId)
      .reduce((x, a) => x + minutesBetween(new Date(a.start), new Date(a.end)), 0);
    const remaining = Math.max(0, (task.estMin ?? 0) - doneMin);
    if (remaining <= 0) {
      queueMicrotask(() => toast('该任务已排满'));
      return s;
    }

    const instances = buildSlotInstances(s.slots, ui.weekStart, 7);
    const r = createAllocation({
      allocations: s.allocations,
      instances,
      taskId,
      targetInstId,
      offsetMin: 0,
      minutes: Math.min(remaining, task.maxChunk ?? 120),
    });
    if (!r.ok) {
      queueMicrotask(() => toast(r.error, 'error'));
      return s;
    }
    const created = r.alloc;
    queueMicrotask(() =>
      toast(`已放入 ${fmtDuration(minutesBetween(new Date(created.start), new Date(created.end)))}`),
    );
    return { ...s, allocations: r.allocations };
  });
}

/* ---------------- 日历顶部：视图切换 ---------------- */

function renderCalendarToolbar() {
  return `
  <div class="cal-toolbar">
    <div class="segmented" role="tablist">
      <button class="seg ${ui.view === 'day' ? 'on' : ''}" data-action="set-view" data-id="day" role="tab">日</button>
      <button class="seg ${ui.view === 'week' ? 'on' : ''}" data-action="set-view" data-id="week" role="tab">周</button>
      <button class="seg ${ui.view === 'month' ? 'on' : ''}" data-action="set-view" data-id="month" role="tab">月</button>
    </div>
    <span class="grow"></span>
    <span class="cal-hint">${
      ui.view === 'day'
        ? '拖分片可改时间 / 拖底边改时长 / 点 ⏱ 开始专注'
        : ui.view === 'month'
          ? '点击某一天跳到日视图'
          : '拖分片可换时段 / 拖分片底边改时长 / 拖时段底边改结束时间'
    }</span>
  </div>`;
}

/* ---------------- 日视图（iOS 日历风格） ---------------- */

const DAY_PX_PER_MIN = 1.1;

function renderDay(state) {
  const date = ui.dayDate;
  const key = dateKey(date);
  const wd = isoWeekday(date);
  const now = new Date();
  const isToday = key === dateKey(now);

  const instances = buildSlotInstances(state.slots, startOfWeek(date), 7)
    .filter((i) => i.dateKey === key)
    .sort((a, b) => a.start - b.start);
  const dayAllocs = state.allocations
    .filter((a) => a.date === key)
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  // 时间范围：覆盖时段与分片，向外对齐到整点
  const marks = [];
  instances.forEach((i) => {
    marks.push(i.start.getHours() * 60 + i.start.getMinutes());
    marks.push(i.end.getHours() * 60 + i.end.getMinutes());
  });
  dayAllocs.forEach((a) => {
    const s = new Date(a.start);
    const e = new Date(a.end);
    marks.push(s.getHours() * 60 + s.getMinutes());
    marks.push(e.getHours() * 60 + e.getMinutes());
  });

  let startMin = marks.length ? Math.min(...marks) : 8 * 60;
  let endMin = marks.length ? Math.max(...marks) : 22 * 60;
  startMin = Math.max(0, Math.floor(startMin / 60) * 60);
  endMin = Math.min(24 * 60, Math.ceil(endMin / 60) * 60);
  if (endMin - startMin < 180) endMin = Math.min(24 * 60, startMin + 180);

  const base = atDateTime(key, minutesToHM(startMin));
  const canvasH = Math.round((endMin - startMin) * DAY_PX_PER_MIN);
  const toTop = (d) => Math.round(minutesBetween(base, d) * DAY_PX_PER_MIN);

  const hours = [];
  for (let m = startMin; m <= endMin; m += 60) hours.push(m);

  const hourHtml = hours
    .map(
      (m) =>
        `<div class="dv-hour" style="top:${Math.round((m - startMin) * DAY_PX_PER_MIN)}px">
           <span class="dv-hour-label">${minutesToHM(m)}</span>
         </div>`,
    )
    .join('');

  const slotHtml = instances
    .map((inst) => {
      const top = toTop(inst.start);
      const h = Math.round(minutesBetween(inst.start, inst.end) * DAY_PX_PER_MIN);
      const used = usedMinutes(inst.id, state.allocations);
      const attrs = (inst.attrs || []).map((id) => attrById(state, id)).filter(Boolean);
      const c = attrs[0]?.color ?? '#636e72';
      const free = Math.max(0, inst.capacityMin - used);
      return `
      <div class="dv-slot ${inst.kind === 'once' ? 'once' : ''}"
           data-slot-inst="${inst.id}" data-date="${key}" data-slot="${inst.slotId}"
           style="top:${top}px;height:${h}px;--c:${c}">
        <div class="dv-slot-head">
          <span class="dv-slot-name">${esc(inst.name)}</span>
          <span class="dv-slot-time">${fmtHM(inst.start)}–${fmtHM(inst.end)}</span>
          ${attrs.map((a) => `<span class="dot" style="--c:${a.color}" title="${esc(a.name)}"></span>`).join('')}
          <span class="dv-slot-free">${free > 0 ? `空 ${fmtDuration(free)}` : '已满'}</span>
          <button class="slot-edit" data-action="edit-slot" data-id="${inst.slotId}" title="编辑时段">✎</button>
        </div>
        ${
          h > 34
            ? `<div class="dv-slot-body"></div>`
            : ''
        }
      </div>`;
    })
    .join('');

  const allocHtml = dayAllocs
    .map((a) => {
      const t = state.tasks.find((x) => x.id === a.taskId);
      const parent = t?.parentId ? state.tasks.find((x) => x.id === t.parentId) : null;
      const label = parent ? `${parent.title} · ${t?.title}` : t?.title ?? '';
      const colorAttr = (t?.attrs || []).find((x) => x.strength === 'require');
      const c = colorAttr ? attrById(state, colorAttr.attrId)?.color : '#636e72';
      const top = toTop(new Date(a.start));
      const h = Math.max(38, Math.round(minutesBetween(new Date(a.start), new Date(a.end)) * DAY_PX_PER_MIN));
      return `
      <div class="dv-alloc ${a.locked ? 'locked' : ''} ${ui.selectedAlloc === a.id ? 'sel' : ''}"
           data-alloc="${a.id}" style="top:${top}px;height:${h}px;--c:${c}">
        <div class="dv-alloc-main">
          <span class="dv-alloc-t">${esc(label)}</span>
          <span class="dv-alloc-h">${fmtHM(new Date(a.start))}–${fmtHM(new Date(a.end))}${
            a.actualMin != null ? ` · 实 ${a.actualMin} 分钟` : ''
          }${a.locked ? ' · 已锁定' : ''}</span>
        </div>
        <button class="focus-btn" data-action="focus-open" data-id="${a.id}"
                title="开始专注计时" aria-label="开始专注计时">${focusIcon(17)}</button>
        <span class="alloc-rz" data-alloc-rz="${a.id}" title="拖动调整时长"></span>
      </div>`;
    })
    .join('');

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowLine =
    isToday && nowMin >= startMin && nowMin <= endMin
      ? `<div class="dv-now" style="top:${Math.round((nowMin - startMin) * DAY_PX_PER_MIN)}px">
           <span>${fmtHM(now)}</span>
         </div>`
      : '';

  const usedTotal = instances.reduce((s, i) => s + usedMinutes(i.id, state.allocations), 0);

  return `
  <div class="dayview">
    <div class="week-nav">
      <button class="btn ghost sm" data-action="day-prev">← 前一天</button>
      <span class="week-label">${WEEKDAYS.find((w) => w.v === wd).label} ${fmtDate(date)}${
        isToday ? ' · 今天' : ''
      }</span>
      <button class="btn ghost sm" data-action="day-next">后一天 →</button>
      <button class="btn ghost sm" data-action="day-today">回到今天</button>
      <button class="btn ghost sm" data-action="new-slot">+ 时段</button>
      <span class="week-hint">${instances.length} 个时段 · 已排 ${fmtDuration(usedTotal)}</span>
    </div>
    <div class="dv-scroll" data-scroll-key="day">
      ${
        instances.length === 0 && dayAllocs.length === 0
          ? '<div class="dv-empty">这一天没有时段。切到「周」视图添加时段，或直接点「+ 时段」。</div>'
          : `<div class="dv-canvas" style="height:${canvasH}px">
               ${hourHtml}
               ${slotHtml}
               ${allocHtml}
               ${nowLine}
             </div>`
      }
    </div>
  </div>`;
}

/* ---------------- 月视图 ---------------- */

function renderMonth(state) {
  const base = ui.monthDate;
  const year = base.getFullYear();
  const month = base.getMonth();
  const first = new Date(year, month, 1);
  // 周一为一周起始
  const gridStart = addDays(first, -(isoWeekday(first) - 1));
  const todayKey = dateKey(new Date());

  const byDate = new Map();
  for (const a of state.allocations || []) {
    if (!byDate.has(a.date)) byDate.set(a.date, []);
    byDate.get(a.date).push(a);
  }
  const weeklySlots = new Set(
    (state.slots || []).filter((s) => s.kind !== 'once').map((s) => Number(s.weekday)),
  );
  const onceDates = new Set(
    (state.slots || []).filter((s) => s.kind === 'once').map((s) => s.date),
  );

  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const d = addDays(gridStart, i);
    const key = dateKey(d);
    const inMonth = d.getMonth() === month;
    const isToday = key === todayKey;
    const allocs = (byDate.get(key) || []).sort(
      (a, b) => new Date(a.start) - new Date(b.start),
    );
    const totalMin = allocs.reduce(
      (sum, a) => sum + minutesBetween(new Date(a.start), new Date(a.end)),
      0,
    );
    const hasSlot = weeklySlots.has(isoWeekday(d)) || onceDates.has(key);

    const items = allocs
      .slice(0, 3)
      .map((a) => {
        const t = state.tasks.find((x) => x.id === a.taskId);
        const parent = t?.parentId ? state.tasks.find((x) => x.id === t.parentId) : null;
        const label = parent ? `${parent.title} · ${t?.title}` : t?.title ?? '';
        const colorAttr = (t?.attrs || []).find((x) => x.strength === 'require');
        const c = colorAttr ? attrById(state, colorAttr.attrId)?.color : '#636e72';
        return `<span class="mon-item" style="--c:${c}" title="${esc(label)} ${fmtHM(new Date(a.start))}–${fmtHM(new Date(a.end))}">
          <i>${fmtHM(new Date(a.start))}</i>${esc(label)}
        </span>`;
      })
      .join('');

    cells.push(`
      <div class="mon-cell ${inMonth ? '' : 'dim'} ${isToday ? 'today' : ''} ${
        hasSlot ? 'has-slot' : ''
      }" data-action="open-day" data-id="${key}" title="${key}${hasSlot ? ' · 有时段' : ''}">
        <div class="mon-head">
          <span class="mon-day">${d.getDate()}</span>
          ${totalMin ? `<span class="mon-load">${fmtDuration(totalMin)}</span>` : ''}
        </div>
        <div class="mon-items">
          ${items}
          ${allocs.length > 3 ? `<span class="mon-more">+${allocs.length - 3}</span>` : ''}
        </div>
      </div>`);
  }

  const monthTotal = [...byDate.entries()]
    .filter(([k]) => parseDateKey(k).getMonth() === month)
    .reduce(
      (sum, [, list]) =>
        sum + list.reduce((x, a) => x + minutesBetween(new Date(a.start), new Date(a.end)), 0),
      0,
    );

  return `
  <div class="monthview">
    <div class="week-nav">
      <button class="btn ghost sm" data-action="month-prev">← 上个月</button>
      <span class="week-label">${year} 年 ${month + 1} 月</span>
      <button class="btn ghost sm" data-action="month-next">下个月 →</button>
      <button class="btn ghost sm" data-action="month-today">回到本月</button>
      <button class="btn ghost sm" data-action="new-slot">+ 时段</button>
      <span class="week-hint">已排 ${fmtDuration(monthTotal)}</span>
    </div>
    <div class="mon-head-row">
      ${WEEKDAYS.map((w) => `<div class="mon-wd">${w.short}</div>`).join('')}
    </div>
    <div class="mon-grid">${cells.join('')}</div>
  </div>`;
}

/* ---------------- 专注计时 ---------------- */

const focus = { session: null, timer: null };
const RING_R = 54;
const RING_C = 2 * Math.PI * RING_R;

function ensureFocusTicker() {
  if (focus.timer) return;
  focus.timer = setInterval(tickFocus, 250);
}

function stopFocusTicker() {
  if (focus.timer) clearInterval(focus.timer);
  focus.timer = null;
}

function tickFocus() {
  const s = focus.session;
  if (!s) {
    stopFocusTicker();
    return;
  }
  const now = Date.now();
  const rem = remainingMs(s, now);
  const p = progress(s, now);

  document.querySelectorAll('[data-focus-time]').forEach((el) => {
    el.textContent = fmtClock(rem);
  });
  document.querySelectorAll('[data-focus-ring]').forEach((el) => {
    el.style.strokeDashoffset = String(RING_C * (1 - p));
  });

  if (s.running && rem <= 0) completeFocus('completed');
}

function openFocusForAlloc(allocId) {
  const state = getState();
  const alloc = state.allocations.find((a) => a.id === allocId);
  if (!alloc) {
    toast('找不到这个分片', 'error');
    return;
  }
  if (focus.session) {
    // 已有专注进行中：先按「中止」记录掉
    commitFocus('stopped');
  }
  const planned = Math.max(1, Math.round(minutesBetween(new Date(alloc.start), new Date(alloc.end))));
  const session = startSession(
    createSession({ taskId: alloc.taskId, allocId, plannedMin: planned }),
  );
  focus.session = session;
  ui.focusOpen = true;
  ensureFocusTicker();
  render();
}

function commitFocus(status) {
  const s = focus.session;
  if (!s) return null;
  const rec = finishSession(s, status, Date.now());
  focus.session = null;
  stopFocusTicker();
  ui.focusOpen = false;
  if (rec.actualMin <= 0) {
    // 不足 1 分钟不留记录，避免刷出一堆空会话
    render();
    return null;
  }

  const state = getState();
  let allocations = state.allocations;
  let note = '';

  if (state.settings.writeBack !== false && rec.allocId) {
    const alloc = state.allocations.find((a) => a.id === rec.allocId);
    const instances = alloc
      ? buildSlotInstances(state.slots, startOfWeek(new Date(alloc.start)), 7)
      : [];
    const wb = applyFocusWriteBack({
      allocations,
      instances,
      allocId: rec.allocId,
      actualMin: rec.actualMin,
    });
    if (wb.ok) {
      allocations = wb.allocations;
      if (wb.clamped) note = `，但日程只能放到 ${wb.applied} 分钟`;
      else if (wb.changed) note = `，日程已按 ${wb.applied} 分钟更新`;
    } else {
      note = `，未回写：${wb.reason}`;
    }
  }

  update((st) => ({
    ...st,
    allocations,
    focusSessions: [...(st.focusSessions ?? []), rec],
  }));
  return { rec, note };
}

function completeFocus(status) {
  const out = commitFocus(status);
  if (out) toast(`专注完成 · ${out.rec.actualMin} 分钟${out.note}`, 'ok');
}

function renderFocus(state) {
  const s = focus.session;
  if (!s) return '';
  const task = state.tasks.find((t) => t.id === s.taskId);
  const alloc = s.allocId ? state.allocations.find((a) => a.id === s.allocId) : null;
  const now = Date.now();
  const rem = remainingMs(s, now);
  const p = progress(s, now);

  // 收起时变成右下角悬浮条，不打断用户继续操作日程
  if (!ui.focusOpen) {
    return `
    <button class="focus-pill ${s.running ? 'live' : ''}" data-action="focus-expand" title="展开专注计时">
      <span class="pill-dot"></span>
      <span class="pill-time" data-focus-time>${fmtClock(rem)}</span>
      <span class="pill-task">${esc(task?.title ?? '')}</span>
    </button>`;
  }

  return `
  <div class="overlay" data-action="focus-close">
    <div class="modal modal-sm focus-modal" data-stop="1">
      <div class="modal-head">
        <h3>专注计时</h3>
        <button class="x" data-action="focus-close">✕</button>
      </div>
      <div class="modal-body focus-body">
        <div class="focus-task">${esc(task?.title ?? '未命名任务')}</div>
        <div class="focus-sub">${
          alloc
            ? `${fmtHM(new Date(alloc.start))}–${fmtHM(new Date(alloc.end))} · 分片时长 ${s.plannedMin} 分钟`
            : '自由专注'
        }</div>

        <div class="ring-wrap">
          <svg viewBox="0 0 120 120" class="ring">
            <circle cx="60" cy="60" r="${RING_R}" class="ring-bg"></circle>
            <circle cx="60" cy="60" r="${RING_R}" class="ring-fg" data-focus-ring
              style="stroke-dasharray:${RING_C.toFixed(1)};stroke-dashoffset:${(RING_C * (1 - p)).toFixed(1)}"></circle>
          </svg>
          <div class="ring-center">
            <div class="focus-time" data-focus-time>${fmtClock(rem)}</div>
            <div class="focus-planned">${s.running ? '进行中' : s.accumulatedMs > 0 ? '已暂停' : '待开始'}</div>
          </div>
        </div>

        <div class="focus-controls">
          ${
            s.running
              ? '<button class="btn primary grow-btn" data-action="focus-pause">暂停</button>'
              : `<button class="btn primary grow-btn" data-action="focus-start">${
                  s.accumulatedMs > 0 ? '继续' : '开始'
                }</button>`
          }
          <button class="btn ghost" data-action="focus-reset">重置</button>
          <button class="btn ghost" data-action="focus-finish">结束并记录</button>
        </div>

        <label class="field">
          <span>目标时长（分钟）</span>
          <input class="input" type="number" min="1" step="5" data-focus-min value="${s.plannedMin}">
        </label>
      </div>
    </div>
  </div>`;
}

/* ---------------- 设备同步（GitHub Gist） ---------------- */

function fmtSyncTime(iso) {
  if (!iso) return '从未';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '从未';
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtHM(d)}`;
}

function renderSyncBlock() {
  const cfg = loadSyncConfig();
  const connected = !!cfg.gistId;
  const busy = ui.syncBusy;

  return `
  <div class="field cons-block sync-block">
    <span>设备同步（GitHub Gist）</span>
    <div class="hint">
      用你的 GitHub 账号当登录，数据存在自己的<strong>私有 Gist</strong> 里，不经过任何第三方服务器。
      Token 只保存在本机浏览器，<strong>不会上传</strong>。<br>
      生成方式：GitHub → Settings → Developer settings → <strong>Fine-grained tokens</strong>，
      权限只勾 <strong>Gists: Read and write</strong>。
    </div>

    <label class="field">
      <span>Personal Access Token</span>
      <input class="input" type="password" data-sync="token"
        placeholder="github_pat_..." autocomplete="off" spellcheck="false"
        value="${esc(cfg.token)}">
    </label>

    <div class="sync-actions">
      <button class="btn primary sm" data-action="sync-push" ${busy ? 'disabled' : ''}>
        ${busy ? '处理中…' : '上传到云端'}
      </button>
      <button class="btn ghost sm" data-action="sync-pull" ${busy ? 'disabled' : ''}>
        从云端恢复
      </button>
      ${
        connected
          ? '<button class="btn ghost sm danger" data-action="sync-forget">断开同步</button>'
          : ''
      }
    </div>

    <div class="sync-status ${ui.syncMsg ? 'has-msg' : ''}">
      ${
        connected
          ? `已连接${cfg.login ? ` · <b>${esc(cfg.login)}</b>` : ''} · 上次同步 ${fmtSyncTime(cfg.lastSyncAt)}`
          : '未连接'
      }
      ${ui.syncMsg ? `<span class="sync-msg">${esc(ui.syncMsg)}</span>` : ''}
    </div>
  </div>`;
}

function readTokenFromModal() {
  const el = document.querySelector('[data-sync="token"]');
  return (el?.value ?? '').trim();
}

async function doSyncPush() {
  const token = readTokenFromModal();
  if (!token) {
    ui.syncMsg = '请先填 Token';
    render();
    return;
  }
  saveSyncConfig({ token });
  ui.syncBusy = true;
  ui.syncMsg = '上传中…';
  render();

  try {
    const cfg = loadSyncConfig();
    const state = getState();
    const res = await pushState(state, cfg);
    saveSyncConfig({ gistId: res.gistId, lastSyncAt: new Date().toISOString() });
    ui.syncMsg = res.created ? '已创建云端备份 ✓' : '已上传 ✓';
    toast(res.created ? '已在云端创建备份' : '已同步到云端', 'ok');
  } catch (err) {
    ui.syncMsg = err.message;
    toast(err.message, 'error');
  } finally {
    ui.syncBusy = false;
    render();
  }
}

async function doSyncPull() {
  const token = readTokenFromModal();
  if (!token) {
    ui.syncMsg = '请先填 Token';
    render();
    return;
  }
  saveSyncConfig({ token });

  const cfg = loadSyncConfig();
  if (!cfg.gistId) {
    ui.syncMsg = '还没有云端备份，先点「上传到云端」';
    render();
    return;
  }

  ui.syncBusy = true;
  ui.syncMsg = '拉取中…';
  render();

  try {
    const payload = await pullState(cfg);
    const merged = mergeRemote(payload.state, getState());
    update(() => merged);
    saveSyncConfig({ lastSyncAt: new Date().toISOString() });
    ui.syncMsg = `已恢复云端数据（${fmtSyncTime(payload.updatedAt)}）`;
    toast('已从云端恢复', 'ok');
  } catch (err) {
    ui.syncMsg = err.message;
    toast(err.message, 'error');
  } finally {
    ui.syncBusy = false;
    render();
  }
}

/* ---------------- 事件绑定 ---------------- */

function onDraftInput(e) {
  const field = e.target.dataset.draft;
  if (!field) return;
  const m = ui.taskModal ?? ui.slotModal;
  if (!m) return;
  let v = e.target.value;
  if (['priority', 'estMin', 'minChunk', 'maxChunk', 'weekday'].includes(field)) v = Number(v);
  if (['capacityMin', 'maxTasks'].includes(field)) v = v === '' ? null : Number(v);
  if (field === 'dueAt') v = localInputToIso(v);
  if (field === 'date') v = v || null;
  m.draft[field] = v;

  // 切换「每周重复 / 仅某一天」时要立刻重绘表单（星期输入框 <-> 日期输入框）
  if (field === 'kind') {
    if (v === 'once' && !m.draft.date) m.draft.date = dateKey(new Date());
    render();
  }
}

document.addEventListener('input', (e) => {
  const f = e.target.dataset.field;
  if (f === 'query') {
    ui.query = e.target.value;
    render();
    // 保持焦点与光标
    const el = document.querySelector('[data-field="query"]');
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    return;
  }
  if (e.target.dataset.draft) onDraftInput(e);
});

document.addEventListener('change', (e) => {
  // 属性改名：走 change 而不是 input，避免每敲一个字就重绘丢失焦点
  const attrId = e.target.dataset.attrName;
  if (attrId) {
    const name = e.target.value.trim();
    if (!name) {
      render();
      return;
    }
    update((s2) => ({
      ...s2,
      attributes: s2.attributes.map((a) => (a.id === attrId ? { ...a, name } : a)),
    }));
    return;
  }
  if (e.target.dataset.focusMin !== undefined) {
    if (focus.session) {
      focus.session = setPlannedMinutes(focus.session, Number(e.target.value));
      render();
    }
    return;
  }
  const f = e.target.dataset.field;
  if (f === 'groupBy') { ui.groupBy = e.target.value; render(); return; }
  if (f === 'sortBy') { ui.sortBy = e.target.value; render(); return; }
  if (f === 'showDone') { ui.showDone = e.target.checked; render(); return; }
  if (e.target.dataset.draft) onDraftInput(e);

  const setting = e.target.dataset.setting;
  if (setting) {
    let v = e.target.value;
    if (setting === 'maxSteps' || setting === 'horizonDays') v = Number(v);
    if (setting === 'writeBack') v = e.target.checked;
    update((s) => {
      const next = { ...s, settings: { ...s.settings } };
      if (setting.startsWith('llm.')) {
        next.settings.llm = { ...next.settings.llm, [setting.slice(4)]: v };
      } else {
        next.settings[setting] = v;
      }
      return next;
    });
  }
});

document.addEventListener('click', async (e) => {
  // 拖拽结束时浏览器还会补发一次 click，这里吞掉它
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  // 先处理分片点选：分片本身没有 data-action，不能走下面的按钮分支
  const allocEl = e.target.closest('[data-alloc]');
  if (allocEl && !e.target.closest('[data-action]')) {
    const aid = allocEl.dataset.alloc;
    ui.selectedAlloc = aid === ui.selectedAlloc ? null : aid;
    render();
    return;
  }

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;
  const state = getState();

  switch (action) {
    case 'new-task':
      openTaskModal('create');
      break;
    case 'edit-task': {
      const t = state.tasks.find((x) => x.id === id);
      if (t) openTaskModal('edit', t);
      break;
    }
    case 'save-task':
      saveTaskModal();
      break;
    case 'del-task':
      update((s) => ({
        ...s,
        tasks: s.tasks.filter((t) => t.id !== id && t.parentId !== id),
        allocations: s.allocations.filter((a) => a.taskId !== id),
      }));
      ui.taskModal = null;
      toast('已删除');
      break;
    case 'toggle-done':
      update((s) => ({
        ...s,
        tasks: s.tasks.map((t) =>
          t.id === id
            ? { ...t, status: t.status === 'done' ? 'todo' : 'done', completedAt: t.status === 'done' ? null : new Date().toISOString() }
            : t,
        ),
      }));
      break;
    case 'toggle-expand':
      if (ui.expanded.has(id)) ui.expanded.delete(id);
      else ui.expanded.add(id);
      render();
      break;
    case 'decompose':
      await runDecompose(id);
      break;
    case 'cycle-attr':
      cycleAttr(id);
      break;
    case 'cycle-slot-rule':
      cycleSlotRule(id);
      break;
    case 'toggle-weekday':
      toggleWeekday(Number(id));
      break;
    case 'filter-attr':
      if (ui.filterAttrs.has(id)) ui.filterAttrs.delete(id);
      else ui.filterAttrs.add(id);
      render();
      break;
    case 'run-schedule':
      runSchedule();
      break;
    case 'prev-week':
      ui.weekStart = addDays(ui.weekStart, -7);
      render();
      break;
    case 'next-week':
      ui.weekStart = addDays(ui.weekStart, 7);
      render();
      break;
    case 'this-week':
      ui.weekStart = startOfWeek(new Date());
      render();
      break;
    case 'new-slot':
      ui.slotModal = { mode: 'create', draft: makeSlot({ weekday: isoWeekday(new Date()) }) };
      render();
      break;
    case 'edit-slot': {
      const s0 = state.slots.find((x) => x.id === id);
      if (s0) {
        ui.slotModal = { mode: 'edit', draft: { ...s0, attrs: [...(s0.attrs || [])] } };
        render();
      }
      break;
    }
    case 'toggle-slot-attr': {
      const m = ui.slotModal;
      if (!m) break;
      const arr = m.draft.attrs || [];
      const i = arr.indexOf(id);
      if (i === -1) arr.push(id);
      else arr.splice(i, 1);
      m.draft.attrs = arr;
      render();
      break;
    }
    case 'save-slot': {
      const m = ui.slotModal;
      if (!m) break;
      if (m.draft.end <= m.draft.start) {
        toast('结束时间必须晚于开始时间', 'error');
        break;
      }
      if (m.draft.kind === 'once' && !m.draft.date) {
        toast('单次时段必须选择日期', 'error');
        break;
      }
      update((s) => {
        const exists = s.slots.some((x) => x.id === m.draft.id);
        const slots = exists
          ? s.slots.map((x) => (x.id === m.draft.id ? { ...x, ...m.draft } : x))
          : [...s.slots, m.draft];
        return { ...s, slots };
      });
      ui.slotModal = null;
      toast('时段已保存');
      break;
    }
    case 'del-slot':
      update((s) => ({
        ...s,
        slots: s.slots.filter((x) => x.id !== id),
        allocations: s.allocations.filter((a) => a.slotId !== id),
      }));
      ui.slotModal = null;
      toast('时段已删除');
      break;
    case 'add-slot-for': {
      const t = state.tasks.find((x) => x.id === id);
      const attrId = (t?.attrs || []).find((a) => a.strength === 'require')?.attrId;
      ui.slotModal = {
        mode: 'create',
        draft: makeSlot({
          weekday: isoWeekday(new Date()),
          name: '补充时段',
          attrs: attrId ? [attrId] : [],
        }),
      };
      render();
      break;
    }
    case 'toggle-lock':
      update((s) => ({
        ...s,
        allocations: s.allocations.map((a) =>
          a.id === ui.selectedAlloc ? { ...a, locked: !a.locked } : a,
        ),
      }));
      break;
    case 'del-alloc':
      update((s) => ({ ...s, allocations: s.allocations.filter((a) => a.id !== ui.selectedAlloc) }));
      ui.selectedAlloc = null;
      render();
      break;
    case 'deselect-alloc':
      ui.selectedAlloc = null;
      render();
      break;
    case 'open-settings':
      ui.settingsOpen = true;
      ui.syncMsg = '';
      render();
      break;
    case 'sync-push':
      await doSyncPush();
      break;
    case 'sync-pull':
      await doSyncPull();
      break;
    case 'sync-forget':
      clearSyncConfig();
      ui.syncMsg = '已断开（云端数据仍在，可重新连接）';
      render();
      break;
    case 'open-attrs':
      ui.attrsOpen = true;
      render();
      break;
    case 'add-attr': {
      const input = document.querySelector('[data-field="newAttrName"]');
      const name = (input?.value || '').trim();
      if (!name) break;
      update((s) => ({
        ...s,
        attributes: [
          ...s.attributes,
          {
            id: uid('attr'),
            name,
            color: ATTR_PALETTE[s.attributes.length % ATTR_PALETTE.length],
          },
        ],
      }));
      toast('属性已添加');
      break;
    }
    case 'cycle-attr-color': {
      const attr = state.attributes.find((a) => a.id === id);
      if (!attr) break;
      const i = ATTR_PALETTE.indexOf(attr.color);
      const next = ATTR_PALETTE[(i + 1) % ATTR_PALETTE.length];
      update((s2) => ({
        ...s2,
        attributes: s2.attributes.map((a) => (a.id === id ? { ...a, color: next } : a)),
      }));
      break;
    }
    case 'move-attr': {
      const dir = Number(el.dataset.dir) || 0;
      update((s2) => {
        const list = [...s2.attributes];
        const i = list.findIndex((a) => a.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= list.length) return s2;
        [list[i], list[j]] = [list[j], list[i]];
        return { ...s2, attributes: list };
      });
      break;
    }
    case 'del-attr':
      update((s) => ({
        ...s,
        attributes: s.attributes.filter((a) => a.id !== id),
        tasks: s.tasks.map((t) => ({ ...t, attrs: (t.attrs || []).filter((a) => a.attrId !== id) })),
        slots: s.slots.map((t) => ({ ...t, attrs: (t.attrs || []).filter((a) => a !== id) })),
      }));
      toast('属性已删除');
      break;
    case 'set-view':
      ui.view = ['day', 'week', 'month'].includes(id) ? id : 'week';
      if (ui.view === 'month') ui.monthDate = new Date(ui.dayDate);
      render();
      break;
    case 'open-day':
      ui.dayDate = parseDateKey(id);
      ui.view = 'day';
      render();
      break;
    case 'month-prev':
      ui.monthDate = new Date(ui.monthDate.getFullYear(), ui.monthDate.getMonth() - 1, 1);
      render();
      break;
    case 'month-next':
      ui.monthDate = new Date(ui.monthDate.getFullYear(), ui.monthDate.getMonth() + 1, 1);
      render();
      break;
    case 'month-today':
      ui.monthDate = new Date();
      render();
      break;
    case 'day-prev':
      ui.dayDate = addDays(ui.dayDate, -1);
      render();
      break;
    case 'day-next':
      ui.dayDate = addDays(ui.dayDate, 1);
      render();
      break;
    case 'day-today':
      ui.dayDate = new Date();
      render();
      break;
    case 'focus-open':
      openFocusForAlloc(id);
      break;
    case 'focus-expand':
      ui.focusOpen = true;
      render();
      break;
    case 'focus-close':
      if (e.target.closest('.modal')) break;
      ui.focusOpen = false;
      render();
      break;
    case 'focus-start':
      if (focus.session) {
        focus.session = startSession(focus.session);
        ensureFocusTicker();
        render();
      }
      break;
    case 'focus-pause':
      if (focus.session) {
        focus.session = pauseSession(focus.session);
        render();
      }
      break;
    case 'focus-reset':
      if (focus.session) {
        focus.session = resetSession(focus.session);
        render();
      }
      break;
    case 'focus-finish': {
      const out = commitFocus('stopped');
      if (out) toast(`已记录 ${out.rec.actualMin} 分钟${out.note}`);
      break;
    }
    case 'restore-planned': {
      const st0 = getState();
      const target = st0.allocations.find((a) => a.id === ui.selectedAlloc);
      if (!target) break;
      const insts = buildSlotInstances(st0.slots, startOfWeek(new Date(target.start)), 7);
      const rp = restorePlanned({ allocations: st0.allocations, instances: insts, allocId: target.id });
      if (!rp.ok) {
        toast(rp.reason, 'error');
        break;
      }
      update((s2) => ({ ...s2, allocations: rp.allocations }));
      toast(rp.truncated ? `已还原计划时长（受时段限制为 ${rp.applied} 分钟）` : '已还原计划时长');
      break;
    }
    case 'reset':
      resetToSeed();
      lastResult = null;
      toast('已恢复演示数据');
      break;
    case 'close-modal':
      if (e.target.closest('.modal') && !e.target.closest('.x') && action === 'close-modal' && e.target !== el) {
        // 点击弹窗内部不关闭
        break;
      }
      ui.taskModal = null;
      ui.slotModal = null;
      ui.settingsOpen = false;
      ui.attrsOpen = false;
      render();
      break;
    default:
      break;
  }
});

/* ---------------- 任务卡片 -> 时段（HTML5 拖放） ---------------- */

document.addEventListener('dragstart', (e) => {
  const card = e.target.closest('[data-task]');
  if (!card) return;
  e.dataTransfer.setData('text/plain', card.dataset.task);
  e.dataTransfer.effectAllowed = 'copy';
  card.classList.add('dragging');
});

document.addEventListener('dragend', (e) => {
  const card = e.target.closest('[data-task]');
  if (card) card.classList.remove('dragging');
});

document.addEventListener('dragover', (e) => {
  if (e.target.closest('[data-slot-inst]')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});

document.addEventListener('drop', (e) => {
  const slot = e.target.closest('[data-slot-inst]');
  if (!slot) return;
  e.preventDefault();
  const taskId = e.dataTransfer.getData('text/plain');
  if (taskId) placeManual(taskId, slot.dataset.slotInst);
});

/* ---------------- 指针拖拽：移动分片 / 拉伸分片 / 拉伸时段 ---------------- */

let ptr = null; // 正在进行的拖拽
let suppressClick = false; // 拖拽结束后吞掉紧随其后的 click

/**
 * 拖拽结束时浏览器会补发一次 click，需要吞掉它。
 * 但只能吞「紧接着的那一次」——否则你拖完之后下一次正常点击也会被吃掉。
 * 浏览器补发的 click 与 mouseup 在同一个事件循环任务里，所以 setTimeout(0) 之后解除即可。
 */
function armClickSuppression() {
  suppressClick = true;
  setTimeout(() => {
    suppressClick = false;
  }, 0);
}

/**
 * 时段的「时间区域」元素：
 *   周视图是 .slot-body（带 data-body）
 *   日视图没有 body，时段块本身就是时间区域
 * 两种视图的像素/分钟不同，所以比例一律用「元素高度 ÷ 时段时长」反推，
 * 不写死常量——这样加新视图也不用改拖拽代码。
 */
function timeArea(slotEl) {
  return slotEl?.querySelector('[data-body]') || slotEl || null;
}

function rectOf(slotEl) {
  const area = timeArea(slotEl);
  return area ? area.getBoundingClientRect() : null;
}

function pxPerMinute(slotEl, instances) {
  const inst = instances.find((i) => i.id === slotEl.dataset.slotInst);
  const rect = rectOf(slotEl);
  if (!inst || !rect || !rect.height) return PX_PER_MIN;
  const duration = minutesBetween(inst.start, inst.end) || 1;
  return rect.height / duration;
}

function currentInstances(state) {
  const anchor = ui.view === 'day' ? ui.dayDate : ui.weekStart;
  return buildSlotInstances(state.slots, startOfWeek(anchor), 7);
}

/**
 * 找指针下的时段。
 * 日视图里分片和时段是同级元素，指针压在其他分片上时 closest 会落空，
 * 所以先按 DOM 包含找，找不到再按几何位置兜底。
 */
function findSlotAt(clientX, clientY) {
  let el = null;
  try {
    el = document.elementFromPoint?.(clientX, clientY) ?? null;
  } catch {
    el = null; // 某些环境（含 jsdom）未实现，退化到几何命中
  }
  const direct = el?.closest?.('[data-slot-inst]');
  if (direct) return direct;

  for (const slotEl of document.querySelectorAll('[data-slot-inst]')) {
    const r = rectOf(slotEl);
    if (!r || !r.height) continue;
    if (clientY >= r.top && clientY <= r.bottom && clientX >= r.left - 6 && clientX <= r.right + 6) {
      return slotEl;
    }
  }
  return null;
}

function clearGhost() {
  document.querySelectorAll('.drag-ghost').forEach((g) => g.remove());
}

/** 落点预览：topPx 由「目标偏移分钟 × 目标比例」算好再传进来 */
function showGhost(slotEl, topPx, height, draggingId) {
  const area = timeArea(slotEl);
  if (!area) return;
  let ghost = document.querySelector('.drag-ghost');
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
  }
  const maxTop = Math.max(0, area.clientHeight - height);
  ghost.style.top = `${Math.round(Math.max(0, Math.min(topPx, maxTop)))}px`;
  ghost.style.height = `${Math.round(height)}px`;
  ghost.dataset.for = draggingId ?? '';
  if (ghost.parentElement !== area) area.appendChild(ghost);
}

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  // 点在按钮/链接上时不要触发拖拽
  if (e.target.closest('[data-action]')) return;

  const rzAlloc = e.target.closest('[data-alloc-rz]');
  const rzSlot = e.target.closest('[data-slot-rz]');
  const allocEl = e.target.closest('[data-alloc]');
  const state = getState();
  const instances = currentInstances(state);

  if (rzAlloc) {
    const allocId = rzAlloc.dataset.allocRz;
    const el = document.querySelector(`[data-alloc="${allocId}"]`);
    // 日视图里分片与时段同级，closest 找不到，需要几何兜底
    const slotEl = el?.closest('[data-slot-inst]') || findSlotAt(e.clientX, e.clientY);
    const scale = slotEl ? pxPerMinute(slotEl, instances) || PX_PER_MIN : PX_PER_MIN;
    ptr = {
      mode: 'resize-alloc',
      allocId,
      startY: e.clientY,
      startH: el ? el.offsetHeight : 30,
      scale,
      instances,
      moved: 0,
    };
    e.preventDefault();
    return;
  }

  if (rzSlot) {
    const bodyEl = document.querySelector(`[data-slot-rz="${rzSlot.dataset.slotRz}"]`)?.closest('.slot');
    const area = bodyEl ? timeArea(bodyEl) : null;
    ptr = {
      mode: 'resize-slot',
      slotId: rzSlot.dataset.slotRz,
      startY: e.clientY,
      startH: area ? area.offsetHeight : 100,
      instances,
      moved: 0,
    };
    e.preventDefault();
    return;
  }

  if (allocEl) {
    const slotEl = allocEl.closest('[data-slot-inst]') || findSlotAt(e.clientX, e.clientY);
    let grabMin = 0;
    if (slotEl) {
      const rect = rectOf(slotEl);
      const inst = instances.find((i) => i.id === slotEl.dataset.slotInst);
      // 记住「抓住的是分片内的第几分钟」，落下时保持手感一致
      grabMin = grabOffsetMin({
        pointerY: e.clientY,
        allocTop: allocEl.getBoundingClientRect().top,
        areaHeight: rect ? rect.height : 0,
        slotDurationMin: inst ? minutesBetween(inst.start, inst.end) : 0,
      });
    }
    ptr = {
      mode: 'move-alloc',
      allocId: allocEl.dataset.alloc,
      startY: e.clientY,
      height: allocEl.offsetHeight,
      grabMin,
      instances,
      moved: 0,
    };
    e.preventDefault();
  }
});

document.addEventListener('mousemove', (e) => {
  if (!ptr) return;
  const dy = e.clientY - ptr.startY;
  ptr.moved = Math.max(ptr.moved, Math.abs(dy), Math.abs(e.movementX || 0));

  if (ptr.mode === 'move-alloc' && ptr.moved > 4) {
    const slotEl = findSlotAt(e.clientX, e.clientY);
    if (slotEl) {
      const scale = pxPerMinute(slotEl, ptr.instances) || PX_PER_MIN;
      const rect = rectOf(slotEl);
      const inst = ptr.instances.find((i) => i.id === slotEl.dataset.slotInst);
      const offsetMin = pointerToOffsetMin({
        pointerY: e.clientY,
        areaTop: rect ? rect.top : 0,
        areaHeight: rect ? rect.height : 0,
        slotDurationMin: inst ? minutesBetween(inst.start, inst.end) : 0,
        grabMin: ptr.grabMin,
      });
      showGhost(slotEl, offsetMin * scale, ptr.height, ptr.allocId);
    } else {
      clearGhost();
    }
    document.body.classList.add('dragging-alloc');
    return;
  }

  if (ptr.mode === 'resize-alloc' && ptr.moved > 2) {
    const el = document.querySelector(`[data-alloc="${ptr.allocId}"]`);
    if (el) el.style.height = `${Math.max(15, ptr.startH + dy)}px`;
    document.body.classList.add('resizing');
    return;
  }

  if (ptr.mode === 'resize-slot' && ptr.moved > 2) {
    const el = document.querySelector(`[data-slot-rz="${ptr.slotId}"]`)?.closest('.slot');
    const area = el ? timeArea(el) : null;
    if (area) area.style.height = `${Math.max(24, ptr.startH + dy)}px`;
    document.body.classList.add('resizing');
  }
});

document.addEventListener('mouseup', (e) => {
  if (!ptr) return;
  const p = ptr;
  ptr = null;
  document.body.classList.remove('dragging-alloc', 'resizing');
  const dy = e.clientY - p.startY;
  clearGhost();

  const state = getState();
  const instances = p.instances ?? currentInstances(state);

  if (p.mode === 'move-alloc') {
    if (p.moved <= 4) return; // 视为点击，交给 click 处理选择
    armClickSuppression();

    const slotEl = findSlotAt(e.clientX, e.clientY);
    if (!slotEl) {
      toast('要拖到某个时段里才能改时间', 'error');
      render();
      return;
    }

    const rect = rectOf(slotEl);
    const inst = instances.find((i) => i.id === slotEl.dataset.slotInst);
    const offsetMin = pointerToOffsetMin({
      pointerY: e.clientY,
      areaTop: rect ? rect.top : 0,
      areaHeight: rect ? rect.height : 0,
      slotDurationMin: inst ? minutesBetween(inst.start, inst.end) : 0,
      grabMin: p.grabMin,
    });

    const r = moveAllocation({
      allocations: state.allocations,
      instances,
      allocId: p.allocId,
      targetInstId: slotEl.dataset.slotInst,
      offsetMin,
    });
    if (!r.ok) {
      toast(r.error, 'error');
      render();
      return;
    }
    update((s) => ({ ...s, allocations: r.allocations }));
    toast('已移动，并锁定该分片');
    return;
  }

  if (p.mode === 'resize-alloc') {
    if (p.moved <= 2) {
      render();
      return;
    }
    armClickSuppression();
    const alloc = state.allocations.find((a) => a.id === p.allocId);
    const task = alloc ? state.tasks.find((t) => t.id === alloc.taskId) : null;
    // 用按下时算好的比例：日视图 1.1px/min 与周视图 0.8px/min 不能混用
    const scale = p.scale || PX_PER_MIN;

    const r = resizeAllocation({
      allocations: state.allocations,
      instances,
      allocId: p.allocId,
      deltaMin: dy / scale,
      minChunk: task?.minChunk ?? 5,
      maxChunk: task?.maxChunk ?? 480,
    });
    if (!r.ok) {
      toast(r.error, 'error');
      render();
      return;
    }
    update((s) => ({ ...s, allocations: r.allocations }));
    toast('已调整时长');
    return;
  }

  if (p.mode === 'resize-slot') {
    if (p.moved <= 2) {
      render();
      return;
    }
    armClickSuppression();
    const slot = state.slots.find((s) => s.id === p.slotId);
    if (!slot) {
      render();
      return;
    }
    const slotEl = document.querySelector(`[data-slot-rz="${slot.id}"]`)?.closest('.slot');
    const scale = slotEl ? pxPerMinute(slotEl, instances) || PX_PER_MIN : PX_PER_MIN;
    const newEnd = resizeSlotEnd(slot, dy / scale);
    if (newEnd === slot.end) {
      render();
      return;
    }
    // 缩短时段后，超出新边界的分片会被移出
    const overflow = state.allocations.filter(
      (a) => a.slotId === slot.id && new Date(a.end) > atDateTime(a.date, newEnd),
    );
    update((s) => ({
      ...s,
      slots: s.slots.map((x) => (x.id === slot.id ? { ...x, end: newEnd } : x)),
      allocations: s.allocations.filter((a) => !overflow.some((o) => o.id === a.id)),
    }));
    toast(
      overflow.length
        ? `结束时间改为 ${newEnd}，移出了 ${overflow.length} 个放不下的分片`
        : `结束时间改为 ${newEnd}`,
      overflow.length ? 'warn' : 'info',
    );
  }
});

/* ---------------- 启动 ---------------- */

subscribe(() => {
  // 状态变化时重绘（双击保护）
  if (document.getElementById('app')) render();
});

document.title = SITE_TITLE;
{
  let meta = document.querySelector('meta[name="description"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'description';
    document.head.appendChild(meta);
  }
  meta.content = SITE.description;
}

render();
window.__PLANNER__ = { getState, update, schedule, ui, focus };
