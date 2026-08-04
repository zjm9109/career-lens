/**
 * 语义/向量契合：用相关性判断角色·领域·能力·资质
 * - 优先：OpenAI / 通义 等 embedding 余弦（真向量）
 * - 通用：当前聊天模型 JSON 打四维（DeepSeek 等无官方 embedding 时）
 * - 失败：由调用方回退规则四维
 */
import { chatCompletion, resolveLlmConfig } from "./llm.js";
import { PILLAR_KEYS, PILLAR_LABELS } from "./pillars.js";

function clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 50;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 余弦 [-1,1] → 分 [0,100]，中性约 50 */
function cosineToScore(c) {
  const x = Math.max(-1, Math.min(1, c));
  return clampScore(((x + 1) / 2) * 100);
}

export function buildResumeSemanticText(profile) {
  return [
    `目标角色：${(profile.directions || []).join("、") || "未填"}`,
    `行业领域：${(profile.industries || []).join("、") || "未填"}`,
    `技能能力：${(profile.skills || []).join("、") || "未填"}`,
    `证书：${(profile.certificates || []).join("、") || "未填"}`,
    `语言：${(profile.languages || []).join("、") || "未填"}`,
    `年限：${profile.yearsExperience || "未填"}`,
    `简历摘录：${String(profile.resumeText || "").slice(0, 3500)}`
  ].join("\n");
}

export function buildJobSemanticText(job) {
  return [
    `标题：${job.title || ""}`,
    `职责：${String(job.responsibilities || "").slice(0, 2000)}`,
    `任职：${String(job.requirements || "").slice(0, 2000)}`,
    `标签：${(job.keywords || []).join("、")}`,
    `加分：${String(job.bonus || "").slice(0, 600)}`,
    `正文：${String(job.description || "").slice(0, 2500)}`
  ].join("\n");
}

function facetTexts(profile, job) {
  const resume = buildResumeSemanticText(profile);
  const jobFull = buildJobSemanticText(job);
  return {
    resume,
    job: jobFull,
    roleResume: `候选人目标角色与经历角色：${(profile.directions || []).join("、")}\n${String(profile.resumeText || "").slice(0, 1200)}`,
    roleJob: `岗位角色与职责：${job.title || ""}\n${String(job.responsibilities || "").slice(0, 1500)}`,
    domainResume: `候选人行业领域：${(profile.industries || []).join("、")}\n技能：${(profile.skills || []).join("、")}`,
    domainJob: `岗位业务领域（从标题职责推断，勿被「项目经理」四字迷惑）：${job.title || ""}\n${String(job.responsibilities || job.description || "").slice(0, 1500)}`,
    capResume: `候选人能力方法：${(profile.skills || []).join("、")}\n${String(profile.resumeText || "").slice(0, 1500)}`,
    capJob: `岗位所需能力：${String(job.requirements || "").slice(0, 1200)}\n职责：${String(job.responsibilities || "").slice(0, 1200)}`,
    qualResume: `候选人资质：证书 ${(profile.certificates || []).join("、")}；语言 ${(profile.languages || []).join("、")}；年限 ${profile.yearsExperience || "未填"}`,
    qualJob: `岗位资质要求：${String(job.requirements || "").slice(0, 1500)}`
  };
}

/** 各家 embedding 配置（DeepSeek 官方无 embedding，走 LLM JSON） */
function resolveEmbedding(settings) {
  const { provider, apiKey } = resolveLlmConfig(settings);
  if (!apiKey) return null;
  const table = {
    openai: {
      url: "https://api.openai.com/v1/embeddings",
      model: "text-embedding-3-small"
    },
    qwen: {
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
      model: "text-embedding-v3"
    }
  };
  const conf = table[provider.id];
  if (!conf) return null;
  return { ...conf, apiKey, providerLabel: provider.label, providerId: provider.id };
}

async function embedBatch(texts, emb) {
  const res = await fetch(emb.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${emb.apiKey}`
    },
    body: JSON.stringify({ model: emb.model, input: texts })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`embedding ${res.status}: ${t.slice(0, 160)}`);
  }
  const data = await res.json();
  const arr = (data.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
  if (arr.length !== texts.length) throw new Error("embedding 条数不匹配");
  return arr;
}

async function scoreByEmbeddings({ settings, profile, job }) {
  const emb = resolveEmbedding(settings);
  if (!emb) return null;
  const f = facetTexts(profile, job);
  const texts = [
    f.roleResume,
    f.roleJob,
    f.domainResume,
    f.domainJob,
    f.capResume,
    f.capJob,
    f.qualResume,
    f.qualJob
  ];
  const vecs = await embedBatch(texts, emb);
  const mk = (i, j, label) => {
    const c = cosine(vecs[i], vecs[j]);
    return {
      score: cosineToScore(c),
      detail: `${label}向量余弦 ${(c * 100).toFixed(1)}% → 分`,
      source: "embedding",
      cosine: c
    };
  };
  return {
    mode: "embedding",
    providerLabel: emb.providerLabel,
    pillars: {
      role: mk(0, 1, PILLAR_LABELS.role),
      domain: mk(2, 3, PILLAR_LABELS.domain),
      capability: mk(4, 5, PILLAR_LABELS.capability),
      qualify: mk(6, 7, PILLAR_LABELS.qualify)
    }
  };
}

const SEMANTIC_SYSTEM = `你是求职匹配评估器。根据「候选人材料」与「岗位材料」，用语义相关性打分（不是关键词计数）。
只输出一个 JSON 对象，不要 Markdown，不要其它文字。字段：
{
  "role": {"score":0-100,"reason":"一句话","jobRole":"岗位角色概括","resumeRole":"候选人角色概括"},
  "domain": {"score":0-100,"reason":"一句话","jobDomain":"岗位领域","resumeDomain":"候选人领域"},
  "capability": {"score":0-100,"reason":"一句话"},
  "qualify": {"score":0-100,"reason":"一句话"}
}
打分原则（必须遵守）：
- 角色：是否同一类工作（交付PM / 施工PM / 内容编导…），标题都叫项目经理但职责不同 → 角色分要拉开
- 领域：行业/业务场景是否同域；土建/短剧/热泵/金融 等跨域应明显低分（通常 ≤35）
- 能力：职责所需方法工具，候选人是否真正覆盖；空泛软素质不要给高能力分
- 能力例外：候选人已有项目经理/PMP/交付背景时，评审会/资料归档/交付复盘/会议纪要等常见 PM 过程动作视为已覆盖，勿因简历未写字面词大幅扣能力分
- 资质：证书/年限/语言等条件贴合；岗位未要求时给 60 左右中性，不要 100
- 禁止因为「都会项目管理」就给领域高分`;

async function scoreByLlmJson({ settings, profile, job }) {
  const f = facetTexts(profile, job);
  const user = [
    "## 候选人材料",
    f.resume,
    "",
    "## 岗位材料",
    f.job,
    "",
    "请按四维语义相关性打分并输出 JSON。"
  ].join("\n");

  const out = await chatCompletion({
    settings,
    system: SEMANTIC_SYSTEM,
    user,
    temperature: 0.1
  });

  let raw = out.text.trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) raw = m[0];
  const data = JSON.parse(raw);
  const pillars = {};
  for (const k of PILLAR_KEYS) {
    const block = data[k] || {};
    pillars[k] = {
      score: clampScore(block.score),
      detail: block.reason || PILLAR_LABELS[k],
      source: "llm",
      meta: block
    };
  }
  return {
    mode: "llm",
    providerLabel: out.providerLabel,
    pillars,
    jobDomain: data.domain?.jobDomain || "",
    resumeDomain: data.domain?.resumeDomain || ""
  };
}

/**
 * @returns {Promise<{ mode, pillars, providerLabel, jobDomain?, resumeDomain? } | null>}
 */
export async function scoreSemanticPillars({ settings, profile, job }) {
  const { apiKey } = resolveLlmConfig(settings);
  if (!apiKey) return null;

  // 1) 真向量（OpenAI / 通义）
  try {
    const byEmb = await scoreByEmbeddings({ settings, profile, job });
    if (byEmb) return byEmb;
  } catch (e) {
    console.warn("[career-lens] embedding 失败，改用 LLM 语义分", e?.message || e);
  }

  // 2) LLM JSON 语义分（含 DeepSeek）
  try {
    return await scoreByLlmJson({ settings, profile, job });
  } catch (e) {
    console.warn("[career-lens] LLM 语义分失败", e?.message || e);
    return null;
  }
}

/** 领域语义过低时，视为「域硬门槛」类失败（替代写死词表） */
export function semanticDomainGate(semantic, threshold = 35) {
  if (!semantic?.pillars?.domain) return null;
  const score = semantic.pillars.domain.score;
  if (score >= threshold) return null;
  return {
    id: "domain:semantic",
    type: "domain",
    label: `领域语义不符（${score}分${semantic.jobDomain ? `：${semantic.jobDomain}` : ""}）`,
    modality: "must",
    result: "fail",
    evidenceJd: semantic.jobDomain || semantic.pillars.domain.detail || "",
    evidenceResume: semantic.resumeDomain || "与岗位领域语义距离较远"
  };
}
