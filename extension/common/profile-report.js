/**
 * 简历侧写：规则轨完整分析 + 可选 AI 增强
 */
import { getDefaultPack } from "./packs/it-delivery-pm.js";
import { chatCompletion, resolveLlmConfig } from "./llm.js";

function join(arr) {
  return (arr || []).filter(Boolean).join("、") || "（未填写）";
}

/** 规则侧写：无模型也要有完整分析结构 */
export function buildRuleProfileReport(profile, pack = getDefaultPack()) {
  const years = Number(profile.yearsExperience) || 0;
  const skills = profile.skills || [];
  const industries = profile.industries || [];
  const directions = profile.directions || [];
  const certs = profile.certificates || [];
  const languages = profile.languages || [];
  const resume = profile.resumeText || "";

  const roleBits = [];
  if (directions.some((d) => /项目经理|PMO|交付|实施/.test(d))) roleBits.push("交付/项目管理方向");
  if (skills.some((s) => /开发|Java|Python|前端|后端/.test(s))) roleBits.push("具备研发技术背景");
  if (skills.some((s) => /DevOps|云原生|Kubernetes|容器|CI/.test(s))) roleBits.push("偏研运效能与云原生落地");
  if (skills.some((s) => /大模型|RAG|AI|人工智能|AIGC/.test(s))) roleBits.push("具备 AI 应用实践色彩");
  const roleLabel =
    roleBits.length > 0 ? roleBits.join("；") : "通用求职者（请补充方向词与技能标签以提升侧写精度）";

  const pillars = [];
  if (years >= 5 || skills.some((s) => /项目/.test(s))) {
    pillars.push({
      title: "项目交付与统筹",
      detail: years
        ? `工作年限约 ${years} 年，标签含：${join(skills.filter((s) => /项目|交付|管理|风险|进度|PMO/.test(s)).slice(0, 6))}`
        : `技能标签体现交付相关能力：${join(skills.slice(0, 8))}`
    });
  }
  if (industries.length) {
    pillars.push({
      title: "行业轨迹",
      detail: `已标注行业：${join(industries)}。跨行业岗位将触发领域门禁，请确认标签真实覆盖经历。`
    });
  }
  if (certs.length) {
    pillars.push({
      title: "资质证书",
      detail: `已登记：${join(certs)}。JD 要求「持有××证书」且不在此列时，将判定硬门槛未通过。`
    });
  } else {
    pillars.push({
      title: "资质证书",
      detail: "未登记证书。若目标岗常见建造师/PMP 等硬性证书，请务必补全，否则门禁易失败。"
    });
  }
  if (languages.length) {
    pillars.push({
      title: "语言能力",
      detail: `已登记：${join(languages)}。可用于「英语工作语言」类硬要求核验。`
    });
  } else {
    pillars.push({
      title: "语言能力",
      detail:
        "未登记语言。岗位若要求「英语可作为工作语言/无障碍英文会议」，将按未通过处理（严策略）。若具备请补标签或写进简历正文后重新提取。"
    });
  }
  if (skills.some((s) => /AI|大模型|RAG|AIGC/.test(s)) || /大模型|RAG|人工智能/.test(resume)) {
    pillars.push({
      title: "AI 应用实践",
      detail: "简历/标签含 AI 相关表述，适合带 AI 落地色彩的交付或产品型项目经理，不宜直接对标算法研究岗。"
    });
  }

  const gaps = [];
  if (!years) gaps.push("工作年限未填或为 0，年限类硬门槛会判未知/失败");
  if (!languages.length) gaps.push("语言未填：遇英语工作语言硬要求将门禁失败");
  if (!certs.length) gaps.push("证书未填：遇「持有××证书」硬要求将门禁失败");
  if (!directions.length) gaps.push("方向词为空：角色定位偏弱，建议至少填写目标岗位方向");
  if (!industries.length) gaps.push("行业标签为空：领域门禁与行业契合都会偏保守");

  const paragraphs = [
    `【角色倾向】${roleLabel}。当前职业包：${pack.label}。`,
    `【能力与标签】技能 ${join(skills)}；方向 ${join(directions)}。以上为规则归纳，请人工核对是否与简历事实一致。`,
    `【行业与资质】行业 ${join(industries)}；证书 ${join(certs)}；语言 ${join(languages)}；年限 ${years || "未填"}。`,
    `【门禁提示】系统将按「必须证书 / 必须语言 / 必须年限 / 硬性领域」做 PASS/FAIL；未填写视为不满足（严策略）。优先/加分项不挡门禁。`,
    `【适合方向】见下方「适合分析的岗位类型」。异域工程、强执业资格、未证明的英语工作语言岗，即使标题是项目经理，也很可能「硬门槛未过」。`,
    gaps.length ? `【待补全】${gaps.join("；")}。` : "【待补全】关键字段较完整，可直接用于精筛。"
  ];

  return {
    mode: "rule",
    packId: pack.id,
    packLabel: pack.label,
    roleLabel,
    pillars,
    paragraphs,
    suitableRoles: pack.suitableRoles || [],
    cautiousRoles: pack.cautiousRoles || [],
    gaps,
    generatedAt: Date.now()
  };
}

export function formatProfileReportText(report) {
  if (!report) return "";
  const lines = [
    `侧写模式：${report.mode === "ai" ? "AI 增强" : "规则分析"}`,
    `职业包：${report.packLabel || ""}`,
    "",
    ...(report.paragraphs || []),
    "",
    "【能力支柱】",
    ...(report.pillars || []).map((p, i) => `${i + 1}. ${p.title}：${p.detail}`),
    "",
    "【适合分析的岗位类型】",
    ...(report.suitableRoles || []).map((r, i) => `${i + 1}. ${r}`),
    "",
    "【通常需谨慎的类型】",
    ...(report.cautiousRoles || []).map((r, i) => `${i + 1}. ${r}`)
  ];
  return lines.join("\n");
}

/** AI 侧写：在规则报告基础上生成叙述 */
export async function buildAiProfileReport({ profile, settings, pack = getDefaultPack() }) {
  const base = buildRuleProfileReport(profile, pack);
  const { provider, apiKey } = resolveLlmConfig(settings);
  if (!apiKey) throw new Error(`未配置 ${provider.label} API Key`);

  const system = `你是职业顾问。根据候选人结构化标签与简历正文，输出清晰的「求职适配侧写」（不要做 MBTI 人格测试）。
必须用中文，按以下小标题输出（保留标题）：
- 角色定位
- 能力支柱（3-5条，尽量点明可从简历验证的方向）
- 行业轨迹（强/弱）
- 资质与语言状态
- 适合投递的岗位类型
- 建议谨慎的岗位类型
- 简历补强建议
不要编造证书或年限；标签未体现的能力请写「未在材料中证明」。`;

  const user = [
    `职业包：${pack.label}`,
    `年限：${profile.yearsExperience || "未填"}`,
    `技能：${join(profile.skills)}`,
    `行业：${join(profile.industries)}`,
    `方向：${join(profile.directions)}`,
    `证书：${join(profile.certificates)}`,
    `语言：${join(profile.languages)}`,
    `规则侧写摘要：`,
    ...base.paragraphs,
    `简历正文（截断）：`,
    String(profile.resumeText || "").slice(0, 6000)
  ].join("\n");

  const out = await chatCompletion({ settings, system, user, temperature: 0.3 });

  return {
    ...base,
    mode: "ai",
    paragraphs: [
      "【以下为 AI 侧写，请核对后保存画像】",
      out.text,
      "",
      "【规则底稿（对照用）】",
      ...base.paragraphs
    ],
    aiText: out.text,
    generatedAt: Date.now(),
    providerLabel: out.providerLabel
  };
}
