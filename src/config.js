/**
 * config.js — 站点身份的唯一来源
 *
 * 想改站名？只改这个文件。
 * 顶栏标题、浏览器标签页、标语都从这里读。
 */

export const SITE = {
  /** 站名 */
  name: '规划器',

  /** 一句话标语，显示在站名下面 */
  tagline: '任务 · 属性 · 时段 · 自动排程',

  /**
   * GitHub 仓库，格式 '用户名/仓库名'。
   * 填了之后顶栏右上角会出现 GitHub 链接；留空则不显示。
   * 例如：'zhongjianan/todo-planner'
   */
  repo: '',

  /** 版本号，显示在左下面板，用来判断"看到的是不是最新版" */
  version: 'v0.12',

  /** 站点描述，用于 <meta name="description"> 和分享卡片 */
  description: '输入任务、设置属性与 DDL，按属性匹配时段、自动排程，长任务自动切块。',
};

/** 浏览器标签页标题 */
export const SITE_TITLE = `${SITE.name} · ${SITE.tagline}`;

/** GitHub 仓库地址（未配置时为空字符串） */
export const REPO_URL = SITE.repo ? `https://github.com/${SITE.repo}` : '';
