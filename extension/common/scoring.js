/**
 * 规则打分（唯一计分来源 = 加分项加权）
 *
 * 统一原则：
 * 1) 从「职位关键词 + 任职要求」收集要求项
 * 2) 分句含「优先/加分」→ soft（未命中不扣分）；否则 → hard
 * 3) 技能维：硬要求命中比例，如 8/10 → 80，再按权重计入总分
 * 4) 行业/证书/语言：硬要求未命中则该维降为 0 或按比例
 *
 * 入口：scoreJob(job, profile, settings)
 */
import { normalizeWeights } from "./constants.js";
import { collectHardGaps } from "./recommend.js";

function norm(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, "");
}

function wideHit(haystack, needle) {
  const h = norm(haystack);
  const n = norm(needle);
  return n.length > 0 && h.includes(n);
}

function anyHit(text, tags) {
  return (tags || []).filter((t) => wideHit(text, t));
}

/** 命中比例计分：8/10 → 80（不再默认 sqrt 软化） */
function ratioScore(hit, total) {
  if (total <= 0) return 100;
  return Math.round((hit / total) * 100);
}

function softCoverage(hit, total) {
  if (total <= 0) return 100;
  return Math.round(Math.sqrt(hit / total) * 100);
}

function looksLikeCertificate(tag) {
  return /pmp|prince2|软考|cet|托福|雅思|证书|驾照|注册会计师|信息系统项目管理|cspm|scrum\s*master/i.test(
    String(tag)
  );
}

function looksLikeMajor(tag) {
  return /专业|本科|硕士|大专|学历/.test(String(tag));
}

function looksLikeMetaTag(tag) {
  return /^(北京|上海|杭州|广州|深圳|成都|南京|武汉|\d+-\d+年|经验不限|应届|在校)/.test(String(tag));
}

/** 行业词表：扩展新行业只改这里 */
export const KNOWN_INDUSTRIES = [
  "互联网", "金融", "银行", "证券", "保险", "电商", "教育", "医疗", "游戏",
  "政务", "制造", "汽车", "房地产", "物流", "零售", "人工智能", "大数据",
  "电力", "能源", "运营商", "通信", "军工", "航空", "航天", "央企", "国企",
  "新能源", "半导体", "芯片", "云计算", "智能制造", "养老"
];

/** 证书词表 */
export const KNOWN_CERTIFICATES = [
  "PMP", "PRINCE2", "软考", "信息系统项目管理师", "系统集成项目管理工程师",
  "CSPM", "Scrum Master", "CPA", "CET-6", "CET-4", "英语六级", "英语四级", "托福", "雅思"
];

/** 语言词表 */
export const KNOWN_LANGUAGES = [
  "英语", "英文", "日语", "口语", "CET-6", "CET-4", "英语六级", "英语四级", "托福", "雅思", "六级", "四级"
];

/**
 * 常见技能/能力词（用于从任职要求正文反查硬技能）。
 * Boss 职位标签会另外并入，不必穷尽。
 */
export const KNOWN_SKILLS = [
  "项目管理", "项目经理", "PMO", "敏捷", "Scrum", "Kanban", "瀑布",
  "Jira", "禅道", "需求分析", "风险管理", "成本管控", "资源协调",
  "进度控制", "里程碑", "实施交付", "验收", "跨部门", "团队管理",
  "Java", "Python", "SQL", "微服务", "DevOps", "云原生", "容器",
  "大数据", "人工智能", "大模型", "RAG", "AIGC", "数据标注",
  "信息化", "智慧项目", "中台", "产品设计", "PRD"
];

function splitClauses(text) {
  return String(text || "")
    .split(/[。；;\n]|(?=\d+[\.、])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function isPreferredClause(clause) {
  return /优先|加分项|加分|尤佳|更好|最佳|优先考虑/.test(clause);
}

function isHardSignalClause(clause) {
  return /熟练|精通|掌握|熟悉|具备|要求|必须|需要|经验|能力|背景|从业|从事|持有|证书|责任|独立负责/.test(
    clause
  );
}

/** 从整段 JD 切出任职要求 */
export function extractRequirementsText(job) {
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

/**
 * 通用：词表在文本中的 hard / soft 分类
 * soft = 分句含「优先」；hard = 含要求信号且非优先
 */
export function classifyMentions(text, vocabulary) {
  const hard = new Set();
  const soft = new Set();
  const vocab = [...new Set((vocabulary || []).filter(Boolean))].sort((a, b) => b.length - a.length);
  const clauses = splitClauses(text);

  for (const clause of clauses) {
    for (const term of vocab) {
      if (!wideHit(clause, term) && !clause.includes(term)) continue;
      if (isPreferredClause(clause)) {
        soft.add(term);
        hard.delete(term);
      } else if (isHardSignalClause(clause)) {
        if (!soft.has(term)) hard.add(term);
      }
    }
  }
  return { hard: [...hard], soft: [...soft] };
}

export function classifyIndustryMentions(reqText, fullText) {
  return classifyMentions(`${reqText || ""}\n${fullText || ""}`, KNOWN_INDUSTRIES);
}

function userMatches(userTags, term) {
  return (userTags || []).some((t) => wideHit(t, term) || wideHit(term, t));
}

function matchRatio(requiredTerms, userTags) {
  const R = [...new Set(requiredTerms.filter(Boolean))];
  if (!R.length) return { score: 100, hits: [], required: [], miss: [] };
  const hits = R.filter((r) => userMatches(userTags, r));
  const miss = R.filter((r) => !userMatches(userTags, r));
  return {
    score: ratioScore(hits.length, R.length),
    hits,
    required: R,
    miss
  };
}

/**
 * 技能维：
 * - 职位关键词（chips）默认计入硬要求 R
 * - 任职要求正文中出现的技能：无「优先」→ 进 R；有「优先」→ 不进 R（不扣分）
 * - 得分 = 命中数 / |R| × 100（例 8/10=80），再由权重计入总分
 */
function scoreSkill(job, profile, useSoftCurve) {
  const userSkills = profile.skills || [];
  const bossTags = (job.keywords || []).filter(
    (t) => t && !looksLikeCertificate(t) && !looksLikeMajor(t) && !looksLikeMetaTag(t)
  );
  const reqText = extractRequirementsText(job);
  const vocab = [...new Set([...KNOWN_SKILLS, ...userSkills, ...bossTags])];
  const { hard: bodyHard, soft: bodySoft } = classifyMentions(reqText, vocab);

  const hard = new Set();
  // chips：岗位明确挂出的能力标签 → 硬要求（证书/学历 meta 已在 bossTags 过滤）
  for (const t of bossTags) hard.add(t);
  for (const t of bodyHard) {
    // 证书/语言留给对应维度，避免 PMP/英语重复进技能分母
    if (looksLikeCertificate(t) || KNOWN_LANGUAGES.some((l) => wideHit(t, l) || wideHit(l, t))) {
      continue;
    }
    if (!bodySoft.includes(t)) hard.add(t);
  }
  // soft 从 hard 剔除（任职写了优先）
  for (const t of bodySoft) hard.delete(t);

  const R = [...hard];
  if (!R.length) {
    return {
      score: 100,
      detail: "未识别到明确技能硬要求，中性分 100",
      hits: [],
      required: [],
      miss: [],
      soft: bodySoft
    };
  }

  const { score: raw, hits, miss } = matchRatio(R, userSkills);
  const score = useSoftCurve ? softCoverage(hits.length, R.length) : raw;
  return {
    score,
    detail: `技能硬要求 ${hits.length}/${R.length} → ${score}${miss.length ? `；未命中：${miss.slice(0, 8).join("、")}` : ""}`,
    hits,
    required: R,
    miss,
    soft: bodySoft
  };
}

function scoreIndustry(job, profile) {
  const tags = profile.industries || [];
  const full = `${job.title || ""}\n${(job.keywords || []).join(",")}\n${job.description || ""}`;
  if (!full.trim()) return { score: 100, detail: "岗位文本空，中性分 100", hits: [], hard: [], soft: [] };

  const reqText = extractRequirementsText(job);
  let { hard, soft } = classifyMentions(reqText, KNOWN_INDUSTRIES);
  if (!hard.length && !soft.length) {
    ({ hard, soft } = classifyMentions(full, KNOWN_INDUSTRIES));
  }

  if (hard.length) {
    // 多个硬行业：按命中比例（中 1/2 个行业 → 50）
    const { score, hits, miss } = matchRatio(hard, tags);
    return {
      score,
      detail:
        score === 100
          ? `硬性行业已满足：${hits.join("、")}`
          : `硬性行业 ${hits.length}/${hard.length} → ${score}；未命中：${miss.join("、")}`,
      hits,
      hard,
      soft,
      miss
    };
  }

  if (soft.length) {
    const hits = soft.filter((h) => userMatches(tags, h));
    return {
      score: 100,
      detail: hits.length
        ? `优先行业命中：${hits.join("、")}`
        : `仅「优先」行业（${soft.join("、")}），未命中不扣分`,
      hits,
      hard: [],
      soft
    };
  }

  if (!tags.length) return { score: 100, detail: "未填行业且 JD 无硬性行业，中性分 100", hits: [] };
  const hits = anyHit(full, tags);
  if (hits.length) return { score: 100, detail: `行业命中：${hits.join("、")}`, hits, hard: [], soft: [] };
  const jdIndustries = KNOWN_INDUSTRIES.filter((x) => wideHit(full, x));
  if (!jdIndustries.length) return { score: 100, detail: "JD 未明确行业，中性分 100", hits: [], hard: [], soft: [] };
  return { score: 0, detail: `行业未命中（JD 提及：${jdIndustries.join("、")}）`, hits: [], hard: [], soft: [] };
}

function scoreDirection(job, profile) {
  const tags = profile.directions || [];
  if (!tags.length) return { score: 100, detail: "未填方向词，中性分 100", hits: [], titleHits: [], bodyHits: [] };

  const titleHits = anyHit(job.title || "", tags);
  const reqText = extractRequirementsText(job);
  const { hard, soft } = classifyMentions(reqText, [...tags, ...KNOWN_SKILLS.filter((s) => /经理|PMO|专员|工程师/.test(s))]);
  // 任职硬性方向词（如必须项目经理经验）
  if (hard.length) {
    const { score, hits, miss } = matchRatio(hard, tags);
    if (titleHits.length && score < 100) {
      // 标题已对上方向，给标题分与硬要求分的较高者偏置：标题命中至少 70
      const blended = Math.max(score, 70);
      return {
        score: blended,
        detail: `方向硬要求 ${hits.length}/${hard.length}；标题命中 ${titleHits.join("、")} → ${blended}`,
        hits: [...new Set([...hits, ...titleHits])],
        titleHits,
        bodyHits: hits,
        miss
      };
    }
    return {
      score,
      detail: `方向硬要求 ${hits.length}/${hard.length} → ${score}${miss.length ? `；未命中：${miss.join("、")}` : ""}`,
      hits,
      titleHits,
      bodyHits: hits,
      miss
    };
  }

  const bodyHits = anyHit(`${job.description || ""}\n${reqText}`, tags);
  if (titleHits.length) {
    return { score: 100, detail: `标题命中方向：${titleHits.join("、")}`, hits: titleHits, titleHits, bodyHits, soft };
  }
  if (bodyHits.length) {
    return { score: 70, detail: `仅正文命中方向：${bodyHits.join("、")}`, hits: bodyHits, titleHits, bodyHits, soft };
  }
  if (soft.length) {
    return { score: 100, detail: `仅方向「优先」表述，未命中不扣分`, hits: [], titleHits, bodyHits: [], soft };
  }
  return { score: 0, detail: "方向词未命中", hits: [], titleHits, bodyHits: [] };
}

function scoreCertificate(job, profile) {
  const user = profile.certificates || [];
  const reqText = extractRequirementsText(job);
  const chipCerts = (job.keywords || []).filter(looksLikeCertificate);
  const vocab = [...new Set([...KNOWN_CERTIFICATES, ...user, ...chipCerts])];
  const { hard: bodyHard, soft } = classifyMentions(reqText, vocab);

  const hard = new Set(chipCerts);
  for (const c of bodyHard) hard.add(c);
  for (const c of soft) hard.delete(c);

  const R = [...hard];
  if (!R.length) {
    return {
      score: 100,
      detail: soft.length
        ? `仅证书「优先」（${soft.join("、")}），未命中不扣分`
        : "无明确证书硬要求，中性分 100",
      hits: [],
      required: [],
      miss: [],
      soft
    };
  }

  const { score, hits, miss } = matchRatio(R, user);
  return {
    score,
    detail: `证书硬要求 ${hits.length}/${R.length} → ${score}${miss.length ? `；未命中：${miss.join("、")}` : ""}`,
    hits,
    required: R,
    miss,
    soft
  };
}

function scoreLanguage(job, profile) {
  const user = profile.languages || [];
  const reqText = extractRequirementsText(job);
  const full = `${reqText}\n${job.description || ""}`;
  const { hard, soft } = classifyMentions(reqText, KNOWN_LANGUAGES);
  let hardList = hard;
  let softList = soft;
  if (!hardList.length && !softList.length) {
    // 全文仅出现语言词且带要求信号时
    const again = classifyMentions(full, KNOWN_LANGUAGES);
    hardList = again.hard;
    softList = again.soft;
  }

  if (hardList.length) {
    if (!user.length) {
      return { score: 0, detail: `语言硬要求未填标签（要求：${hardList.join("、")}）`, hits: [], hard: hardList, soft: softList };
    }
    const { score, hits, miss } = matchRatio(hardList, user);
    // 英语/英文/六级等同族：用户有「英语」且要求「英语六级」——wideHit 已部分覆盖
    return {
      score,
      detail: `语言硬要求 ${hits.length}/${hardList.length} → ${score}${miss.length ? `；未命中：${miss.join("、")}` : ""}`,
      hits,
      hard: hardList,
      soft: softList,
      miss
    };
  }

  if (softList.length) {
    const hits = softList.filter((h) => userMatches(user, h));
    return {
      score: 100,
      detail: hits.length
        ? `优先语言命中：${hits.join("、")}`
        : `仅语言「优先」，未命中不扣分`,
      hits,
      hard: [],
      soft: softList
    };
  }

  return { score: 100, detail: "无语言硬要求，中性分 100", hits: [] };
}

/**
 * 协作/附带提及不算避雷：如「和销售、管理层」「组织培训、分享」「实施、运维等角色」
 * 真正岗位向的「销售经理 / 负责运维」仍会命中。
 */
function isIncidentalAvoidMention(text, word) {
  const s = String(text || "");
  const w = String(word || "").trim();
  if (!w) return true;
  const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let m;
  let real = 0;
  while ((m = re.exec(s))) {
    const before = s.slice(Math.max(0, m.index - 6), m.index);
    const after = s.slice(m.index + w.length, m.index + w.length + 8);
    const collabBefore = /(?:与|和|及|、|\/|协同|对接|配合|联动|支持|联合)$/.test(before);
    const collabAfter = /^(?:团队|同事|部门|等角色|角色|管理层|经理做|、|，)/.test(after);
    const trainIncidental =
      /培训/.test(w) && /(?:组织|开展|内部|参加|进行)$/.test(before);
    if (collabBefore || collabAfter || trainIncidental) continue;
    real += 1;
  }
  return real === 0;
}

export function collectAvoidHits(job, profile) {
  const words = [...(profile.avoidSelected || []), ...(profile.avoidCustom || [])];
  // 标题 + 职位标签：强信号；任职要求：过滤协作附带提及。不再扫职责/全文，减少页脚与协同误杀。
  const titleKw = `${job.title || ""}\n${(job.keywords || []).join(",")}`;
  const req = extractRequirementsText(job);
  return (words || []).filter((w) => {
    if (wideHit(titleKw, w)) return true;
    if (!wideHit(req, w)) return false;
    return !isIncidentalAvoidMention(req, w);
  });
}

export function collectAttentionHits(job, profile) {
  const words = [...(profile.attentionSelected || []), ...(profile.attentionCustom || [])];
  const text = `${job.title || ""}\n${(job.keywords || []).join(",")}\n${extractRequirementsText(job)}`;
  return anyHit(text, words);
}

export function directionAllows(job, profile, strict) {
  const tags = profile.directions || [];
  if (!tags.length || !strict) return { allow: true, titleHits: anyHit(job.title || "", tags) };
  const titleHits = anyHit(job.title || "", tags);
  const bodyHits = anyHit(`${job.title || ""}\n${job.description || ""}`, tags);
  const hits = titleHits.length ? titleHits : bodyHits;
  return { allow: hits.length > 0, titleHits: hits };
}

/**
 * 综合分 = Σ(维度分 × 权重%)  
 * 例：技能 80×0.4 + 行业 0×0.2 + 方向 100×0.15 + 证书 100×0.15 + 语言 100×0.1
 */
export function scoreJob(job, profile, settings) {
  const weights = normalizeWeights(settings.weights);
  // 默认硬比例；仅当 settings.softSkillScore === true 时技能用 sqrt 软化
  const useSoftCurve = settings.softSkillScore === true;

  const skill = scoreSkill(job, profile, useSoftCurve);
  const industry = scoreIndustry(job, profile);
  const direction = scoreDirection(job, profile);
  const certificate = scoreCertificate(job, profile);
  const language = scoreLanguage(job, profile);

  const total = Math.round(
    (skill.score * weights.skill +
      industry.score * weights.industry +
      direction.score * weights.direction +
      certificate.score * weights.certificate +
      language.score * weights.language) /
      100
  );

  const avoidHits = collectAvoidHits(job, profile);
  const attentionHits = collectAttentionHits(job, profile);
  const hardGaps = collectHardGaps(job, profile);
  const excluded = avoidHits.length > 0;

  return {
    total,
    excluded,
    avoidHits,
    attentionHits,
    hardGaps,
    dimensions: { skill, industry, direction, certificate, language },
    weights
  };
}
