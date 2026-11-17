/**
 * decompose.js — 任务自动拆分
 *
 * 两条路径：
 *  1) LLM（需在设置里填 baseUrl / apiKey / model）——结构化 JSON 输出
 *  2) 本地规则兜底——按任务标题关键词匹配模板，按权重分配工时
 *
 * 设计要点（对应需求 3）：
 *  - 拆出的步骤必须带「预计耗时」，否则排程无从下手
 *  - 步骤继承父任务的 require 属性，保证仍能匹配到同类时段
 *  - 步骤数受 maxSteps 限制，权重重新归一化
 *  - LLM 失败绝不阻塞：静默降级到本地规则，并回传 warning
 */

import { uid } from './model.js';

/* 模板：ratio 之和为 1，attr 为建议属性（作为 prefer 附加） */
const TEMPLATES = [
  {
    key: 'writing',
    match: /写|论文|报告|文档|稿|文章|方案|总结|申请/,
    steps: [
      { title: '明确目标与搭大纲', ratio: 0.15, attr: 'attr_deep' },
      { title: '收集与整理素材', ratio: 0.2, attr: 'attr_study' },
      { title: '写初稿', ratio: 0.4, attr: 'attr_deep' },
      { title: '修订与润色', ratio: 0.15, attr: 'attr_deep' },
      { title: '校对与交付', ratio: 0.1, attr: 'attr_light' },
    ],
  },
  {
    key: 'study',
    match: /复习|考试|背|预习|学习|课程|章节|习题/,
    steps: [
      { title: '通读建立框架', ratio: 0.2, attr: 'attr_study' },
      { title: '精读核心内容', ratio: 0.4, attr: 'attr_study' },
      { title: '做题 / 自测', ratio: 0.25, attr: 'attr_study' },
      { title: '错题复盘', ratio: 0.15, attr: 'attr_study' },
    ],
  },
  {
    key: 'build',
    match: /开发|编程|代码|项目|功能|重构|实现|上线|部署|网站|app/i,
    steps: [
      { title: '需求澄清与设计', ratio: 0.15, attr: 'attr_deep' },
      { title: '搭骨架 / 定义接口', ratio: 0.2, attr: 'attr_deep' },
      { title: '实现核心逻辑', ratio: 0.4, attr: 'attr_deep' },
      { title: '补测试与联调', ratio: 0.15, attr: 'attr_deep' },
      { title: '文档与收尾', ratio: 0.1, attr: 'attr_light' },
    ],
  },
  {
    key: 'reading',
    match: /读|书|文献|资料/,
    steps: [
      { title: '预习与列问题', ratio: 0.15, attr: 'attr_study' },
      { title: '精读并记笔记', ratio: 0.5, attr: 'attr_study' },
      { title: '整理摘要卡片', ratio: 0.2, attr: 'attr_study' },
      { title: '口头复述一遍', ratio: 0.15, attr: 'attr_study' },
    ],
  },
  {
    key: 'meeting',
    match: /汇报|汇报|组会|答辩|演讲|分享|演示|pre/i,
    steps: [
      { title: '明确听众与结论', ratio: 0.15, attr: 'attr_deep' },
      { title: '整理数据与图表', ratio: 0.3, attr: 'attr_deep' },
      { title: '搭幻灯片结构', ratio: 0.25, attr: 'attr_deep' },
      { title: '串讲与计时演练', ratio: 0.2, attr: 'attr_meeting' },
      { title: '预判提问并准备答案', ratio: 0.1, attr: 'attr_meeting' },
    ],
  },
  {
    key: 'generic',
    match: /.*/,
    steps: [
      { title: '明确目标与交付物', ratio: 0.15, attr: null },
      { title: '准备资料与工具', ratio: 0.15, attr: null },
      { title: '主体执行', ratio: 0.45, attr: null },
      { title: '检查与修正', ratio: 0.15, attr: null },
      { title: '收尾与归档', ratio: 0.1, attr: null },
    ],
  },
];

export function pickTemplate(task) {
  const text = `${task.title || ''} ${task.note || ''}`;
  for (const tpl of TEMPLATES) {
    if (tpl.match.test(text)) return tpl;
  }
  return TEMPLATES[TEMPLATES.length - 1];
}

/** 把模板折算成步骤：受 maxSteps 限制并按比例分配工时 */
export function stepsFromTemplate(task, template, maxSteps = 5) {
  const est = Math.max(10, task.estMin || 60);
  let steps = template.steps.map((s) => ({ ...s }));

  if (steps.length > maxSteps) {
    // 保留权重最高的若干项，再按比例归一
    const keep = new Set(
      [...steps]
        .sort((a, b) => b.ratio - a.ratio)
        .slice(0, maxSteps)
        .map((s) => s.title),
    );
    steps = steps.filter((s) => keep.has(s.title));
  }

  const sum = steps.reduce((acc, s) => acc + s.ratio, 0) || 1;
  const parentRequire = (task.attrs || []).filter((a) => a.strength === 'require').map((a) => a.attrId);
  const parentPrefer = (task.attrs || []).filter((a) => a.strength === 'prefer').map((a) => a.attrId);

  return steps.map((s, i) => {
    const attrs = parentRequire.map((id) => ({ attrId: id, strength: 'require' }));
    for (const id of parentPrefer) {
      if (!attrs.some((a) => a.attrId === id)) attrs.push({ attrId: id, strength: 'prefer' });
    }
    if (s.attr && !attrs.some((a) => a.attrId === s.attr)) {
      attrs.push({ attrId: s.attr, strength: 'prefer' });
    }
    const minutes = Math.max(10, Math.round((est * (s.ratio / sum)) / 5) * 5);
    return {
      id: uid('task'),
      title: s.title,
      estMin: minutes,
      attrs,
      order: i,
    };
  });
}

/* ---------------- LLM 路径 ---------------- */

const SYSTEM_PROMPT = `你是一个任务拆解助手。用户会给你一个任务、预计总耗时和截止时间。
请把它拆成 2-6 个可独立执行的步骤，每个步骤给出标题和预计耗时（分钟）。
要求：
- 各步骤耗时之和应接近但不超出总耗时
- 步骤之间是有序的，后一步依赖前一步的产出
- 标题用动词开头的短句，不超过 14 个汉字
只输出 JSON，格式：{"steps":[{"title":"...","minutes":30}]}`;

async function llmDecompose(task, llm, maxSteps) {
  const { baseUrl, apiKey, model } = llm || {};
  if (!apiKey || !baseUrl) throw new Error('未配置 LLM');

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const payload = {
    model: model || 'gpt-4o-mini',
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `任务：${task.title}\n备注：${task.note || '无'}\n总耗时：${task.estMin} 分钟\nDDL：${task.dueAt || '未设置'}\n请拆成不超过 ${maxSteps} 步。`,
      },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(text);
    const raw = Array.isArray(parsed.steps) ? parsed.steps : null;
    if (!raw || raw.length === 0) throw new Error('返回结构不合法');

    const parentRequire = (task.attrs || [])
      .filter((a) => a.strength === 'require')
      .map((id) => ({ attrId: id.attrId, strength: 'require' }));

    return raw.slice(0, maxSteps).map((s, i) => ({
      id: uid('task'),
      title: String(s.title || `步骤 ${i + 1}`).slice(0, 40),
      estMin: Math.max(10, Math.round(Number(s.minutes) || 30)),
      attrs: parentRequire.map((a) => ({ ...a })),
      order: i,
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 主入口
 * @returns {Promise<{steps: Array, source: 'llm'|'local', warning?: string}>}
 */
export async function decomposeTask(task, state, { forceLocal = false } = {}) {
  const maxSteps = state?.settings?.maxSteps ?? 5;
  const llm = state?.settings?.llm;

  if (!forceLocal && llm?.apiKey && llm?.baseUrl) {
    try {
      const steps = await llmDecompose(task, llm, maxSteps);
      return { steps, source: 'llm' };
    } catch (err) {
      const tpl = pickTemplate(task);
      return {
        steps: stepsFromTemplate(task, tpl, maxSteps),
        source: 'local',
        warning: `LLM 调用失败（${err.message}），已用本地规则拆分`,
      };
    }
  }

  return { steps: stepsFromTemplate(task, pickTemplate(task), maxSteps), source: 'local' };
}
