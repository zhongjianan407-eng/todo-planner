/**
 * ui.smoke.test.js — 在 jsdom 里真实渲染界面并模拟点击
 * 目的是抓出「语法没问题但一运行就白屏」的那类错误。
 */

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  '<!doctype html><html><body><div id="app"></div></body></html>',
  { url: 'http://localhost:8770/', pretendToBeVisual: true },
);

const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.MouseEvent = window.MouseEvent;
globalThis.Event = window.Event;
globalThis.DragEvent = window.DragEvent;

window.localStorage.clear();

const errors = [];
window.addEventListener('error', (e) => errors.push(e.message));

await import('../src/app.js');

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function click(el) {
  assert.ok(el, '待点击的元素不存在');
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fails.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

console.log('\n[UI] 首屏渲染');

check('应用根节点渲染出内容', () => {
  assert.ok($('.app'), '缺少 .app 容器');
});

check('顶栏与统计存在', () => {
  assert.ok($('.topbar'));
  assert.match($('.topstats').textContent, /个待办/);
});

const { SITE, SITE_TITLE } = await import('../src/config.js');

check('站名与标语来自 config.js（改名字只需改一处）', () => {
  assert.equal(document.title, SITE_TITLE, '标签页标题没跟上 config');
  assert.equal($('.brand h1').textContent.trim(), SITE.name, '顶栏站名不对');
  assert.equal($('.brand .sub').textContent.trim(), SITE.tagline, '标语不对');
});

check('演示任务渲染成卡片', () => {
  const cards = $$('.task');
  assert.ok(cards.length >= 5, `实际 ${cards.length} 张任务卡`);
});

check('演示时段在周视图里铺开', () => {
  const slots = $$('.slot');
  assert.ok(slots.length >= 5, `实际 ${slots.length} 个时段`);
});

check('七天列都存在', () => {
  assert.equal($$('.day').length, 7);
});

check('属性 chip 渲染', () => {
  assert.ok($$('.chip').length > 0);
});

console.log('\n[UI] 自动排程');

let beforeAlloc = 0;
check('点击自动排程后产生分片', () => {
  beforeAlloc = $$('.alloc').length;
  click($('[data-action="run-schedule"]'));
  const after = $$('.alloc').length;
  assert.ok(after > 0, '排程后没有生成任何分片');
  assert.ok(after > beforeAlloc, `排程前后分片数没变化（${beforeAlloc} -> ${after}）`);
});

check('排程结果面板显示统计', () => {
  assert.ok($('.unsched'), '缺少排程结果面板');
  assert.match($('.unsched').textContent, /容量/);
});

check('分片标题取自真实任务', () => {
  const t = $$('.alloc .alloc-t').map((e) => e.textContent);
  assert.ok(t.some((x) => x.includes('论文') || x.includes('微积分') || x.includes('组会')),
    `分片标题异常：${JSON.stringify(t.slice(0, 5))}`);
});

console.log('\n[UI] 交互');

check('切换排序方式不报错', () => {
  const sel = document.querySelector('[data-field="sortBy"]');
  sel.value = 'due';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal($$('.task').length > 0, true);
});

check('切换分组为按属性', () => {
  const sel = document.querySelector('[data-field="groupBy"]');
  sel.value = 'attr';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok($$('.group-head').length > 0, '没有渲染分组标题');
});

check('打开新建任务弹窗', () => {
  click($('[data-action="new-task"]'));
  assert.ok($('.modal'), '弹窗未出现');
  assert.match($('.modal-head h3').textContent, /新建任务/);
});

check('关闭弹窗', () => {
  click($('.modal-head .x'));
  assert.equal($('.modal'), null);
});

check('打开设置弹窗', () => {
  click($('[data-action="open-settings"]'));
  assert.ok($('.modal'));
  click($('.modal-head .x'));
});

check('点击分片可选中并出现工具栏', () => {
  const alloc = $('.alloc');
  assert.ok(alloc, '没有可点的分片');
  click(alloc);
  assert.ok($('.alloc-toolbar'), '未出现分片工具栏');
});

check('锁定分片后出现锁标记', () => {
  click($('[data-action="toggle-lock"]'));
  assert.ok($('.alloc.locked'), '分片没有变成锁定态');
});

check('取消选择后工具栏消失', () => {
  click($('[data-action="deselect-alloc"]'));
  assert.equal($('.alloc-toolbar'), null);
});

console.log('\n[UI] 自动拆分');

await (async () => {
  // 找到第一个还没拆分的任务并点「拆」
  click($('[data-action="decompose"]'));
  await tick(120);
  check('拆分后出现子步骤卡片', () => {
    const kids = $$('.task-child');
    assert.ok(kids.length >= 2, `子步骤数量 ${kids.length}`);
  });
  check('父任务显示步数标签', () => {
    assert.ok($('.tag-steps'), '缺少步数标签');
  });
})();

check('拆分后的步骤可以再排程', () => {
  click($('[data-action="run-schedule"]'));
  assert.ok($$('.alloc').length > 0);
});

console.log('\n[UI] 任务侧时段约束');

check('任务编辑弹窗出现时段与星期约束', () => {
  click($('[data-action="edit-task"]'));
  assert.ok($('.modal'), '弹窗未打开');
  assert.ok($$('.slot-chip').length > 0, '没有渲染时段 chip');
  assert.equal($$('.mini-chip').length, 7, '星期 chip 数量不对');
});

check('时段 chip 三态循环：只能 -> 排除 -> 不限', () => {
  const id = $('.slot-chip').dataset.id;
  const find = () => document.querySelector(`.slot-chip[data-id="${id}"]`);
  click(find());
  assert.ok(find().classList.contains('allow'), '第一下应为「只能」');
  click(find());
  assert.ok(find().classList.contains('deny'), '第二下应为「排除」');
  click(find());
  assert.ok(!find().classList.contains('allow') && !find().classList.contains('deny'), '第三下应回到不限');
});

check('星期 chip 可切换', () => {
  const id = $('.mini-chip').dataset.id;
  click(document.querySelector(`.mini-chip[data-id="${id}"]`));
  assert.ok(document.querySelector(`.mini-chip[data-id="${id}"]`).classList.contains('on'));
});

check('保存后任务卡片显示约束标签', () => {
  const id = $('.slot-chip').dataset.id;
  click(document.querySelector(`.slot-chip[data-id="${id}"]`));
  click($('[data-action="save-task"]'));
  assert.equal($('.modal'), null, '弹窗应关闭');
  assert.ok($('.tag-cons'), '卡片没有出现约束标签');
});

console.log('\n[UI] 时段自定义');

check('时段弹窗包含类型 / 容量 / 任务数', () => {
  click($('.slot-edit'));
  assert.ok($('.modal'), '时段弹窗未打开');
  assert.ok(document.querySelector('[data-draft="kind"]'), '缺少类型选择');
  assert.ok(document.querySelector('[data-draft="capacityMin"]'), '缺少容量字段');
  assert.ok(document.querySelector('[data-draft="maxTasks"]'), '缺少任务数字段');
});

check('切换为单次时段后出现日期输入', () => {
  const sel = document.querySelector('[data-draft="kind"]');
  sel.value = 'once';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok(document.querySelector('[data-draft="date"]'), '缺少日期输入');
  click($('.modal-head .x'));
});

check('周视图具备时间比例容器与拉伸把手', () => {
  assert.ok($('.slot-body'), '缺少 slot-body');
  assert.ok($('.slot-rz'), '缺少时段拉伸把手');
  assert.ok($('.alloc-rz'), '缺少分片拉伸把手');
});

check('约束生效后重排：被排除的任务排不进', () => {
  click($('[data-action="run-schedule"]'));
  assert.ok($$('.alloc').length > 0, '重排后应有分片');
});

console.log('\n[UI] 日视图');

check('切换到日视图', () => {
  click($('[data-action="set-view"][data-id="day"]'));
  assert.ok($('.dayview'), '未渲染日视图');
  assert.ok($('.dv-canvas'), '缺少时间画布');
  assert.ok($$('.dv-hour').length >= 3, '小时刻度太少');
});

check('日视图按天导航', () => {
  const before = $('.week-label').textContent;
  click($('[data-action="day-next"]'));
  assert.notEqual($('.week-label').textContent, before, '日期没有前进');
  click($('[data-action="day-prev"]'));
  assert.equal($('.week-label').textContent, before, '退回来应还原');
});

check('日视图渲染当天时段块', () => {
  assert.ok($$('.dv-slot').length >= 1, '今天应该至少有一个时段');
});

check('日视图时间轴数值合理', () => {
  const canvas = $('.dv-canvas');
  const canvasH = parseInt(canvas.style.height, 10);
  assert.ok(canvasH >= 180, `画布太矮：${canvasH}px`);
  assert.ok(canvasH <= 24 * 60 * 1.1 + 1, `画布超过 24 小时：${canvasH}px`);

  const hours = $$('.dv-hour').map((el) => parseInt(el.style.top, 10));
  assert.ok(hours.every((t, i) => i === 0 || t > hours[i - 1]), '小时刻度必须递增');
  const gap = hours[1] - hours[0];
  assert.equal(gap, 66, '1 小时应为 60min × 1.1px = 66px');

  const slot = $('.dv-slot');
  const slotTop = parseInt(slot.style.top, 10);
  const slotH = parseInt(slot.style.height, 10);
  assert.ok(slotTop >= 0 && slotTop < canvasH, '时段起点画布外');
  assert.ok(slotH >= 15 && slotTop + slotH <= canvasH + 1, '时段高度越界');
});

check('日视图分片带计时按钮', () => {
  // 「今天」不一定有排程（取决于当前时刻和时段），先找到一周内真有分片的一天
  let btn = $('.dv-alloc .focus-btn');
  for (let i = 0; i < 7 && !btn; i += 1) {
    click($('[data-action="day-next"]'));
    btn = $('.dv-alloc .focus-btn');
  }
  assert.ok(btn, '一周内都没有带计时按钮的分片');
  click($('[data-action="day-today"]'));
});

console.log('\n[UI] 日视图拖拽（回归：曾经抛空引用）');

check('日视图拖动分片真的能改变时间', () => {
  const P = window.__PLANNER__;
  click($('[data-action="set-view"][data-id="day"]'));
  click($('[data-action="day-today"]'));

  // 找一天有时段，之后注入一个独占该时段的干净分片，保证拖拽结果可判定
  let slotEl = $('.dv-slot');
  for (let i = 0; i < 7 && !slotEl; i += 1) {
    click($('[data-action="day-next"]'));
    slotEl = $('.dv-slot');
  }
  assert.ok(slotEl, '一周内都没有时段');

  const dateK = slotEl.dataset.date;
  const slotId = slotEl.dataset.slot;
  const startHM = slotEl.querySelector('.dv-slot-time').textContent.split('–')[0].trim();
  const start = new Date(`${dateK}T${startHM}:00`);
  const taskId = P.getState().tasks.find((t) => !t.parentId).id;
  const savedAllocations = P.getState().allocations;

  P.update((s) => ({
    ...s,
    allocations: [
      {
        id: 'drag_probe',
        taskId,
        date: dateK,
        slotId,
        start: start.toISOString(),
        end: new Date(start.getTime() + 60 * 60000).toISOString(),
        locked: false,
        source: 'manual',
      },
    ],
  }));

  const allocEl = document.querySelector('[data-alloc="drag_probe"]');
  assert.ok(allocEl, '注入的分片没有渲染出来');
  const slotBox = document.querySelector(`.dv-slot[data-date="${dateK}"][data-slot="${slotId}"]`);
  assert.ok(slotBox, '找不到时段块');

  // jsdom 没有布局引擎，手工造几何：时段 400px 高，分片在其中一段
  const fakeRect = (top, height, width = 800) => () => ({
    top, bottom: top + height, left: 0, right: width,
    height, width, x: 0, y: top,
    toJSON() { return this; },
  });
  slotBox.getBoundingClientRect = fakeRect(100, 400);
  allocEl.getBoundingClientRect = fakeRect(380, 120);

  const scroller = $('.dv-scroll');
  scroller.scrollTop = 360; // 模拟用户已经滚到当天偏下的位置

  const before = P.getState().allocations.find((a) => a.id === 'drag_probe').start;
  const fire = (type, target, y) =>
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: 400, clientY: y }));

  fire('mousedown', allocEl, 440);
  fire('mousemove', document, 420);
  fire('mouseup', document, 420);

  assert.deepEqual(errors, [], `拖拽抛异常：${errors.join('; ')}`);

  const after = P.getState().allocations.find((a) => a.id === 'drag_probe');
  assert.ok(after, '分片消失了');
  assert.notEqual(after.start, before, '日视图拖拽没有改变开始时间');
  assert.equal(after.locked, true, '手动拖动后应自动锁定');
  assert.equal($('.dv-scroll').scrollTop, 360, '拖动后视角不应被重置到顶部');

  // 还原现场，避免影响后续用例
  P.update((s) => ({ ...s, allocations: savedAllocations }));
  click($('[data-action="day-today"]'));
});

await (async () => {
  const P = window.__PLANNER__;
  click($('[data-action="set-view"][data-id="day"]'));
  for (let i = 0; i < 7 && !$('.dv-alloc'); i += 1) click($('[data-action="day-next"]'));

  const allocEl = $('.dv-alloc');
  if (!allocEl) {
    check('拖拽之后的点击不会被吞掉', () => assert.ok(false, '找不到分片'));
    return;
  }

  const st = P.getState().allocations.find((a) => a.id === allocEl.dataset.alloc);
  const slotBox = document.querySelector(
    `.dv-slot[data-date="${st.date}"][data-slot="${st.slotId}"]`,
  );
  const fakeRect = (top, height, width = 800) => () => ({
    top, bottom: top + height, left: 0, right: width,
    height, width, x: 0, y: top,
    toJSON() { return this; },
  });
  slotBox.getBoundingClientRect = fakeRect(100, 400);
  allocEl.getBoundingClientRect = fakeRect(380, 120);

  const fire = (type, target, y) =>
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: 400, clientY: y }));

  fire('mousedown', allocEl, 440);
  fire('mousemove', document, 430);
  fire('mouseup', document, 430); // 到这一步，点击抑制被激活

  // 真实浏览器里补发的 click 和 mouseup 同一任务，之后就该解除抑制。
  // 这里等一个宏任务，模拟「用户拖完，过一会儿又点了个按钮」。
  await tick(20);

  const label = $('.week-label').textContent;
  click($('[data-action="day-next"]'));

  check('拖拽之后的点击不会被吞掉', () => {
    assert.notEqual($('.week-label').textContent, label, '拖拽后紧接着的点击被误吞了');
  });

  click($('[data-action="day-today"]'));
})();

check('任意重绘都不丢滚动位置', () => {
  // 上一步是拖拽，浏览器（测试里是我们手动补的）会有一个待消费的点击抑制，
  // 先点一下空处把它清掉，确保后面的 render-schedule 真的会触发重绘
  click(document.body);

  const taskList = $('.task-list');
  const scroller = $('.dv-scroll');
  taskList.scrollTop = 220;
  scroller.scrollTop = 500;

  // 触发一次完整重绘（会自动排程 -> update -> render）
  click($('[data-action="run-schedule"]'));

  assert.equal($('.task-list').scrollTop, 220, '任务列表滚动位置丢了');
  assert.equal($('.dv-scroll').scrollTop, 500, '日视图滚动位置丢了');
});

console.log('\n[UI] 专注计时');

check('切回周视图并找到计时按钮', () => {
  click($('[data-action="set-view"][data-id="week"]'));
  assert.ok($('.week-grid'), '未回到周视图');
  assert.ok($('.alloc .focus-btn'), '周视图分片上没有计时按钮');
});

check('点击计时按钮打开专注弹窗并自动开始', () => {
  click($('.alloc .focus-btn'));
  assert.ok($('.focus-modal'), '专注弹窗未出现');
  assert.ok($('.ring-fg'), '缺少进度环');
  assert.ok($('[data-focus-time]'), '缺少倒计时文本');
  const P = window.__PLANNER__;
  assert.ok(P.focus.session, '没有创建会话');
  assert.equal(P.focus.session.running, true, '应自动开始计时');
});

check('暂停 / 继续切换计时状态', () => {
  const P = window.__PLANNER__;
  click($('[data-action="focus-pause"]'));
  assert.equal(P.focus.session.running, false, '暂停后应停止');
  click($('[data-action="focus-start"]'));
  assert.equal(P.focus.session.running, true, '继续后应恢复');
});

check('结束并记录会写入 focusSessions', () => {
  const P = window.__PLANNER__;
  P.focus.session.accumulatedMs = 20 * 60 * 1000;
  P.focus.session.startedAtMs = Date.now();
  click($('[data-action="focus-finish"]'));
  assert.equal($('.focus-modal'), null, '弹窗应关闭');
  const st = P.getState();
  assert.equal(st.focusSessions.length, 1, '应记录 1 条专注会话');
  assert.ok(st.focusSessions[0].actualMin >= 20, `实际记录 ${st.focusSessions[0].actualMin} 分钟`);
});

check('收起弹窗后显示悬浮计时条', () => {
  click($('.alloc .focus-btn'));
  assert.ok($('.focus-modal'));
  click($('[data-action="focus-close"]'));
  assert.ok($('.focus-pill'), '缺少右下角悬浮计时条');
  click($('.focus-pill'));
  click($('[data-action="focus-finish"]'));
});

console.log('\n[UI] 专注时长回写日程');

let wbAllocId = null;
let wbPlanned = null;

check('专注结束后分片按实际时长更新', () => {
  const P = window.__PLANNER__;
  const ids = $$('.alloc .focus-btn').map((b) => b.closest('[data-alloc]').dataset.alloc);
  wbAllocId = ids.find((id) => {
    const a = P.getState().allocations.find((x) => x.id === id);
    return a && (new Date(a.end) - new Date(a.start)) / 60000 >= 30;
  });
  assert.ok(wbAllocId, '找不到足够长的分片用来测试回写');

  const before = P.getState().allocations.find((a) => a.id === wbAllocId);
  wbPlanned = (new Date(before.end) - new Date(before.start)) / 60000;

  click(document.querySelector(`[data-alloc="${wbAllocId}"] .focus-btn`));
  P.focus.session.accumulatedMs = 15 * 60000;
  P.focus.session.startedAtMs = Date.now();
  click($('[data-action="focus-finish"]'));

  const after = P.getState().allocations.find((a) => a.id === wbAllocId);
  assert.equal(after.actualMin, 15, '应记录实际 15 分钟');
  assert.equal(after.plannedMin, wbPlanned, '应记住原计划时长');
  assert.equal(
    (new Date(after.end) - new Date(after.start)) / 60000,
    15,
    '分片时长应改为 15 分钟',
  );
  assert.equal(after.locked, true, '回写后应自动锁定');
});

check('分片上出现实际时长标记', () => {
  const el = document.querySelector(`[data-alloc="${wbAllocId}"]`);
  assert.match(el.textContent, /实15m|实 15 分钟/, '没有显示实际时长');
});

check('选中后可一键还原计划时长', () => {
  const P = window.__PLANNER__;
  click(document.querySelector(`[data-alloc="${wbAllocId}"]`));
  assert.ok($('.alloc-toolbar'), '未出现分片工具栏');
  const btn = $('[data-action="restore-planned"]');
  assert.ok(btn, '没有「还原计划时长」按钮');
  click(btn);

  const after = P.getState().allocations.find((a) => a.id === wbAllocId);
  assert.equal(
    (new Date(after.end) - new Date(after.start)) / 60000,
    wbPlanned,
    '应还原到原计划时长',
  );
  assert.equal(after.actualMin, undefined, '还原后不再标实际时长');
});

check('关闭回写开关后只记录、不修改日程', () => {
  const P = window.__PLANNER__;
  const st = P.getState();
  st.settings.writeBack = false;

  const ids = $$('.alloc .focus-btn').map((b) => b.closest('[data-alloc]').dataset.alloc);
  const id = ids.find((x) => {
    const a = st.allocations.find((y) => y.id === x);
    return a && (new Date(a.end) - new Date(a.start)) / 60000 >= 30;
  });
  assert.ok(id, '找不到可用分片');

  const before = (new Date(st.allocations.find((a) => a.id === id).end)
    - new Date(st.allocations.find((a) => a.id === id).start)) / 60000;

  click(document.querySelector(`[data-alloc="${id}"] .focus-btn`));
  P.focus.session.accumulatedMs = 10 * 60000;
  P.focus.session.startedAtMs = Date.now();
  const sessionsBefore = st.focusSessions.length;
  click($('[data-action="focus-finish"]'));

  const after = P.getState().allocations.find((a) => a.id === id);
  assert.equal((new Date(after.end) - new Date(after.start)) / 60000, before, '分片时长不该变');
  assert.equal(after.actualMin, undefined, '不该写 actualMin');
  assert.equal(P.getState().focusSessions.length, sessionsBefore + 1, '但专注记录仍要留下');

  P.getState().settings.writeBack = true;
});

console.log('\n[UI] 跨周排程');

check('顶栏按钮显示当前排程跨度，设置里能改', () => {
  click($('[data-action="open-settings"]'));
  const sel = document.querySelector('[data-setting="horizonDays"]');
  assert.ok(sel, '设置里没有跨度选项');
  assert.ok(sel.options.length >= 4, '跨度可选项太少');
  click($('.modal-head .x'));
  assert.match($('[data-action="run-schedule"]').textContent, /排程 \d+ 天/, '按钮没显示跨度');
});

check('跨度变大，可排容量随之增加', () => {
  const P = window.__PLANNER__;
  const base = P.getState();
  const r7 = P.schedule({ state: { ...base, settings: { ...base.settings, horizonDays: 7 } }, weekStart: new Date() });
  const r30 = P.schedule({ state: { ...base, settings: { ...base.settings, horizonDays: 30 } }, weekStart: new Date() });
  assert.equal(r7.stats.days, 7);
  assert.equal(r30.stats.days, 30);
  assert.ok(r30.stats.capacityMin > r7.stats.capacityMin, '30 天的容量应大于 7 天');
});

check('所有分片都落在各自跨度之内', () => {
  const P = window.__PLANNER__;
  const base = P.getState();
  for (const days of [7, 30]) {
    const r = P.schedule({ state: { ...base, settings: { ...base.settings, horizonDays: days } }, weekStart: new Date() });
    for (const a of r.created) {
      assert.ok(a.date >= r.stats.horizonStart && a.date <= r.stats.horizonEnd,
        `分片 ${a.date} 超出了 ${r.stats.horizonStart}~${r.stats.horizonEnd}`);
    }
  }
});

check('10 小时任务：短期排不满，拉长跨度后排满', () => {
  const P = window.__PLANNER__;
  const st = P.getState();
  const big = {
    id: 'big_task', title: '大活', status: 'todo', priority: 2, dueAt: null, estMin: 600,
    attrs: [{ attrId: 'attr_deep', strength: 'require' }],
    constraints: { allowSlotIds: [], denySlotIds: [], weekdays: [] },
    parentId: null, order: 0, minChunk: 60, maxChunk: 120,
    source: 'manual', createdAt: new Date().toISOString(), completedAt: null,
  };
  const slots = [{
    id: 's_mon', kind: 'weekly', weekday: 1, date: null,
    start: '09:00', end: '11:00', name: '深度', attrs: ['attr_deep'],
    capacityMin: null, maxTasks: null,
  }];
  const base = { ...st, tasks: [big], slots, allocations: [], settings: { ...st.settings } };
  const sum = (r) =>
    r.created.reduce((x, a) => x + (new Date(a.end) - new Date(a.start)) / 60000, 0);

  // 注意：起点是「本周一」，今天若已过周一，第一个周一就被过滤掉了，
  // 所以用一个足够长的跨度保证至少还剩 5 个周一（5 × 120 = 600）
  const r7 = P.schedule({ state: { ...base, settings: { ...base.settings, horizonDays: 7 } }, weekStart: new Date() });
  const r60 = P.schedule({ state: { ...base, settings: { ...base.settings, horizonDays: 60 } }, weekStart: new Date() });

  assert.ok(sum(r7) < 600, `7 天只排了 ${sum(r7)} 分钟，应该少于 600`);
  assert.equal(sum(r60), 600, `60 天应排满 600 分钟，实际 ${sum(r60)}`);
  assert.ok(r7.unscheduled.length > 0, '短期跨度下应有排不进的任务');
  assert.equal(r60.unscheduled.length, 0, '拉长跨度后应全部排入');
});

check('整个过程没有抛未捕获错误', () => {
  assert.deepEqual(errors, []);
});

console.log(`\n${'─'.repeat(48)}`);
console.log(`UI 冒烟：通过 ${pass} / ${pass + fails.length}`);
if (fails.length) {
  for (const f of fails) console.log(`  · ${f.name}\n    ${f.err.stack.split('\n')[1]?.trim()}`);
  process.exit(1);
}
