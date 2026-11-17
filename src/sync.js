/**
 * sync.js — 用 GitHub Gist 做设备间同步
 *
 * 为什么选 Gist：
 *  - 网站已经在 GitHub Pages 上，用户本来就有 GitHub 账号，等于"第三方登录"现成
 *  - 实测 api.github.com 是这条网络最稳的域名（github.com 的 443 反而不通）
 *  - 数据只有几十 KB，Gist 完全够用
 *
 * 安全边界（重要）：
 *  - token 只存本机 localStorage，**不进 App state**，所以永远不会被同步到云端
 *  - 上传前会把 settings.llm.apiKey 抹成空串，拉取时再用本机的值补回
 *  - 建议用 fine-grained token，只勾 `Gists: Read and write`
 */

const API = 'https://api.github.com';
const FILE = 'todo-planner.json';
const KEY = 'todo-planner-sync-v1';

const DEFAULT_CFG = { token: '', gistId: '', login: '', lastSyncAt: null };

/* ---------------- 本机凭证 ---------------- */

export function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_CFG };
    return { ...DEFAULT_CFG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CFG };
  }
}

export function saveSyncConfig(patch) {
  const next = { ...loadSyncConfig(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式等场景忽略 */
  }
  return next;
}

export function clearSyncConfig() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
}

/* ---------------- 数据整形（纯函数，可单测） ---------------- */

/** 上传前剥掉不该出本机的内容 */
export function stripForSync(state) {
  const copy = JSON.parse(JSON.stringify(state ?? {}));
  if (copy.settings && copy.settings.llm) copy.settings.llm.apiKey = '';
  return copy;
}

export function buildPayload(state, now = new Date()) {
  return JSON.stringify(
    {
      app: 'todo-planner',
      version: 1,
      updatedAt: now.toISOString(),
      state: stripForSync(state),
    },
    null,
    2,
  );
}

/** 把云端 state 合并回来：补默认值，并保留本机的 LLM Key */
export function mergeRemote(remoteState, localState) {
  const merged = JSON.parse(JSON.stringify(remoteState ?? {}));
  merged.settings = merged.settings ?? {};
  merged.settings.llm = merged.settings.llm ?? {};
  merged.settings.llm.apiKey = localState?.settings?.llm?.apiKey ?? '';
  merged.attributes = merged.attributes ?? [];
  merged.tasks = merged.tasks ?? [];
  merged.slots = merged.slots ?? [];
  merged.allocations = merged.allocations ?? [];
  merged.focusSessions = merged.focusSessions ?? [];
  return merged;
}

/** 把 HTTP 状态码翻译成人话 */
export function describeHttpError(status, action = '') {
  if (status === 401) return 'Token 无效或已过期，请重新生成';
  if (status === 403) return 'Token 权限不足：需要在 fine-grained token 里勾上 Gists 读写';
  if (status === 404) return action === 'get' ? '找不到这个 Gist，可能已被删除' : 'Gist 不存在';
  if (status === 422) return '数据格式被 GitHub 拒绝了';
  if (status >= 500) return 'GitHub 服务端出错，稍后再试';
  return `GitHub 返回 ${status}`;
}

/* ---------------- 网络 ---------------- */

async function ghFetch(path, { token, method = 'GET', body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(describeHttpError(res.status, method === 'GET' ? 'get' : ''));
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('网络超时，检查一下网络再试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 校验 token 并拿到用户名（拿不到也不影响使用） */
export async function whoami(token) {
  const user = await ghFetch('/user', { token });
  return user.login;
}

/** 读取云端数据 */
export async function pullState(cfg) {
  if (!cfg.gistId) throw new Error('还没有云端数据，先上传一次');
  const gist = await ghFetch(`/gists/${cfg.gistId}`, { token: cfg.token });
  const file = gist.files?.[FILE];
  if (!file) throw new Error(`这个 Gist 里没有 ${FILE}`);

  let text = file.content;
  if (file.truncated && file.raw_url) {
    const res = await fetch(file.raw_url);
    text = await res.text();
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('云端内容不是合法 JSON，可能被手动改坏了');
  }
  if (!payload?.state) throw new Error('云端数据缺少 state 字段');
  return payload;
}

/** 写入云端（首次会自动创建 Gist） */
export async function pushState(state, cfg) {
  const content = buildPayload(state);

  if (!cfg.gistId) {
    const gist = await ghFetch('/gists', {
      token: cfg.token,
      method: 'POST',
      body: {
        description: '规划器 · 设备同步（自动生成，勿删）',
        public: false,
        files: { [FILE]: { content } },
      },
    });
    return { gistId: gist.id, updatedAt: gist.updated_at, created: true };
  }

  // 先比时间戳：别把别的设备刚写的数据覆盖掉
  let remote = null;
  try {
    remote = await pullState(cfg);
  } catch (err) {
    if (!/找不到这个 Gist/.test(err.message)) throw err;
  }
  if (remote?.updatedAt && state?.updatedAt && remote.updatedAt > state.updatedAt) {
    const err = new Error('云端数据比本机新，请先点「从云端恢复」再上传');
    err.code = 'REMOTE_NEWER';
    throw err;
  }

  const gist = await ghFetch(`/gists/${cfg.gistId}`, {
    token: cfg.token,
    method: 'PATCH',
    body: { files: { [FILE]: { content } } },
  });
  return { gistId: gist.id, updatedAt: gist.updated_at, created: false };
}
