/**
 * 建议分组、硬门槛缺口、DeepSeek 费用估算
 *（不依赖 scoring.js，避免循环引用）
 */

function requirementsText(job) {
  if (job.requirements && String(job.requirements).trim()) {
    return String(job.requirements).trim();
  }
  const text = String(job.description || "");
  const start = text.search(/任职要求|任职资格|岗位要求|职位要求/);
  if (start < 0) return text;
  let rest = text.slice(start);
  const end = rest.search(/工作地址|公司介绍|福利待遇|职位诱惑|团队介绍|\n加分项/);
  if (end > 20) rest = rest.slice(0, end);
  return rest.trim();
}

/** DeepSeek chat 公开价近似（元 / 百万 tokens），用于预估非账单 */
export const DEEPSEEK_PRICE = {
  inputYuanPerMTok: 1,
  outputYuanPerMTok: 2,
  avgInputTokens: 1800,
  avgOutputTokens: 500
};

export const REC = {
  SUGGEST: "建议投递",
  REVIEW: "待复核",
  CAUTION: "谨慎投递",
  EXCLUDE: "已排除"
};

/** 待复核：门禁压分 / 规则分偏低时的契合原分门槛（略降以覆盖域压分后的近邻岗） */
export const REVIEW_FIT_HIGH = 60;
export const REVIEW_FIT_DIR = 55;

/** 入库/分析用有效分：优先契合原分，避免门禁封顶导致漏召回 */
export function effectiveFitScore(score) {
  if (!score) return 0;
  const fit = Number(score.fitTotal);
  if (Number.isFinite(fit)) return fit;
  return Number(score.total) || 0;
}

/** 待复核用分：域压分前与压分后取高，避免领域压到 15 后永远进不了待复核 */
export function reviewFitScore(score) {
  if (!score) return 0;
  const a = Number(score.fitBeforeDomainCrush);
  const b = Number(score.fitTotal);
  const c = Number(score.total) || 0;
  return Math.max(
    Number.isFinite(a) ? a : 0,
    Number.isFinite(b) ? b : 0,
    c
  );
}

function directionTitleHit(job, profile) {
  const dirs = (profile?.directions || []).filter(Boolean);
  if (!dirs.length) return false;
  const title = String(job?.title || "");
  return dirs.some((d) => d && title.includes(String(d)));
}

/**
 * 防漏：高契合被门禁压住，或门禁过了但展示分偏低且方向仍贴
 */
export function needsHumanReview(score, job, profile) {
  if (!score || score.excluded) return false;
  const fit = reviewFitScore(score);
  const total = Number(score.total) || 0;

  if (score.gateStatus === "fail") {
    // 跨域但角色/能力仍像：进待复核，避免全挤在「谨慎」
    if (fit >= REVIEW_FIT_HIGH) return true;
    const role = Number(score.pillars?.role?.score);
    const cap = Number(score.pillars?.capability?.score);
    const domainFail = (score.gateFailed || []).some((x) => /领域|行业/.test(String(x)));
    if (
      Number.isFinite(role) &&
      Number.isFinite(cap) &&
      role >= 75 &&
      cap >= 60 &&
      (fit >= REVIEW_FIT_DIR || (domainFail && role >= 80 && cap >= 65))
    ) {
      return true;
    }
    return false;
  }

  // 门禁通过：展示分偏低 + 契合原分仍高（或方向贴且略放宽）
  if (total < 60 && fit >= REVIEW_FIT_HIGH) return true;
  if (total < 60 && fit >= REVIEW_FIT_DIR && directionTitleHit(job, profile)) return true;
  return false;
}

const ANALYSIS_LABELS = [
  "一句话结论",
  "岗位成分识别",
  "必备能力识别",
  "匹配亮点",
  "风险/缺口",
  "是否建议投递",
  "改简历侧重点"
];

export function estimateDeepseekCost(calls) {
  const n = Math.max(0, Number(calls) || 0);
  const { inputYuanPerMTok, outputYuanPerMTok, avgInputTokens, avgOutputTokens } = DEEPSEEK_PRICE;
  const yuan =
    n *
    ((avgInputTokens / 1e6) * inputYuanPerMTok + (avgOutputTokens / 1e6) * outputYuanPerMTok);
  return {
    calls: n,
    yuan,
    yuanText: yuan < 0.01 && n > 0 ? "<0.01" : yuan.toFixed(2),
    note: `按约 ${avgInputTokens}/${avgOutputTokens} tokens·次粗算（参考 DeepSeek 量级），非实际账单`
  };
}

/** 从 JD 抽取最低年限（关注「N年以上」「N-M年」下限） */
export function extractMinYears(text) {
  const s = String(text || "");
  let min = null;
  const patterns = [
    /(\d+)\s*年以上/g,
    /(\d+)\s*年及以上/g,
    /至少\s*(\d+)\s*年/g,
    /(\d+)\s*-\s*(\d+)\s*年/g,
    /(\d+)\s*～\s*(\d+)\s*年/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(s))) {
      const a = Number(m[1]);
      if (!Number.isFinite(a)) continue;
      min = min == null ? a : Math.max(min, a);
    }
  }
  return min;
}

const HARD_CERT_ALIASES = [
  { key: "PMP", re: /\bPMP\b|项目管理专业人士/i },
  { key: "ACP", re: /\bACP\b|敏捷认证/i },
  { key: "信息系统项目管理师", re: /信息系统项目管理师|软考高项|高项/ },
  { key: "一级机电建造师", re: /一级机电建造师/ },
  { key: "机电建造师", re: /机电建造师/ },
  { key: "一级建造师", re: /一级建造师/ },
  { key: "二级建造师", re: /二级建造师/ },
  { key: "建造师", re: /建造师/ },
  { key: "英语六级", re: /英语六级|CET-?6/i },
  { key: "英语四级", re: /英语四级|CET-?4/i }
];

function clauseIsHardRequirement(clause) {
  const c = String(clause || "");
  if (/优先|加分|者优先|更好|佳/.test(c)) return false;
  return /必须|必备|需持有|须持有|持有.*证书|具备.*证书|证书者|硬性/.test(c) || /要求持有|需具备/.test(c);
}

function profileHasCert(profile, key) {
  const bag = [
    ...(profile.certificates || []),
    ...(profile.skills || []),
    profile.resumeText || ""
  ]
    .join("\n")
    .toLowerCase();
  const k = key.toLowerCase();
  if (bag.includes(k)) return true;
  if (key === "信息系统项目管理师" && /软考|高项/.test(bag)) return true;
  if (key === "PMP" && /pmp/.test(bag)) return true;
  if (/建造师/.test(key)) return /建造师|一建|二建/.test(bag);
  return false;
}

/**
 * 硬门槛缺口：年限、必备证书等（语义向：优先句不算硬门槛）
 * 不扫碎词；只列与岗位门槛相关的缺失。
 */
export function collectHardGaps(job, profile) {
  const gaps = [];
  const req = requirementsText(job);
  const body = `${req}\n${job.responsibilities || ""}`;

  const needYears = extractMinYears(req) || extractMinYears(body);
  const haveYears = Number(profile.yearsExperience);
  if (needYears != null) {
    if (!Number.isFinite(haveYears) || haveYears <= 0) {
      gaps.push(`工作年限：岗位要求≥${needYears}年，画像未填年限`);
    } else if (haveYears < needYears) {
      gaps.push(`工作年限：岗位要求≥${needYears}年，画像为${haveYears}年`);
    }
  }

  const clauses = body.split(/[；;\n。]/);
  for (const cert of HARD_CERT_ALIASES) {
    const hitClause = clauses.find((c) => cert.re.test(c) && clauseIsHardRequirement(c));
    // 标题/关键词强信号：职位标签带 PMP 且要求句未写优先
    const kwHit =
      !hitClause &&
      (job.keywords || []).some((k) => cert.re.test(k)) &&
      clauses.some((c) => cert.re.test(c) && !/优先|加分/.test(c));
    if (!hitClause && !kwHit) continue;
    if (!profileHasCert(profile, cert.key)) {
      gaps.push(`必备证书/资质：${cert.key}`);
    }
  }

  return [...new Set(gaps)];
}

export function parseAdviceFromAnalysis(analysis) {
  const t = String(analysis || "");
  const m = t.match(/是否建议投递\s*[:：]\s*(建议|谨慎|不建议)/);
  if (m) return m[1];
  if (/不建议投递/.test(t)) return "不建议";
  if (/谨慎投递|建议谨慎/.test(t)) return "谨慎";
  if (/建议投递/.test(t)) return "建议";
  return "";
}

/** 主动跳过模型（非「状态不可信」） */
export function isLlmIntentionallySkipped(skipped) {
  return /避雷命中|避雷：|低于分析阈值|低于阈值|未配置/.test(String(skipped || ""));
}

/** 模型调用失败痕迹（任意错误，不限 503） */
export function isLlmCallFailed(skipped) {
  const s = String(skipped || "");
  if (!s || isLlmIntentionallySkipped(s)) return false;
  return /失败|请求失败|\b5\d\d\b|\b429\b|busy|unavailable|too busy|Failed to fetch|超时|timeout|返回空|负载|error|Error|拒绝|unauthorized|401|403/i.test(
    s
  );
}

/**
 * 推荐状态是否不可信：已配置并应走模型，但没有可用分析正文。
 * （含 503/网络/空响应/语义降级后的规则虚高，不限于某一错误码）
 */
export function isRecommendationUnreliable(result) {
  const score = result?.score || {};
  if (score.excluded) return false;
  if (String(result?.analysis || "").trim()) return false;
  if (isLlmIntentionallySkipped(result?.skippedDeepseek)) return false;

  if (result?.llmRequired === true) return true;
  if (score.semanticDegraded) return true;
  if (isLlmCallFailed(result?.skippedDeepseek)) return true;
  // 有 Key 路径留下的纯规则高分：四维标注 rule 且展示分偏高，无模型正文
  if (
    score.scoreMode === "rule" &&
    (score.total ?? 0) >= 60 &&
    result?.llmRequired !== false &&
    (result?.hasLlmKey === true || result?.llmLabel)
  ) {
    return true;
  }
  return false;
}

/**
 * 分组顺序：建议投递 → 待复核 → 谨慎投递 → 已排除
 * 门禁 FAIL 且高契合 → 待复核（不得「建议投递」）；低契合门禁失败 → 谨慎
 * 状态不可信（无可靠模型结论）→ 待复核，禁止规则满分直接「建议投递」
 */
export function getRecommendation(result) {
  const score = result?.score || {};
  if (score.excluded) return REC.EXCLUDE;

  if (needsHumanReview(score, result?.job, result?.profile)) return REC.REVIEW;

  if (isRecommendationUnreliable(result)) {
    return REC.REVIEW;
  }

  if (score.gateStatus === "fail") return REC.CAUTION;

  // JD 过空/套话：即使标签命中也不「建议投递」
  if (score.jdConcrete?.sparse) return REC.CAUTION;

  const analysisOk = !!String(result?.analysis || "").trim();
  const advice = parseAdviceFromAnalysis(result?.analysis);
  if (advice === "不建议" || advice === "谨慎") return REC.CAUTION;

  // 仅硬缺口挡建议；软能力缺口（信息化近义未写字面等）不挡
  const hardGaps = (score.hardGaps || []).filter(
    (g) =>
      /证书|语言|年限|领域语义|硬性领域|工作语言|JD具体度偏低/.test(g) ||
      (/必备能力：/.test(g) && !/信息化|数字化|国企|央企|瀑布|敏捷|成本管控|实施交付|跨部门/.test(g))
  );
  if (hardGaps.length) return REC.CAUTION;

  const total = score.total ?? 0;
  if (total < 60) return REC.CAUTION;

  if (advice === "建议") return REC.SUGGEST;

  // 已配置 Key 且本应分析：必须有模型正文才允许按分数「建议」；无 Key 纯规则模式除外
  if (result?.llmRequired === true && !analysisOk) return REC.REVIEW;

  if (total >= 60) return REC.SUGGEST;
  return REC.CAUTION;
}

function normalizeRecLabel(rec) {
  if (rec === REC.SUGGEST || rec === "建议投递") return REC.SUGGEST;
  if (rec === REC.REVIEW || rec === "待复核") return REC.REVIEW;
  if (rec === REC.CAUTION || rec === "谨慎" || rec === "谨慎投递") return REC.CAUTION;
  if (rec === REC.EXCLUDE || rec === "排除" || rec === "已排除") return REC.EXCLUDE;
  return REC.CAUTION;
}

/** 导出 / 侧栏分组顺序 */
export const REC_ORDER = [REC.SUGGEST, REC.REVIEW, REC.CAUTION, REC.EXCLUDE];

export function groupResultsByRecommendation(results) {
  const buckets = {
    [REC.SUGGEST]: [],
    [REC.REVIEW]: [],
    [REC.CAUTION]: [],
    [REC.EXCLUDE]: []
  };
  for (const r of results) {
    const rec = normalizeRecLabel(r.recommendation || getRecommendation(r));
    buckets[rec].push({ ...r, recommendation: rec });
  }
  // 组内：待复核按契合原分，其余按展示分
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => {
      const sa =
        k === REC.REVIEW ? effectiveFitScore(a.score) : a.score?.total ?? 0;
      const sb =
        k === REC.REVIEW ? effectiveFitScore(b.score) : b.score?.total ?? 0;
      if (sb !== sa) return sb - sa;
      return (a.order ?? 0) - (b.order ?? 0);
    });
  }
  return buckets;
}

/** 解析分析行为「标签 + 正文」，供 Word 标签加粗 */
export function splitAnalysisLine(line) {
  const raw = String(line || "").replace(/^\s*[-*]\s*/, "");
  for (const label of ANALYSIS_LABELS) {
    const re = new RegExp(`^(${label.replace(/\//g, "\\/")})\\s*([:：])\\s*(.*)$`);
    const m = raw.match(re);
    if (m) {
      return { label: m[1] + m[2], content: m[3] || "", isField: true };
    }
  }
  return { label: "", content: raw, isField: false };
}

export function enrichResult(result) {
  const recommendation = getRecommendation(result);
  return {
    ...result,
    recommendation,
    reviewFlag: recommendation === REC.REVIEW
  };
}
