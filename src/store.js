/**
 * store.js — 极简状态容器 + localStorage 持久化
 * 单例状态，订阅式重渲染。所有写操作走 update()，保证持久化。
 */

import { seedState } from './model.js';

const STORAGE_KEY = 'todo-planner-state-v1';

let state = null;
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tasks)) return null;
    // 兼容旧数据：补齐缺失字段
    return {
      version: 1,
      attributes: parsed.attributes ?? [],
      tasks: parsed.tasks ?? [],
      slots: parsed.slots ?? [],
      allocations: parsed.allocations ?? [],
      focusSessions: parsed.focusSessions ?? [],
      settings: {
        horizonDays: 14,
        maxSteps: 5,
        writeBack: true,
        llm: { baseUrl: '', apiKey: '', model: '' },
        ...(parsed.settings ?? {}),
      },
    };
  } catch (err) {
    console.warn('[store] 读取失败，回退到演示数据', err);
    return null;
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[store] 保存失败', err);
  }
}

function emit() {
  for (const fn of listeners) fn(state);
}

export function getState() {
  if (!state) state = load() ?? seedState();
  return state;
}

/** updater: (state) => nextState | void（可直接 mutate，内部会浅拷贝顶层） */
export function update(updater) {
  const prev = getState();
  const next = updater(prev) ?? prev;
  state = next === prev ? { ...prev } : next;
  persist();
  emit();
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function resetToSeed() {
  state = seedState();
  persist();
  emit();
}

export function clearAll() {
  update((s) => ({
    ...s,
    tasks: [],
    allocations: [],
  }));
}
