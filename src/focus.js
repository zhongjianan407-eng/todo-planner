/**
 * focus.js — 专注计时（Pomodoro 风格）的纯逻辑
 *
 * 计时不靠「每秒减一」，而是靠时间戳推算：
 *   elapsed = accumulatedMs + (running ? now - startedAtMs : 0)
 * 这样切到后台、锁屏、刷新页面回来都不会走偏。
 *
 * 所有函数都接收 nowMs 参数，不读系统时钟 → 可单测。
 */

/** 把毫秒格式化成 mm:ss（分钟可以超过 59） */
export function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

let seq = 0;
function nextId() {
  seq += 1;
  return `focus_${Date.now().toString(36)}${seq.toString(36)}`;
}

/**
 * 创建一次专注会话（未开始）
 * @param {{taskId:string, allocId?:string|null, plannedMin:number, now?:number}} p
 */
export function createSession({ taskId, allocId = null, plannedMin = 25, now = Date.now() }) {
  const minutes = Math.max(1, Math.round(Number(plannedMin) || 25));
  return {
    id: nextId(),
    taskId,
    allocId,
    plannedMin: minutes,
    totalMs: minutes * 60000,
    accumulatedMs: 0,
    startedAtMs: null,
    running: false,
    createdAt: now,
  };
}

export function startSession(session, now = Date.now()) {
  if (session.running) return session;
  return { ...session, running: true, startedAtMs: now };
}

export function pauseSession(session, now = Date.now()) {
  if (!session.running) return session;
  return {
    ...session,
    running: false,
    accumulatedMs: elapsedMs(session, now),
    startedAtMs: null,
  };
}

export function resumeSession(session, now = Date.now()) {
  return startSession(session, now);
}

export function resetSession(session) {
  return { ...session, accumulatedMs: 0, startedAtMs: null, running: false };
}

/** 调整目标时长（分钟），不低于已累计的时长 */
export function setPlannedMinutes(session, minutes, now = Date.now()) {
  const done = elapsedMs(session, now);
  const wanted = Math.max(1, Math.round(Number(minutes) || 1));
  const totalMs = Math.max(wanted * 60000, done);
  return { ...session, plannedMin: Math.round(totalMs / 60000), totalMs };
}

export function elapsedMs(session, now = Date.now()) {
  if (!session) return 0;
  const live =
    session.running && session.startedAtMs != null
      ? Math.max(0, now - session.startedAtMs)
      : 0;
  // 不在这里夹到 totalMs：真实专注时长可能超过计划，记录要如实
  // 需要「不越界」的展示由 remainingMs / progress 各自夹紧
  return Math.max(0, session.accumulatedMs + live);
}

export function remainingMs(session, now = Date.now()) {
  if (!session) return 0;
  return Math.max(0, session.totalMs - elapsedMs(session, now));
}

/** 0..1 的完成比例 */
export function progress(session, now = Date.now()) {
  if (!session || !session.totalMs) return 0;
  return Math.min(1, elapsedMs(session, now) / session.totalMs);
}

export function isFinished(session, now = Date.now()) {
  return !!session && elapsedMs(session, now) >= session.totalMs;
}

/** 实际专注了多少分钟（用于落库） */
export function actualMinutes(session, now = Date.now()) {
  return Math.round(elapsedMs(session, now) / 60000);
}

/**
 * 结束会话，产出一条可持久化的记录
 * @param {'completed'|'stopped'} status
 */
export function finishSession(session, status = 'completed', now = Date.now()) {
  const paused = pauseSession(session, now);
  return {
    ...paused,
    status,
    endedAt: now,
    actualMin: actualMinutes(paused, now),
  };
}
