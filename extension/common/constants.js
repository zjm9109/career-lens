/**
 * 全局默认常量 —— 改默认避雷词 / 默认权重 / 模型从这里开始
 * UI 可覆盖；持久化见 storage.js
 */
import {
  DEFAULT_PILLAR_WEIGHTS,
  normalizePillarWeights,
  migrateWeightsToPillars
} from "./pillars.js";

export const DEFAULT_AVOID_TAGS = [
  "加班", "出差", "驻场", "外包", "派遣", "客服", "销售", "运维", "培训",
  "异地", "倒班", "夜班", "值班", "咨询", "电推", "应酬", "驾照"
];

/** @deprecated 旧五维；新逻辑用 DEFAULT_PILLAR_WEIGHTS */
export const DEFAULT_WEIGHTS = {
  skill: 40,
  industry: 20,
  direction: 15,
  certificate: 15,
  language: 10,
  ...DEFAULT_PILLAR_WEIGHTS
};

export { DEFAULT_PILLAR_WEIGHTS };

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
  batchSize: 5,
  exportMode: "simple",
  exportFormat: "md",
  /** 已废弃：始终不拦截 */
  directionStrict: false,
  /** @deprecated 已改为详情就绪轮询 + 条末按总时长补间隔 */
  minDetailWaitMs: 0,
  softSkillScore: false,
  /** 有 Key 时用语义/向量打四维；无 Key 回退规则+职业包词表 */
  semanticFit: true,
  weights: { ...DEFAULT_PILLAR_WEIGHTS }
};

export const APPLY_LIST_MAX = 100;
export const APPLY_LIST_PAGE_SIZE = 30;

/** 使用须知版本；升高后需用户重新勾选 */
export const USAGE_NOTICE_VERSION = 1;
/** 当日平台风控（短信/行为异常等）达到此次数 → 软锁精筛 */
export const DAILY_RISK_LOCK_COUNT = 3;
/** 猎聘单日最多真正打开详情次数（跨域/避雷跳过不计） */
export const DAILY_LIEPIN_DETAIL_OPEN_MAX = 25;

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
  resumeText: "",
  /** 当前职业包（展示适合岗位；域词仅无模型时兜底） */
  careerPackId: "it-delivery-pm",
  /** 规则/AI 侧写结果（保存画像时一并写入） */
  profileReport: null
};

/** 四维权重合计须为 100；兼容旧五维字段 */
export function normalizeWeights(weights) {
  return normalizePillarWeights(migrateWeightsToPillars(weights));
}
