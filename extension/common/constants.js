/**
 * 全局默认常量 —— 改默认避雷词 / 默认权重 / 模型从这里开始
 * UI 可覆盖；持久化见 storage.js
 */

export const DEFAULT_AVOID_TAGS = [
  "加班", "出差", "驻场", "外包", "派遣", "客服", "销售", "运维", "培训",
  "异地", "倒班", "夜班", "值班", "咨询", "电推", "应酬", "驾照"
];

export const DEFAULT_WEIGHTS = {
  skill: 40,
  industry: 20,
  direction: 15,
  certificate: 15,
  language: 10
};

export const DEFAULT_SETTINGS = {
  /** 当前启用的模型：deepseek | qwen | hunyuan | openai | gemini */
  llmProvider: "deepseek",
  apiKeys: {
    deepseek: "",
    qwen: "",
    hunyuan: "",
    openai: "",
    gemini: ""
  },
  /** @deprecated 迁移用 */
  deepseekApiKey: "",
  deepseekThreshold: 60,
  favoriteThreshold: 80,
  /** 进入投递列表的最低规则分，默认跟收藏阈值 */
  applyListThreshold: null,
  batchSize: 10,
  exportMode: "simple",
  exportFormat: "md",
  /** 已废弃：始终不拦截 */
  directionStrict: false,
  minDetailWaitMs: 3000,
  softSkillScore: false,
  weights: { ...DEFAULT_WEIGHTS }
};

export const APPLY_LIST_MAX = 100;
export const APPLY_LIST_PAGE_SIZE = 30;

export const DEFAULT_PROFILE = {
  skills: [],
  industries: [],
  directions: [],
  certificates: [],
  languages: [],
  /** 工作年限（年），辅助硬门槛；可从简历启发式提取后手改 */
  yearsExperience: 0,
  avoidSelected: [],
  avoidCustom: [],
  attentionSelected: [],
  attentionCustom: [],
  resumeText: ""
};

/** 合计须为 100 才采用；否则回退默认权重（不自动归一） */
export function normalizeWeights(weights) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const out = {};
  let sum = 0;
  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    const n = Number(w[k]);
    out[k] = Number.isFinite(n) ? n : DEFAULT_WEIGHTS[k];
    sum += out[k];
  }
  if (sum === 100) return out;
  return { ...DEFAULT_WEIGHTS };
}
