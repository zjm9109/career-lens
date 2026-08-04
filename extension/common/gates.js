/**
 * 硬门槛门禁：断言 PASS/FAIL/UNKNOWN → 门禁结果
 * UNKNOWN 按 FAIL（产品确认 A）
 */
import { extractMinYears } from "./recommend.js";
import { getDefaultPack } from "./packs/it-delivery-pm.js";
import { weightedPillarTotal } from "./pillars.js";

export const GATE_SCORE_CAP = 35;

function norm(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, "");
}

function wideHit(hay, needle) {
  const h = norm(hay);
  const n = norm(needle);
  return n.length > 0 && h.includes(n);
}

function jobText(job) {
  return [
    job.title || "",
    (job.keywords || []).join(" "),
    job.requirements || "",
    job.responsibilities || "",
    job.description || "",
    job.bonus || ""
  ].join("\n");
}

function reqBlock(job) {
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

function splitClauses(text) {
  return String(text || "")
    .split(/[。；;\n]|(?=\d+[\.、])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function isPreferred(clause) {
  return /优先|加分|尤佳|更好|最佳|可考虑/.test(clause);
}

/** 从 JD 抽取必须证书名 */
export function extractMustCertificates(job) {
  const block = `${reqBlock(job)}\n${job.title || ""}`;
  const found = [];
  const patterns = [
    /持有\s*([^\n。；;，,]{2,40}?证书)/g,
    /具备\s*([^\n。；;，,]{2,40}?证书)/g,
    /需持有\s*([^\n。；;，,]{2,40}?证书)/g,
    /须持有\s*([^\n。；;，,]{2,40}?证书)/g,
    /(一级机电建造师|二级机电建造师|一级建造师|二级建造师|机电建造师)/g,
    /\b(PMP|PRINCE2|ACP)\b/gi
  ];
  for (const clause of splitClauses(block)) {
    if (isPreferred(clause)) continue;
    for (const re of patterns) {
      const r = new RegExp(re.source, re.flags);
      let m;
      while ((m = r.exec(clause))) {
        let name = (m[1] || m[0] || "").replace(/持有|具备|需|须/g, "").trim();
        if (/优先/.test(name)) continue;
        if (name.length >= 2 && name.length <= 40) found.push({ name, evidence: clause.slice(0, 120) });
      }
    }
    // 「持有一级机电建造师证书」整句
    if (/持有|具备/.test(clause) && /建造师|PMP|软考|证书/.test(clause) && !isPreferred(clause)) {
      const m = clause.match(/(一级机电建造师|二级建造师|一级建造师|机电建造师|PMP|信息系统项目管理师)/i);
      if (m) found.push({ name: m[1], evidence: clause.slice(0, 120) });
    }
  }
  // 去重：去掉「证书」后缀再比，避免「一级机电建造师」与「…证书」双条
  const map = new Map();
  for (const f of found) {
    let name = f.name.replace(/证书$/g, "").trim() || f.name;
    const k = norm(name);
    if (!map.has(k)) map.set(k, { ...f, name });
  }
  return [...map.values()];
}

export function extractMustLanguage(job) {
  const text = jobText(job);
  const out = [];
  for (const clause of splitClauses(text)) {
    if (isPreferred(clause)) continue;
    if (/英语|英文/.test(clause) && /工作语言|流利|无障碍|商务沟通|英文会议|商业文档/.test(clause)) {
      out.push({ name: "英语工作语言", evidence: clause.slice(0, 120) });
    }
  }
  return out;
}

function profileBlob(profile) {
  return [
    ...(profile.certificates || []),
    ...(profile.skills || []),
    ...(profile.languages || []),
    ...(profile.industries || []),
    ...(profile.directions || []),
    profile.resumeText || ""
  ].join("\n");
}

function profileHasCert(profile, certName) {
  const bag = norm(profileBlob(profile));
  const n = norm(certName);
  if (!n) return false;
  if (bag.includes(n)) return true;
  // 建造师类：必须简历/画像字面含建造师（PMP 等不能冒充）
  if (/建造师/.test(certName) || /一建|二建/.test(certName)) {
    return /一级机电建造师|二级机电建造师|机电建造师|一级建造师|二级建造师|建造师|一建|二建/.test(bag);
  }
  if (/^pmp$/i.test(certName) || /\bpmp\b/.test(n) || n === "pmp") return /\bpmp\b/.test(bag) || bag.includes("pmp");
  if (/软考|信息系统项目管理/.test(certName)) return /软考|信息系统项目管理|高项/.test(bag);
  return false;
}

function profileHasWorkingEnglish(profile) {
  const langs = (profile.languages || []).join(" ");
  const blob = `${langs}\n${profile.resumeText || ""}`;
  if (!String(langs || "").trim() && !/英语|英文|CET|雅思|托福|工作语言/.test(blob)) {
    return "unknown";
  }
  if (/工作语言|商务英语|无障碍|英文会议|流利/.test(blob)) return "pass";
  if (/英语|英文|CET|六级|四级|雅思|托福/.test(blob)) return "pass"; // 已填语言标签视为可验证
  return "unknown";
}

function profileMatchesDomain(profile, hint) {
  const bag = norm(profileBlob(profile));
  return wideHit(bag, hint);
}

/**
 * @returns {{ status: 'pass'|'fail', assertions: Array, failed: Array, unknownCount: number }}
 */
/**
 * @param {{ skipPackDomain?: boolean }} opts
 * skipPackDomain=true：不用职业包词表做域门禁（语义路径会另判领域）
 */
export function evaluateGates(job, profile, pack = getDefaultPack(), opts = {}) {
  const skipPackDomain = !!opts.skipPackDomain;
  const assertions = [];
  const req = reqBlock(job);
  const body = `${req}\n${job.responsibilities || ""}`;

  // 年限（UNKNOWN→FAIL）
  const needYears = extractMinYears(req) || extractMinYears(body);
  if (needYears != null) {
    const have = Number(profile.yearsExperience);
    let result = "pass";
    let evidenceResume = `画像年限 ${have} 年`;
    if (!Number.isFinite(have) || have <= 0) {
      result = "fail";
      evidenceResume = "画像未填工作年限（按未通过）";
    } else if (have < needYears) {
      result = "fail";
      evidenceResume = `画像年限 ${have} 年 < ${needYears}`;
    }
    assertions.push({
      id: `years:${needYears}`,
      type: "years",
      label: `工作年限≥${needYears}年`,
      modality: "must",
      result,
      evidenceJd: `岗位要求≥${needYears}年`,
      evidenceResume
    });
  }

  // 证书
  for (const c of extractMustCertificates(job)) {
    const ok = profileHasCert(profile, c.name);
    assertions.push({
      id: `cert:${norm(c.name)}`,
      type: "certificate",
      label: `必须证书：${c.name}`,
      modality: "must",
      result: ok ? "pass" : "fail",
      evidenceJd: c.evidence,
      evidenceResume: ok ? "画像/简历中已匹配证书" : "画像/简历中未找到对应证书"
    });
  }

  // 语言
  for (const lang of extractMustLanguage(job)) {
    const st = profileHasWorkingEnglish(profile);
    const result = st === "pass" ? "pass" : "fail"; // UNKNOWN→FAIL
    assertions.push({
      id: `lang:${lang.name}`,
      type: "language",
      label: `必须语言：${lang.name}`,
      modality: "must",
      result,
      evidenceJd: lang.evidence,
      evidenceResume:
        st === "pass" ? "画像已填语言或简历含英语相关表述" : "画像未填语言且简历未见英语工作能力证明（按未通过）"
    });
  }

  // 域词表门禁：仅无语义模型时的兜底（职业包参考词，非主路径）
  if (!skipPackDomain) {
    const domainHints = pack.domainMustHints || [];
    const domainBlocks = [reqBlock(job), job.responsibilities || "", job.title || ""];
    for (const block of domainBlocks) {
      for (const clause of splitClauses(block)) {
        if (isPreferred(clause)) continue;
        for (const hint of domainHints) {
          if (!wideHit(clause, hint) && !clause.includes(hint)) continue;
          const ok = profileMatchesDomain(profile, hint);
          assertions.push({
            id: `domain:${norm(hint)}`,
            type: "domain",
            label: `硬性领域/行业经历：${hint}`,
            modality: "must",
            result: ok ? "pass" : "fail",
            evidenceJd: clause.slice(0, 120),
            evidenceResume: ok ? "画像/简历命中该领域词" : "画像/简历未体现该领域经历"
          });
        }
      }
    }
  }

  // 去重同 id
  const uniq = new Map();
  for (const a of assertions) {
    if (!uniq.has(a.id)) uniq.set(a.id, a);
  }
  const list = [...uniq.values()];
  const failed = list.filter((a) => a.result === "fail" || a.result === "unknown");
  // unknown 已在语言/年限处映射为 fail；若仍有 unknown 也算失败
  const status = failed.length ? "fail" : "pass";

  return {
    status,
    assertions: list,
    failed,
    unknownCount: list.filter((a) => a.result === "unknown").length,
    packId: pack.id
  };
}

/** 将门禁结果合并进 scoreJob 输出 */
export function applyGateToScore(score, gates) {
  let next = { ...score };
  const failed = gates.failed || [];
  const domainFail = failed.some((a) => a.type === "domain");
  // 压域前总分：待复核用此分，避免领域压到 15 后永远进不了待复核
  const fitBeforeDomainCrush = next.total;
  // 域不符时压领域支柱（及旧行业维），避免原分虚高
  if (domainFail) {
    if (next.pillars?.domain) {
      const crushed = Math.min(next.pillars.domain.score ?? 100, 15);
      next = {
        ...next,
        pillars: {
          ...next.pillars,
          domain: {
            ...next.pillars.domain,
            score: crushed,
            detail: `${next.pillars.domain.detail || ""}；域门禁未过→压至 ${crushed}`.replace(/^；/, "")
          }
        }
      };
    }
    if (next.dimensions?.industry) {
      const ind = next.dimensions.industry;
      const crushed = Math.min(ind.score ?? 100, 15);
      next = {
        ...next,
        dimensions: {
          ...next.dimensions,
          industry: {
            ...ind,
            score: crushed,
            detail: `${ind.detail || ""}；域门禁未过→行业维压至 ${crushed}`.replace(/^；/, "")
          }
        }
      };
    }
    if (next.pillars) {
      let t = weightedPillarTotal(next.pillars, next.weights);
      const concrete = next.jdConcrete;
      if (concrete && Number.isFinite(Number(concrete.score))) {
        const scale = 0.5 + 0.5 * (Number(concrete.score) / 100);
        t = Math.round(t * scale);
        if (concrete.sparse) t = Math.min(t, 58);
        else if (concrete.thin) t = Math.min(t, 72);
      }
      next.total = t;
    }
  }

  const fitTotal = next.total;
  if (gates.status !== "fail") {
    return {
      ...next,
      fitTotal,
      fitBeforeDomainCrush,
      gateStatus: "pass",
      gateLabel: "硬门槛通过",
      gateFailed: [],
      gates
    };
  }
  const capped = Math.min(fitTotal, GATE_SCORE_CAP);
  return {
    ...next,
    fitTotal,
    fitBeforeDomainCrush,
    total: capped,
    gateStatus: "fail",
    gateLabel: "硬门槛未过",
    gateFailed: failed.map((a) => a.label),
    hardGaps: [...new Set([...(next.hardGaps || []), ...failed.map((a) => a.label)])],
    gates
  };
}
