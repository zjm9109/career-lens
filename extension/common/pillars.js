/**
 * 契合四维（面向所有岗位，边界按大众语义）
 *
 * 1. 角色 role        — 这活是干什么的，和你想做/做过的角色是否一类
 * 2. 领域 domain      — 行业/业务场景是否同域（土建 vs 金融 vs 短剧…）
 * 3. 能力 capability  — 方法、工具、技能是否覆盖职责所需
 * 4. 资质 qualify     — 证书/年限/语言等条件贴合（硬事实仍先走门禁）
 *
 * 旧五维仅作无模型时的规则映射兜底。
 */

export const PILLAR_KEYS = ["role", "domain", "capability", "qualify"];

export const PILLAR_LABELS = {
  role: "角色契合",
  domain: "领域契合",
  capability: "能力契合",
  qualify: "资质条件"
};

/** 默认权重：领域与能力略重，避免「标题像 PM 就满分」 */
export const DEFAULT_PILLAR_WEIGHTS = {
  role: 25,
  domain: 30,
  capability: 30,
  qualify: 15
};

/** 旧五维 → 四维（兼容已保存 settings） */
export function migrateWeightsToPillars(weights) {
  if (!weights || typeof weights !== "object") return { ...DEFAULT_PILLAR_WEIGHTS };
  if (weights.role != null || weights.domain != null) {
    return {
      role: Number(weights.role) || DEFAULT_PILLAR_WEIGHTS.role,
      domain: Number(weights.domain) || DEFAULT_PILLAR_WEIGHTS.domain,
      capability: Number(weights.capability ?? weights.skill) || DEFAULT_PILLAR_WEIGHTS.capability,
      qualify: Number(weights.qualify) || DEFAULT_PILLAR_WEIGHTS.qualify
    };
  }
  // skill/industry/direction/certificate/language
  const skill = Number(weights.skill) || 40;
  const industry = Number(weights.industry) || 20;
  const direction = Number(weights.direction) || 15;
  const certificate = Number(weights.certificate) || 15;
  const language = Number(weights.language) || 10;
  return {
    role: direction,
    domain: industry,
    capability: skill,
    qualify: certificate + language
  };
}

export function normalizePillarWeights(weights) {
  const w = migrateWeightsToPillars(weights);
  const out = {};
  let sum = 0;
  for (const k of PILLAR_KEYS) {
    const n = Number(w[k]);
    out[k] = Number.isFinite(n) ? n : DEFAULT_PILLAR_WEIGHTS[k];
    sum += out[k];
  }
  if (sum === 100) return out;
  return { ...DEFAULT_PILLAR_WEIGHTS };
}

export function weightedPillarTotal(pillars, weights) {
  const w = normalizePillarWeights(weights);
  let sum = 0;
  for (const k of PILLAR_KEYS) {
    sum += (Number(pillars[k]?.score) || 0) * w[k];
  }
  return Math.round(sum / 100);
}

/** 规则五维 → 四维兜底（无 Key / 语义失败时） */
export function mapLegacyDimsToPillars(dimensions = {}) {
  const skill = dimensions.skill?.score ?? 50;
  const industry = dimensions.industry?.score ?? 50;
  const direction = dimensions.direction?.score ?? 50;
  const certificate = dimensions.certificate?.score ?? 50;
  const language = dimensions.language?.score ?? 50;
  return {
    role: {
      score: direction,
      detail: dimensions.direction?.detail || "规则：方向维映射为角色契合",
      source: "rule"
    },
    domain: {
      score: industry,
      detail: dimensions.industry?.detail || "规则：行业维映射为领域契合",
      source: "rule"
    },
    capability: {
      score: skill,
      detail: dimensions.skill?.detail || "规则：技能维映射为能力契合",
      source: "rule"
    },
    qualify: {
      score: Math.round((certificate + language) / 2),
      detail: `规则：证书 ${certificate} / 语言 ${language}`,
      source: "rule"
    }
  };
}
