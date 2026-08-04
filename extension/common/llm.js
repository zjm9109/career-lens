/**
 * 多模型统一分析（OpenAI 兼容 Chat Completions）
 * 国产：DeepSeek、通义千问、腾讯混元；国外：OpenAI、Gemini
 */

export const LLM_PROVIDERS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    region: "cn",
    baseUrl: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
    hostPermission: "https://api.deepseek.com/*"
  },
  {
    id: "qwen",
    label: "通义千问",
    region: "cn",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-plus",
    hostPermission: "https://dashscope.aliyuncs.com/*"
  },
  {
    id: "hunyuan",
    label: "腾讯混元",
    region: "cn",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
    model: "hunyuan-turbos-latest",
    hostPermission: "https://api.hunyuan.cloud.tencent.com/*"
  },
  {
    id: "openai",
    label: "OpenAI",
    region: "global",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    hostPermission: "https://api.openai.com/*"
  },
  {
    id: "gemini",
    label: "Gemini",
    region: "global",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-2.0-flash",
    hostPermission: "https://generativelanguage.googleapis.com/*"
  }
];

export function getProvider(id) {
  return LLM_PROVIDERS.find((p) => p.id === id) || LLM_PROVIDERS[0];
}

const SYSTEM = `你是求职顾问。根据候选人画像与岗位信息做简短分析。
不要重新计算匹配分数，不要改写门禁结论。规则引擎已给出门禁与契合分；请在风险/缺口中点名未满足的硬门槛与必备项。
若门禁为「硬门槛未过」，是否建议投递必须写「不建议」或「谨慎」，不得写「建议」。
隐含覆盖：候选人已有项目经理/PMP/项目管理交付背景时，「评审会、资料归档、交付复盘、会议纪要、周报、进度跟踪」等常见项目管理过程动作视为岗位常规范围，不要因简历未写字面词列为缺口。
只输出以下 Markdown 字段：
- 一句话结论
- 岗位成分识别：（如 项目经理 80% / 开发 20%）
- 必备能力识别：（列出岗位必须/核心能力，区分优先与加分）
- 匹配亮点：（2-4 条）
- 风险/缺口：（务必包含硬门槛失败项与未满足必备；2-5 条）
- 是否建议投递：建议 / 谨慎 / 不建议
- 改简历侧重点：（一句话）
用中文，简洁。字段之间不要空行，列表紧凑输出。`;

function buildUserContent(profile, job, score) {
  const req = score.requirements || {};
  const gateLine =
    score.gateStatus === "fail"
      ? `门禁：硬门槛未过（封顶展示分 ${score.total}%；契合原分 ${score.fitTotal ?? "-"}%）；失败项：${(score.gateFailed || []).join("；") || "-"}`
      : `门禁：${score.gateLabel || "硬门槛通过"}；契合分 ${score.fitTotal ?? score.total}%`;
  return [
    "## 候选人画像",
    `技能：${(profile.skills || []).join("、") || "-"}`,
    `行业：${(profile.industries || []).join("、") || "-"}`,
    `方向：${(profile.directions || []).join("、") || "-"}`,
    `证书：${(profile.certificates || []).join("、") || "-"}`,
    `语言：${(profile.languages || []).join("、") || "-"}`,
    profile.yearsExperience
      ? `工作年限（辅助）：${profile.yearsExperience}年`
      : "工作年限（辅助）：未填",
    gateLine,
    `展示分：${score.total}%（仅供参考，请勿改分）`,
    `规则识别-必备：${(req.must || []).join("、") || "-"}`,
    `规则识别-必备未满足：${(req.mustMiss || []).join("、") || "无"}`,
    `规则识别-优先：${(req.preferred || []).join("、") || "-"}`,
    `规则识别-加分：${(req.bonus || []).join("、") || "-"}`,
    "",
    "## 岗位",
    `标题：${job.title || ""}`,
    `公司：${job.company || ""}`,
    `职位标签：${(job.keywords || []).join("、") || "-"}`,
    `工作职责：`,
    (job.responsibilities || "").slice(0, 2500) || "-",
    `任职要求：`,
    (job.requirements || "").slice(0, 2000) || "-",
    `加分项：`,
    (job.bonus || "").slice(0, 800) || "-",
    `完整结构化文本：`,
    (job.description || "").slice(0, 4000)
  ].join("\n");
}

/** 从 settings 取当前启用模型的 Key */
export function resolveLlmConfig(settings) {
  const provider = getProvider(settings.llmProvider || "deepseek");
  const keys = settings.apiKeys || {};
  const apiKey =
    keys[provider.id] ||
    (provider.id === "deepseek" ? settings.deepseekApiKey : "") ||
    "";
  return { provider, apiKey: String(apiKey || "").trim() };
}

/** OpenAI 兼容 Chat Completions；供岗位分析 / 简历侧写复用 */
export async function chatCompletion({ settings, system, user, temperature = 0.3 }) {
  const { provider, apiKey } = resolveLlmConfig(settings);
  if (!apiKey) throw new Error(`未配置 ${provider.label} API Key`);

  const res = await fetch(provider.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: provider.model,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${provider.label} 请求失败 ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  if (!text) throw new Error(`${provider.label} 返回为空`);
  return { text: text.trim(), providerId: provider.id, providerLabel: provider.label };
}

export async function analyzeJobWithLlm({ settings, profile, job, score }) {
  const out = await chatCompletion({
    settings,
    system: SYSTEM,
    user: buildUserContent(profile, job, score),
    temperature: 0.3
  });
  return out;
}

/** 兼容旧调用名 */
export async function analyzeWithDeepseek(args) {
  const { text } = await analyzeJobWithLlm({
    settings: {
      llmProvider: "deepseek",
      apiKeys: { deepseek: args.apiKey },
      deepseekApiKey: args.apiKey
    },
    profile: args.profile,
    job: args.job,
    score: args.score
  });
  return text;
}
