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
import { collectHardGaps, extractMinYears } from "./recommend.js";
import { evaluateGates, applyGateToScore } from "./gates.js";
import { getDefaultPack } from "./packs/it-delivery-pm.js";
import { denoiseJobText } from "./job-sections.js";
import {
  mapLegacyDimsToPillars,
  weightedPillarTotal,
  normalizePillarWeights,
  PILLAR_KEYS
} from "./pillars.js";
import { semanticDomainGate } from "./semantic-score.js";

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
  return /pmp|prince2|软考|cet|托福|雅思|证书|驾照|注册会计师|信息系统项目管理|cspm|scrum\s*master|建造师|一建|二建/i.test(
    String(tag)
  );
}

function looksLikeMajor(tag) {
  return /专业|本科|硕士|大专|学历/.test(String(tag));
}

function looksLikeMetaTag(tag) {
  return /^(北京|上海|杭州|广州|深圳|成都|南京|武汉|\d+-\d+年|经验不限|应届|在校)/.test(String(tag));
}

/** 福利 chips，不是任职必备能力 */
function looksLikeWelfareTag(tag) {
  return /^(五险一金|绩效奖金|年终奖金|带薪年假|定期体检|节日礼物|团队聚餐|餐费补贴|通讯津贴|提供住宿|外派津贴|弹性工作|扁平管理|领导好|发展空间大|公司规模大|优秀员工奖|加班补助|股票期权|补充医疗|交通补助|住房补贴|双休|周末双休|包吃|包住)$/.test(
    String(tag || "").trim()
  );
}

/** 行业词表：扩展新行业只改这里 */
export const KNOWN_INDUSTRIES = [
  "互联网", "金融", "银行", "证券", "保险", "电商", "教育", "医疗", "游戏",
  "政务", "制造", "汽车", "房地产", "物流", "零售", "人工智能", "大数据",
  "电力", "能源", "石油", "油气", "压裂", "运营商", "通信", "军工", "航空", "航天", "央企", "国企",
  "新能源", "半导体", "芯片", "云计算", "智能制造", "养老", "咨询", "医美"
];

/** 证书词表 */
export const KNOWN_CERTIFICATES = [
  "PMP", "PRINCE2", "软考", "信息系统项目管理师", "系统集成项目管理工程师",
  "CSPM", "Scrum Master", "CPA", "CET-6", "CET-4", "英语六级", "英语四级", "托福", "雅思",
  "一级机电建造师", "二级机电建造师", "一级建造师", "二级建造师", "机电建造师", "建造师"
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
  "Jira", "禅道", "需求分析", "风险管理", "成本管控", "资源协调", "物资调配",
  "进度控制", "里程碑", "实施交付", "验收", "跨部门", "团队管理", "安全管控",
  "高压作业", "HSE", "施工管理", "现场管理",
  "Java", "Python", "SQL", "微服务", "DevOps", "云原生", "容器",
  "大数据", "人工智能", "大模型", "RAG", "AIGC", "数据标注",
  "信息化", "智慧项目", "中台", "产品设计", "PRD",
  "ERP", "OA", "CRM", "SAP", "MES", "WMS", "PLM", "HR系统", "财务系统", "钉钉", "企微", "飞书",
  "漫剧", "短剧", "影视", "动画", "短视频", "内容制作", "内容策划", "编剧", "剧本"
];

/** 过于泛化、不宜单独当「硬技能缺口」的词 */
const GENERIC_CAPABILITY =
  /^(人员|设备|质量|成本|进度|计划|目标|工作|项目|管理|经验|能力|相关|各项|公司|现场|日常|问题|制度|资料|指标|流程|方案|参数|总结|培训|对接|组织|协调|落实|完成|负责|统筹|上级|经营|生产|区域|全部|所有|甲方|项目部)$/;

/**
 * 常见项目管理过程动作：有 PM 经历时视为隐含覆盖，不要求简历写到字面词。
 * （评审会 / 资料归档 / 交付复盘 等属于「做项目就会做」的范围）
 */
const PM_ROUTINE_TERMS = [
  "评审会",
  "项目评审",
  "里程碑评审",
  "阶段评审",
  "资料归档",
  "文档归档",
  "项目归档",
  "交付复盘",
  "项目复盘",
  "复盘总结",
  "会议纪要",
  "周报",
  "月报",
  "日报",
  "进度汇报",
  "例会",
  "站会",
  "晨会",
  "变更管理",
  "变更控制",
  "风险跟踪",
  "问题跟踪",
  "问题清单",
  "里程碑跟进",
  "干系人沟通",
  "干系人管理",
  "验收材料",
  "验收文档",
  "移交文档",
  "项目文档",
  "过程文档",
  "计划跟踪",
  "进度跟踪",
  "任务拆解",
  "任务分配",
  "资源协调",
  "跨部门协调",
  "跨部门沟通"
];

const PM_BACKGROUND_RE =
  /项目经理|项目管理|项目主管|交付经理|实施经理|PMO|PMP|CSPM|敏捷教练|Scrum\s*Master|项目集|项目群/i;

function hasPmBackground(profile) {
  const bag = [
    ...(profile.skills || []),
    ...(profile.directions || []),
    ...(profile.certificates || []),
    profile.resumeText || ""
  ].join("\n");
  return PM_BACKGROUND_RE.test(bag);
}

function isPmRoutineTerm(term) {
  const t = String(term || "").trim();
  if (!t) return false;
  if (PM_ROUTINE_TERMS.some((x) => x === t || wideHit(t, x) || wideHit(x, t))) return true;
  // 未枚举全的近义：含「归档/复盘/评审会/纪要」且偏过程、非行业专有
  return /^(?:项目|阶段|里程碑|交付|资料|文档|过程)?.{0,6}(?:归档|复盘|评审会|例会|纪要|周报|月报)$/.test(t);
}

function splitClauses(text) {
  return String(text || "")
    .replace(/\u2f00-\u2fd5/g, "") // 兼容异体
    .split(/[。；;\n]|(?=\d+[\.、])|(?=英语|英文)/)
    .map((s) => s.trim().replace(/⾼/g, "高").replace(/⼯/g, "工"))
    .filter((s) => s.length >= 2);
}

function isPreferredClause(clause) {
  return /优先|加分项|加分|尤佳|更好|最佳|优先考虑|可考虑/.test(clause);
}

function isMustClause(clause) {
  return /必须|必备|硬性|须具备|需要具备|要求具备|强制|作为工作语言|工作语言|无障碍/.test(clause);
}

function isHardSignalClause(clause) {
  return /熟练|精通|掌握|熟悉|具备|要求|必须|需要|经验|能力|背景|从业|从事|持有|证书|责任|独立负责|工作语言|可作为工作语言|流利|无障碍|读写|听说|统筹|负责|审核|监督|把控|执行/.test(
    clause
  );
}

/**
 * 「精通 ERP、OA、CRM 等至少一种」——整句是或选，命中任一即满足该需求单元。
 */
function isOrChoiceClause(clause) {
  const c = String(clause || "");
  if (/至少一[种种项个]|任[一选]|其中一[种种项]|任意一[种种项]|之一即可|之一|熟悉其中|掌握其中|精通其中|会其中/.test(c)) {
    return true;
  }
  // 精通/熟悉 A或B（或C）；或 A/B/C
  if (
    /(?:精通|熟悉|掌握|了解|具备|使用过|用过|熟练)/.test(c) &&
    (/[A-Za-z\u4e00-\u9fff]{1,12}(?:\s*[\/]\s*[A-Za-z\u4e00-\u9fff]{1,12}){1,8}/.test(c) ||
      /[A-Za-z\u4e00-\u9fff]{1,12}\s*或\s*[A-Za-z\u4e00-\u9fff]{1,12}/.test(c))
  ) {
    return true;
  }
  return false;
}

/** 从或选句抽出候选工具/技能词 */
function extractOrAlternatives(clause, vocab = []) {
  const c = String(clause || "");
  const m = c.match(
    /(?:精通|熟悉|掌握|了解|具备|使用过|用过|熟练使用)([^。；;\n]{2,100})/
  );
  let chunk = m ? m[1] : c;
  chunk = chunk
    .replace(/等[^，。；\n]{0,12}$/g, "")
    .replace(/(?:至少|其中|任意|任选|之一).*$/g, "")
    .replace(/^(?:如|例如|包括|：|:)\s*/g, "");

  const parts = chunk
    .split(/[、，,/]|或/)
    .map((s) => {
      let x = s.replace(/^(?:如|例如|包括)\s*/g, "").trim();
      // Python开发 → Python；OA系统 → OA（短词保留）
      const stripped = x.replace(/(?:开发|编程|语言|系统|软件|平台|工具)$/u, "");
      if (stripped.length >= 2 && stripped.length < x.length) {
        if ((vocab || []).some((v) => wideHit(v, stripped) || v === stripped) || /^(ERP|OA|CRM|SAP|MES|WMS|PLM|Java|Python|SQL|Go|C\+\+)$/i.test(stripped)) {
          x = stripped;
        }
      }
      return x;
    })
    .filter((s) => {
      if (!s || s.length < 2 || s.length > 16) return false;
      if (/至少|优先|经验|能力|要求|相关|等等|一种|一项|即可/.test(s)) return false;
      if (GENERIC_CAPABILITY.test(s)) return false;
      return /[A-Za-z\u4e00-\u9fff]/.test(s);
    });

  const fromVocab = (vocab || []).filter((t) => c.includes(t) || wideHit(c, t));
  return pruneSubterms([...new Set([...parts, ...fromVocab])]).slice(0, 10);
}

function formatOrGroupLabel(terms) {
  const head = terms.slice(0, 5).join("/");
  return `${head}${terms.length > 5 ? "…" : ""}（至少一种）`;
}

/** 去掉被更长词覆盖的短词，避免「压裂 / 压裂施工 / 压裂施工项目」重复 */
function pruneSubterms(terms) {
  const arr = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
  const kept = [];
  for (const t of arr) {
    if (kept.some((k) => k !== t && k.includes(t))) continue;
    kept.push(t);
  }
  return kept;
}

/** 领域词：职业包 domainMustHints + 少量通用现场词（个案行业词不写死在引擎） */
function domainHintsList() {
  const pack = getDefaultPack();
  return [
    ...(pack.domainMustHints || []),
    "现场管理",
    "施工管理",
    "HSE",
    "安全管控",
    "物资调配"
  ];
}

/** 从分句抽出领域能力词 */
function extractDomainTermsFromClause(clause) {
  const c = String(clause || "").replace(/⾼/g, "高").replace(/⼯/g, "工");
  const found = new Set();
  for (const k of domainHintsList()) {
    if (c.includes(k) || wideHit(c, k)) found.add(k);
  }
  return pruneSubterms([...found]);
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
 * 先识别岗位能力标签，再区分必须 / 优先 / 加分，并对照画像给出未满足列表。
 * 「精通 A、B、C 至少一种」收成一个或选单元：命中任一即覆盖，不要求全中。
 * 匹配度按「需求单元覆盖率」= 已满足单元 / 全部单元。
 */
export function buildRequirementInventory(job, profile) {
  const must = new Set();
  const preferred = new Set();
  const bonus = new Set();
  /** @type {{ mode: 'any'|'all', terms: string[], label: string }[]} */
  const mustUnits = [];
  const orTermSet = new Set(); // 已并入或选组的词，避免再当独立必备

  const bossTags = (job.keywords || []).filter(
    (t) =>
      t &&
      !looksLikeCertificate(t) &&
      !looksLikeMajor(t) &&
      !looksLikeMetaTag(t) &&
      !looksLikeWelfareTag(t)
  );
  const userBag = [
    ...(profile.skills || []),
    ...(profile.industries || []),
    ...(profile.directions || []),
    ...(profile.certificates || []),
    ...(profile.languages || [])
  ];
  const vocab = [
    ...new Set([
      ...KNOWN_SKILLS,
      ...PM_ROUTINE_TERMS,
      ...KNOWN_INDUSTRIES,
      ...KNOWN_LANGUAGES,
      ...KNOWN_CERTIFICATES,
      ...bossTags,
      ...userBag
    ])
  ].sort((a, b) => b.length - a.length);

  const normalizeTerm = (term) => {
    let t = String(term || "").trim();
    if (!t || t.length < 2 || t.length > 16) return "";
    if (GENERIC_CAPABILITY.test(t)) return "";
    if (looksLikeMetaTag(t) || looksLikeWelfareTag(t)) return "";
    if (/英语|英文|CET|六级|四级|托福|雅思/.test(t) && !/日语/.test(t)) {
      t = /六级|CET-?6/i.test(t) ? "英语六级" : "英语";
    }
    return t;
  };

  const addTerm = (term, tier) => {
    const t = normalizeTerm(term);
    if (!t) return;
    if (tier === "bonus") {
      bonus.add(t);
      preferred.delete(t);
      must.delete(t);
    } else if (tier === "preferred") {
      if (!must.has(t)) preferred.add(t);
      bonus.delete(t);
    } else {
      must.add(t);
      preferred.delete(t);
      bonus.delete(t);
    }
  };

  const addOrUnit = (terms, tier) => {
    const cleaned = pruneSubterms(terms.map(normalizeTerm).filter(Boolean));
    if (cleaned.length < 2) {
      for (const t of cleaned) addTerm(t, tier);
      return;
    }
    if (tier === "bonus" || tier === "preferred") {
      // 优先/加分的或选：命中任一即可进 hit，不拆成多个缺口
      for (const t of cleaned) addTerm(t, tier);
      return;
    }
    const label = formatOrGroupLabel(cleaned);
    mustUnits.push({ mode: "any", terms: cleaned, label });
    for (const t of cleaned) {
      orTermSet.add(t);
      must.add(t); // 保留扁平列表便于展示「可选词」
    }
  };

  const absorbClause = (clause, defaultTier) => {
    let tier = defaultTier;
    if (isPreferredClause(clause)) tier = "preferred";
    else if (isMustClause(clause)) tier = "must";

    if (tier === "must" && isOrChoiceClause(clause)) {
      const alts = extractOrAlternatives(clause, vocab);
      if (alts.length >= 2) {
        addOrUnit(alts, tier);
        // 或选句里的英语工作语言等仍可单独处理
        if (/英语|英文/.test(clause) && /工作语言|流利|无障碍/.test(clause)) {
          addTerm("英语", "must");
        }
        return;
      }
    }

    for (const term of vocab) {
      if (!wideHit(clause, term) && !clause.includes(term)) continue;
      if (tier === "must" && !isHardSignalClause(clause) && !isMustClause(clause) && defaultTier !== "must") {
        continue;
      }
      addTerm(term, tier);
    }
    for (const term of extractDomainTermsFromClause(clause)) {
      addTerm(term, tier === "preferred" || tier === "bonus" ? tier : defaultTier === "bonus" ? "bonus" : "must");
    }
    if (/英语|英文/.test(clause) && /工作语言|流利|无障碍|会议|文档|读写|听说|商务沟通/.test(clause)) {
      addTerm("英语", isPreferredClause(clause) ? "preferred" : "must");
    }
  };

  for (const t of bossTags) addTerm(t, "must");
  for (const clause of splitClauses(job.title || "")) {
    for (const term of extractDomainTermsFromClause(clause)) addTerm(term, "must");
    for (const term of vocab) {
      if (wideHit(clause, term) || clause.includes(term)) addTerm(term, "must");
    }
  }

  const reqText = extractRequirementsText(job);
  for (const clause of splitClauses(reqText)) absorbClause(clause, "must");
  for (const clause of splitClauses(job.responsibilities || "")) absorbClause(clause, "must");
  for (const clause of splitClauses(job.bonus || "")) absorbClause(clause, "bonus");

  // 独立必备 = 未并入或选组的 must 词
  for (const t of [...must]) {
    if (orTermSet.has(t)) continue;
    if (mustUnits.some((u) => u.terms.includes(t))) continue;
    mustUnits.push({ mode: "all", terms: [t], label: t });
  }

  const mustArr = pruneSubterms([...must]);
  const preferredArr = pruneSubterms([...preferred].filter((t) => !must.has(t)));
  const bonusArr = pruneSubterms([...bonus].filter((t) => !must.has(t) && !preferred.has(t)));

  const pmBg = hasPmBackground(profile);

  const matchBag = (term) => {
    if (
      userMatches(profile.skills, term) ||
      userMatches(profile.industries, term) ||
      userMatches(profile.directions, term) ||
      userMatches(profile.certificates, term) ||
      userMatches(profile.languages, term) ||
      textMentionsTerm(profile.resumeText || "", term)
    ) {
      return true;
    }
    // 有 PM 背景时，常见过程动作视为隐含覆盖
    if (pmBg && isPmRoutineTerm(term)) return true;
    return false;
  };

  const unitSatisfied = (unit) => {
    if (!unit?.terms?.length) return false;
    if (unit.mode === "any") return unit.terms.some(matchBag);
    return unit.terms.every(matchBag);
  };

  const mustHitUnits = mustUnits.filter(unitSatisfied);
  const mustMissUnits = mustUnits.filter((u) => !unitSatisfied(u));
  // 对外：命中/未满足用「单元标签」；或选未中显示「A/B/C（至少一种）」而非三个缺口
  const mustHit = mustHitUnits.map((u) => {
    if (u.mode === "any") {
      const hit = u.terms.filter(matchBag).slice(0, 3).join("/");
      return `${u.terms.slice(0, 5).join("/")}（已满足其一：${hit}）`;
    }
    if (pmBg && u.terms.every(isPmRoutineTerm) && !u.terms.some((t) =>
      userMatches(profile.skills, t) ||
      userMatches(profile.directions, t) ||
      textMentionsTerm(profile.resumeText || "", t)
    )) {
      return `${u.label}（PM经历隐含）`;
    }
    return u.label;
  });
  const mustMiss = mustMissUnits.map((u) => u.label);

  const preferredHit = preferredArr.filter(matchBag);
  const preferredMiss = preferredArr.filter((t) => !matchBag(t));
  const bonusHit = bonusArr.filter(matchBag);
  const bonusMiss = bonusArr.filter((t) => !matchBag(t));

  return {
    must: mustArr,
    preferred: preferredArr,
    bonus: bonusArr,
    /** 需求单元（或选算 1 个）：用于覆盖率打分 */
    mustUnits,
    mustHit,
    mustMiss,
    mustHitUnits,
    mustMissUnits,
    preferredHit,
    preferredMiss,
    bonusHit,
    bonusMiss,
    coverage:
      mustUnits.length === 0
        ? 1
        : mustHitUnits.length / mustUnits.length
  };
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

/** 正文命中，但「无 ERP / 没有 OA / 不懂 Java」不算满足 */
function textMentionsTerm(text, term) {
  const t = String(text || "");
  const k = String(term || "");
  if (!k || (!wideHit(t, k) && !t.includes(k))) return false;
  try {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:无|没有|不具备|不熟悉|不懂|不会|非)\\s*${esc}`, "i").test(t)) {
      return false;
    }
  } catch {
    /* ignore */
  }
  return true;
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
 * 技能维：以「必须」需求单元为主（或选组算 1 个单元），优先/加分不进分母。
 * 得分 = 已覆盖单元 / 全部单元 × 100（相对岗位需求的简历覆盖率）
 */
function scoreSkill(job, profile, useSoftCurve, inventory) {
  const userSkills = profile.skills || [];
  const inv = inventory || buildRequirementInventory(job, profile);
  const soft = [...(inv.preferred || []), ...(inv.bonus || [])];

  const isSkillUnit = (unit) => {
    const terms = unit?.terms || [];
    return terms.some((t) => {
      if (looksLikeCertificate(t)) return false;
      if (KNOWN_LANGUAGES.some((l) => wideHit(t, l) || wideHit(l, t))) return false;
      if (KNOWN_INDUSTRIES.includes(t) && t.length <= 3 && !/压裂|石油|油气/.test(t)) return false;
      return true;
    });
  };

  let units = (inv.mustUnits || []).filter(isSkillUnit);
  // 兼容旧 inventory（无 mustUnits）
  if (!units.length && (inv.must || []).length) {
    units = inv.must
      .filter(
        (t) =>
          !looksLikeCertificate(t) &&
          !KNOWN_LANGUAGES.some((l) => wideHit(t, l) || wideHit(l, t))
      )
      .map((t) => ({ mode: "all", terms: [t], label: t }));
  }

  if (!units.length) {
    return {
      score: 100,
      detail: "未识别到明确技能硬要求，中性分 100",
      hits: [],
      required: [],
      miss: [],
      soft
    };
  }

  const bag = [...userSkills, ...(profile.directions || [])];
  const resume = profile.resumeText || "";
  const pmBg = hasPmBackground(profile);
  const termHit = (t) =>
    userMatches(bag, t) || textMentionsTerm(resume, t) || (pmBg && isPmRoutineTerm(t));
  const unitHit = (u) =>
    u.mode === "any" ? u.terms.some(termHit) : u.terms.every(termHit);

  const hits = units.filter(unitHit).map((u) => u.label);
  const miss = units.filter((u) => !unitHit(u)).map((u) => u.label);
  const raw = ratioScore(hits.length, units.length);
  const score = useSoftCurve ? softCoverage(hits.length, units.length) : raw;
  return {
    score,
    detail: `需求覆盖 ${hits.length}/${units.length} → ${score}${miss.length ? `；未满足：${miss.slice(0, 8).join("、")}` : ""}`,
    hits,
    required: units.map((u) => u.label),
    miss,
    soft
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

function scoreLanguage(job, profile, inventory) {
  const user = profile.languages || [];
  const inv = inventory || buildRequirementInventory(job, profile);
  const hardList = (inv.must || []).filter(
    (t) => /英语|英文|日语|六级|四级|CET|托福|雅思/.test(t)
  );
  const softList = [...(inv.preferred || []), ...(inv.bonus || [])].filter((t) =>
    /英语|英文|日语|六级|四级|CET|托福|雅思/.test(t)
  );

  // 兜底：全文「英语可作为工作语言」类
  if (!hardList.length) {
    const full = `${extractRequirementsText(job)}\n${job.description || ""}\n${job.responsibilities || ""}`;
    for (const clause of splitClauses(full)) {
      if (/英语|英文/.test(clause) && /工作语言|流利|无障碍|会议|文档|商务沟通/.test(clause)) {
        if (isPreferredClause(clause)) softList.push("英语");
        else hardList.push("英语");
      }
    }
  }

  const hard = [...new Set(hardList)];
  const soft = [...new Set(softList)];

  if (hard.length) {
    if (!user.length) {
      return {
        score: 0,
        detail: `语言硬要求未满足（要求：${hard.join("、")}；画像未填语言）`,
        hits: [],
        hard,
        soft,
        miss: hard
      };
    }
    const { score, hits, miss } = matchRatio(hard, user);
    return {
      score,
      detail: `语言硬要求 ${hits.length}/${hard.length} → ${score}${miss.length ? `；未满足：${miss.join("、")}` : ""}`,
      hits,
      hard,
      soft,
      miss
    };
  }

  if (soft.length) {
    const hits = soft.filter((h) => userMatches(user, h));
    return {
      score: 100,
      detail: hits.length
        ? `优先语言命中：${hits.join("、")}`
        : `仅语言「优先/加分」，未命中不扣分`,
      hits,
      hard: [],
      soft
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

const SOFT_REQ_CLAUSE =
  /善于沟通|团队合作|学习能力|责任心|抗压|认真负责|按时完成|融入团队|改进工作|积极主动|吃苦耐劳|执行力强|良好的沟通|团队精神/;
const GENERIC_ROLE_TERM = /^(项目经理|项目管理|PMO|pm|AI|人工智能)$/i;

function normalizeJobForScoring(job) {
  if (!job) return job;
  const copy = { ...job };
  for (const k of ["title", "description", "requirements", "responsibilities", "bonus"]) {
    if (copy[k]) copy[k] = denoiseJobText(copy[k]);
  }
  return copy;
}

/**
 * JD 具体度：要求越空/越套话，分越低。
 * 解决「没写行业技术 → 各维中性 100 → 总分虚高」。
 */
export function assessJdConcrete(job, inventory) {
  const reasons = [];
  let score = 72;
  const must = inventory?.must || [];
  const concrete = must.filter((t) => !GENERIC_ROLE_TERM.test(String(t).trim()));
  const req = extractRequirementsText(job);
  const clauses = splitClauses(req).filter((c) => c.length >= 4);
  const softN = clauses.filter((c) => SOFT_REQ_CLAUSE.test(c)).length;
  const resp = String(job.responsibilities || "");
  const blob = `${req}\n${resp}\n${job.title || ""}`;

  if (concrete.length >= 3) score += 18;
  else if (concrete.length === 0) {
    score -= 28;
    reasons.push("未识别到具体行业/技术硬要求");
  } else if (concrete.length === 1) {
    score -= 12;
    reasons.push("硬要求过少，岗位画像偏空");
  }

  if (clauses.length && softN / clauses.length >= 0.7) {
    score -= 22;
    reasons.push("任职要求多为软素质套话");
  }
  if (resp.replace(/\s/g, "").length < 36) {
    score -= 18;
    reasons.push("工作职责过短或未写清业务内容");
  }
  if (/业务可以不熟悉|经验不限|无经验要求|不限经验/.test(blob)) {
    score -= 14;
    reasons.push("JD 声明业务可不熟悉或经验不限");
  }
  if (extractMinYears(req) != null) score += 8;
  if (must.some((t) => looksLikeCertificate(t))) score += 8;
  if ((job.keywords || []).length >= 3) score += 4;

  score = Math.max(12, Math.min(100, score));
  return {
    score,
    sparse: score < 48,
    thin: score < 62,
    reasons
  };
}

function applyConcreteToNeutralDim(dim, concrete) {
  if (!dim || (!concrete.sparse && !concrete.thin)) return dim;
  if (!/中性分 100|无明确|JD 未明确|未识别到明确|无语言硬要求/.test(dim.detail || "")) {
    return dim;
  }
  const cap = concrete.sparse ? 42 : 58;
  if ((dim.score ?? 100) <= cap) return dim;
  return {
    ...dim,
    score: cap,
    detail: `${dim.detail}；JD具体度${concrete.score}→中性维上限${cap}`
  };
}

/**
 * 综合分 = Σ(维度分 × 权重%)，再按 JD 具体度收敛虚高
 */
export function scoreJob(job, profile, settings) {
  const weights = normalizeWeights(settings.weights);
  const useSoftCurve = settings.softSkillScore === true;
  job = normalizeJobForScoring(job);

  const requirements = buildRequirementInventory(job, profile);
  const concrete = assessJdConcrete(job, requirements);

  let skill = scoreSkill(job, profile, useSoftCurve, requirements);
  let industry = scoreIndustry(job, profile);
  let direction = scoreDirection(job, profile);
  let certificate = scoreCertificate(job, profile);
  let language = scoreLanguage(job, profile, requirements);

  // 空泛 JD：中性满分维降档（方向标题命中仍可保留较高，但证书/语言/空行业要降）
  industry = applyConcreteToNeutralDim(industry, concrete);
  certificate = applyConcreteToNeutralDim(certificate, concrete);
  language = applyConcreteToNeutralDim(language, concrete);
  if (concrete.sparse && /中性分 100|未识别到明确技能硬要求/.test(skill.detail || "")) {
    skill = applyConcreteToNeutralDim(skill, concrete);
  }
  // 方向仅靠标题「项目经理」且 JD 空泛 → 略降，避免空岗靠方向拉满
  if ((concrete.sparse || concrete.thin) && /标题命中方向/.test(direction.detail || "")) {
    const cap = concrete.sparse ? 70 : 85;
    if ((direction.score ?? 100) > cap) {
      direction = {
        ...direction,
        score: cap,
        detail: `${direction.detail}；JD具体度偏低→方向上限${cap}`
      };
    }
  }

  const avoidHits = collectAvoidHits(job, profile);
  const attentionHits = collectAttentionHits(job, profile);
  const hardGaps = collectHardGaps(job, profile);
  for (const m of (requirements.mustMiss || []).slice(0, 12)) {
    if (/英语|英文|日语|六级|四级/.test(m)) hardGaps.push(`必备语言：${m}`);
    else hardGaps.push(`必备能力：${m}`);
  }
  if (concrete.sparse || concrete.thin) {
    hardGaps.push(`JD具体度偏低（${concrete.score}）：${(concrete.reasons || []).slice(0, 2).join("；") || "要求偏空泛"}`);
  }
  const uniqGaps = [...new Set(hardGaps)];
  const excluded = avoidHits.length > 0;

  // 四维：规则映射为兜底；有 Key 时由 mergeSemanticIntoScore 覆盖
  const pillarWeights = normalizePillarWeights(weights);
  const pillars = mapLegacyDimsToPillars({
    skill,
    industry,
    direction,
    certificate,
    language
  });
  // 具体度缩放作用在四维总分上
  let pillarTotal = weightedPillarTotal(pillars, pillarWeights);
  const scale = 0.5 + 0.5 * (concrete.score / 100);
  pillarTotal = Math.round(pillarTotal * scale);
  if (concrete.sparse) pillarTotal = Math.min(pillarTotal, 58);
  else if (concrete.thin) pillarTotal = Math.min(pillarTotal, 72);

  const base = {
    total: pillarTotal,
    excluded,
    avoidHits,
    attentionHits,
    hardGaps: uniqGaps,
    requirements,
    jdConcrete: concrete,
    pillars,
    /** @deprecated 旧五维，导出兼容 */
    dimensions: { skill, industry, direction, certificate, language },
    weights: pillarWeights,
    scoreMode: "rule"
  };

  const pack = getDefaultPack();
  // 同步阶段：职业包域词仅作兜底；有语义结果时 mergeSemanticIntoScore 会替换域门禁
  const gates = evaluateGates(job, profile, pack, { skipPackDomain: false });
  return applyGateToScore(base, gates);
}

/**
 * 用语义/向量四维覆盖规则四维，并可用语义领域门禁替代词表域门禁
 */
export function mergeSemanticIntoScore(score, semantic, settings) {
  if (!score || !semantic?.pillars) return score;
  const pillarWeights = normalizePillarWeights(settings?.weights || score.weights);
  const pillars = {};
  for (const k of PILLAR_KEYS) {
    pillars[k] = { ...(semantic.pillars[k] || { score: 50, detail: "", source: "llm" }) };
  }

  let total = weightedPillarTotal(pillars, pillarWeights);
  const concrete = score.jdConcrete;
  if (concrete) {
    const scale = 0.5 + 0.5 * (concrete.score / 100);
    total = Math.round(total * scale);
    if (concrete.sparse) total = Math.min(total, 58);
    else if (concrete.thin) total = Math.min(total, 72);
  }

  // 保留证书/年限/语言门禁，去掉词表域，换上语义域
  const prev = score.gates || { assertions: [], failed: [], status: "pass" };
  const kept = (prev.assertions || []).filter((a) => a.type !== "domain");
  const dom = semanticDomainGate(semantic, 35);
  if (dom) kept.push(dom);
  const failed = kept.filter((a) => a.result === "fail" || a.result === "unknown");
  const gates = {
    ...prev,
    assertions: kept,
    failed,
    status: failed.length ? "fail" : "pass",
    packId: prev.packId
  };

  const next = {
    ...score,
    pillars,
    total,
    weights: pillarWeights,
    scoreMode: semantic.mode || "llm",
    semantic: {
      mode: semantic.mode,
      providerLabel: semantic.providerLabel,
      jobDomain: semantic.jobDomain,
      resumeDomain: semantic.resumeDomain
    },
    // 同步旧 dimensions 便于旧 UI：能力←capability 等
    dimensions: {
      skill: {
        score: pillars.capability.score,
        detail: pillars.capability.detail
      },
      industry: {
        score: pillars.domain.score,
        detail: pillars.domain.detail
      },
      direction: {
        score: pillars.role.score,
        detail: pillars.role.detail
      },
      certificate: {
        score: pillars.qualify.score,
        detail: pillars.qualify.detail
      },
      language: {
        score: pillars.qualify.score,
        detail: "已并入资质条件维"
      }
    }
  };

  return applyGateToScore(next, gates);
}
