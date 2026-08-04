/**
 * 标题强跨域预筛：差异过大则跳过开详情，直接「已排除」。
 * 通用引擎；不依赖某一职业包，可与画像行业/方向对消。
 */

/** 标题出现且画像无关时，视为强异域专业岗 */
export const STRONG_FOREIGN_TITLE_TERMS = [
  // 半导体 / 电子硬件
  "芯片",
  "半导体",
  "晶圆",
  "光刻",
  "封测",
  "wafer",
  "集成电路",
  // 电力能源
  "电力",
  "电网",
  "变电",
  "配电",
  "输电",
  "电厂",
  "继电保护",
  "输配电",
  // 医疗
  "医院",
  "临床",
  "医护",
  "护理部",
  "药事",
  "医师",
  "护士长",
  "门诊",
  "住院部",
  // 体育赛事
  "马拉松",
  "赛事运营",
  "体育赛事",
  // 土建 / 现场工程
  "土建",
  "土木工程",
  "建筑施工",
  "施工员",
  "施工管理",
  "热力",
  "暖通",
  "供热",
  "压裂",
  "石油工程",
  "井场",
  "驻井",
  "矿井",
  "煤矿",
  // 汽车硬科技产线（无软化词时）
  "ecu",
  "汽车ecu",
  "座舱硬件",
  "智驾硬件",
  "主机厂质量",
  // 内容制作实体
  "漫剧",
  "短剧拍摄",
  "影视制片",
  "动画分镜",
  // 其它强专业
  "律师事务所",
  "出庭律师",
  "注册会计师事务所",
  "厨师长",
  "面点师",
  "美容师",
  "美发店",
  "驾校教练"
];

/**
 * 标题同时带这些词时，可能是信息化/交付岗，不因异域词误杀。
 * 注意：不含「项目经理/PMO」本身——否则「芯片项目经理」会永远跳不过。
 */
const SOFTEN_TITLE_RE =
  /信息化|数字化|软件|系统|saas|paas|交付|实施|研发|互联网|\bai\b|大模型|数据中台|erp|oa|crm|devops|云原生|技术经理|产品经理/i;

function norm(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, "");
}

function profileBag(profile) {
  return norm(
    [
      ...(profile?.industries || []),
      ...(profile?.directions || []),
      ...(profile?.skills || []),
      String(profile?.resumeText || "").slice(0, 800)
    ].join("|")
  );
}

/**
 * @returns {{ skip: boolean, term?: string, reason?: string }}
 */
export function matchTitleDomainSkip(title, profile) {
  const t = String(title || "").trim();
  if (!t || t.length < 2) return { skip: false };
  if (SOFTEN_TITLE_RE.test(t)) return { skip: false };

  const titleN = norm(t);
  const bag = profileBag(profile);
  for (const term of STRONG_FOREIGN_TITLE_TERMS) {
    const tn = norm(term);
    if (!tn || tn.length < 2) continue;
    if (!titleN.includes(tn) && !t.includes(term)) continue;
    // 画像已覆盖该域 → 不跳过
    if (bag.includes(tn) || bag.includes(norm(term))) continue;
    return {
      skip: true,
      term,
      reason: `标题跨域（${term}），跳过详情`
    };
  }
  return { skip: false };
}

/** 构造「已排除」分数，供不开详情直接入库结果 */
export function buildTitleDomainExcludeScore(term) {
  const label = term ? `跨域标题：${term}` : "跨域标题";
  return {
    total: 12,
    fitTotal: 12,
    excluded: true,
    avoidHits: [label],
    attentionHits: [],
    hardGaps: [],
    softGaps: [],
    requirements: { must: [], mustMiss: [], preferred: [], preferredMiss: [], bonus: [], bonusMiss: [] },
    pillars: {
      role: { score: 20, detail: "未开详情", source: "rule" },
      domain: { score: 8, detail: label, source: "rule" },
      capability: { score: 15, detail: "未开详情", source: "rule" },
      qualify: { score: 50, detail: "未开详情", source: "rule" }
    },
    gateStatus: "fail",
    gateLabel: "标题跨域已排除",
    gateFailed: [label],
    scoreMode: "rule",
    jdConcrete: { score: 40, sparse: false, thin: true, reasons: ["仅列表标题判定"] }
  };
}
