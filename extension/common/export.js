import { compactAnalysis, normalizeSalary } from "./job-sections.js";
import {
  REC,
  REC_ORDER,
  enrichResult,
  estimateDeepseekCost,
  groupResultsByRecommendation,
  splitAnalysisLine
} from "./recommend.js";

function esc(s) {
  return String(s ?? "").replace(/\r/g, "");
}

function escXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function makeFilename(prefix = "career-lens", ext = "md") {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${prefix}-${stamp}.${ext}`;
}

export function sortResults(results) {
  return [...results].sort((a, b) => {
    const sa = a.score?.total ?? 0;
    const sb = b.score?.total ?? 0;
    if (sb !== sa) return sb - sa;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

function statusLine(score, recommendation) {
  if (score.excluded || recommendation === REC.EXCLUDE) {
    return `已排除（规则分 ${score.total ?? 0}% 仅供参考，因避雷未进入模型/收藏）`;
  }
  if (recommendation === REC.REVIEW) {
    const fit = score.fitTotal != null ? `，契合原分 ${score.fitTotal}%` : "";
    const gate =
      score.gateStatus === "fail"
        ? `硬门槛未过（展示分 ${score.total ?? 0}%${fit}）`
        : `展示分偏低（${score.total ?? 0}%${fit}）`;
    return `待复核 · ${gate}`;
  }
  if (score.gateStatus === "fail") {
    const fit = score.fitTotal != null ? `，契合原分 ${score.fitTotal}%` : "";
    return `硬门槛未过（展示分 ${score.total ?? 0}%${fit}）`;
  }
  if (recommendation === REC.CAUTION) return "谨慎投递";
  if (recommendation === REC.SUGGEST) return "建议投递";
  if (recommendation === REC.EXCLUDE) return "已排除";
  return score.total >= 60 ? "可参考" : "低匹配";
}

function analysisBlock(analysis) {
  const t = compactAnalysis(analysis);
  if (!t) return [];
  return t.split("\n").filter((l) => l.trim() !== "");
}

export function formatDuration(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function metaLines(results, mode, deepseekCalls) {
  const est = estimateDeepseekCost(deepseekCalls ?? countDeepseekCalls(results));
  return [
    `- 生成时间：${new Date().toLocaleString("zh-CN")}`,
    `- 条数：${results.length}`,
    `- 模式：${mode}`,
    `- 模型调用：${est.calls} 次`,
    `- 费用预估：约 ¥${est.yuanText}（${est.note}）`
  ];
}

export function countDeepseekCalls(results) {
  return (results || []).filter((r) => r.analysis && !r.skippedDeepseek).length;
}

function pushJobMarkdown(lines, r, idx, mode) {
  const job = r.job || {};
  const score = r.score || {};
  const salary = normalizeSalary(job.salary);
  const dims = score.dimensions || {};
  const rec = r.recommendation || enrichResult(r).recommendation;

  lines.push(``);
  lines.push(`## ${idx}. ${esc(job.title || "未命名岗位")}`);
  lines.push(`- 建议：${rec}`);
  lines.push(`- 公司：${esc(job.company || "-")}`);
  if (salary) lines.push(`- 薪资：${esc(salary)}`);
  lines.push(`- 链接：${esc(job.url || "-")}`);
  lines.push(`- 结果：${statusLine(score, rec)}`);
  lines.push(`- 匹配度：${score.total ?? 0}%`);
  if (score.fitTotal != null && score.fitTotal !== score.total) {
    lines.push(`- 契合原分：${score.fitTotal}%`);
  }
  if (score.jdConcrete) {
    lines.push(
      `- JD具体度：${score.jdConcrete.score}` +
        (score.jdConcrete.reasons?.length
          ? `（${score.jdConcrete.reasons.slice(0, 3).join("；")}）`
          : "")
    );
  }
  if (rec === REC.REVIEW) lines.push(`- 防漏：待复核（请人工确认）`);
  if (score.gateStatus === "fail") {
    lines.push(
      `- 门禁：硬门槛未过` +
        (score.fitTotal != null ? `（契合原分 ${score.fitTotal}%）` : "") +
        (score.gateFailed?.length ? `；${score.gateFailed.join("；")}` : "")
    );
  } else if (score.gateLabel) {
    lines.push(`- 门禁：${score.gateLabel}`);
  }
  if (r.durationMs != null) lines.push(`- 生成时长：${formatDuration(r.durationMs)}`);
  if (score.avoidHits?.length) lines.push(`- 避雷命中：${score.avoidHits.join("、")}`);
  if (score.attentionHits?.length) lines.push(`- 注意项：${score.attentionHits.join("、")}`);
  if (score.hardGaps?.length) lines.push(`- 硬门槛缺口：${score.hardGaps.join("；")}`);
  const req = score.requirements || {};
  if (req.must?.length) lines.push(`- 必备能力：${esc(req.must.slice(0, 16).join("、"))}`);
  if (req.mustMiss?.length) lines.push(`- 必备未满足：${esc(req.mustMiss.slice(0, 12).join("、"))}`);
  if (req.preferred?.length) {
    lines.push(
      `- 优先项：${esc(req.preferred.slice(0, 10).join("、"))}` +
        (req.preferredMiss?.length ? `（未命中：${esc(req.preferredMiss.slice(0, 8).join("、"))}）` : "")
    );
  }
  if (req.bonus?.length) {
    lines.push(
      `- 加分项标签：${esc(req.bonus.slice(0, 10).join("、"))}` +
        (req.bonusMiss?.length ? `（未命中：${esc(req.bonusMiss.slice(0, 8).join("、"))}）` : "")
    );
  }
  if (r.favorited) lines.push(`- 收藏：已自动收藏`);
  if (r.skippedDeepseek) lines.push(`- 模型：未调用（${esc(r.skippedDeepseek)}）`);
  if (r.llmLabel && r.analysis) lines.push(`- 模型：${esc(r.llmLabel)}`);
  if (score.pillars) {
    const p = score.pillars;
    lines.push(
      `- 四维：角色 ${p.role?.score ?? "-"} | 领域 ${p.domain?.score ?? "-"} | 能力 ${p.capability?.score ?? "-"} | 资质 ${p.qualify?.score ?? "-"}` +
        (score.scoreMode ? `（${score.scoreMode}）` : "")
    );
    if (score.semantic?.jobDomain) {
      lines.push(`- 领域识别：岗位「${esc(score.semantic.jobDomain)}」/ 简历「${esc(score.semantic.resumeDomain || "-")}」`);
    }
  } else {
    lines.push(
      `- 分项：技能 ${dims.skill?.score ?? "-"} | 行业 ${dims.industry?.score ?? "-"} | 方向 ${dims.direction?.score ?? "-"} | 证书 ${dims.certificate?.score ?? "-"} | 语言 ${dims.language?.score ?? "-"}`
    );
  }
  if (job.keywords?.length) lines.push(`- 职位标签：${esc(job.keywords.join("、"))}`);
  if (r.analysis) {
    lines.push(`- 分析结果：`);
    for (const line of analysisBlock(r.analysis)) lines.push(`  ${line}`);
  }
  if (mode === "detailed") {
    if (job.responsibilities) {
      lines.push(``);
      lines.push(`### 工作职责`);
      lines.push(esc(job.responsibilities).slice(0, 1500));
    }
    if (job.requirements) {
      lines.push(``);
      lines.push(`### 任职要求`);
      lines.push(esc(job.requirements).slice(0, 1200));
    }
    if (job.bonus) {
      lines.push(``);
      lines.push(`### 加分项`);
      lines.push(esc(job.bonus).slice(0, 600));
    }
  }
  lines.push(``);
  lines.push(`---`);
}

function buildGroupedMarkdown(results, mode) {
  const enriched = sortResults(results).map(enrichResult);
  const buckets = groupResultsByRecommendation(enriched);
  const modeLabel = mode === "detailed" ? "详细" : "精简";
  const lines = [`# career-lens 精筛结果`, ``, ...metaLines(enriched, modeLabel, null), ``];

  for (const title of REC_ORDER) {
    const list = buckets[title] || [];
    lines.push(``);
    lines.push(`# ${title}（${list.length}）`);
    lines.push(``);
    if (!list.length) {
      lines.push(`（无）`);
      lines.push(`---`);
      continue;
    }
    list.forEach((r, i) => pushJobMarkdown(lines, r, i + 1, mode));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function resultsToMarkdown(results, { mode = "simple", deepseekCalls } = {}) {
  const md = buildGroupedMarkdown(results, mode === "detailed" ? "detailed" : "simple");
  if (deepseekCalls != null) {
    const est = estimateDeepseekCost(deepseekCalls);
    return md
      .replace(/- 模型调用：\d+ 次/, `- 模型调用：${est.calls} 次`)
      .replace(/- 费用预估：约 ¥[^\n]+/, `- 费用预估：约 ¥${est.yuanText}（${est.note}）`);
  }
  return md;
}

/** 导出为段落列表（Word） */
export function resultsToPlainParagraphs(results, { mode = "simple", deepseekCalls } = {}) {
  const enriched = sortResults(results).map(enrichResult);
  const buckets = groupResultsByRecommendation(enriched);
  const est = estimateDeepseekCost(deepseekCalls ?? countDeepseekCalls(enriched));
  const paras = [
    "career-lens 精筛结果",
    `生成时间：${new Date().toLocaleString("zh-CN")}　条数：${enriched.length}　模式：${mode === "detailed" ? "详细" : "精简"}`,
    `模型调用：${est.calls} 次　费用预估：约 ¥${est.yuanText}`,
    est.note,
    ""
  ];

  for (const title of REC_ORDER) {
    const list = buckets[title] || [];
    paras.push(`【${title}】（${list.length}）`);
    paras.push("");
    if (!list.length) {
      paras.push("（无）");
      paras.push("----------");
      paras.push("");
      continue;
    }
    list.forEach((r, idx) => {
      const job = r.job || {};
      const score = r.score || {};
      const salary = normalizeSalary(job.salary);
      const dims = score.dimensions || {};
      const rec = r.recommendation;

      paras.push(`${idx + 1}. ${job.title || "未命名岗位"}`);
      paras.push(`建议：${rec}`);
      paras.push(`公司：${job.company || "-"}`);
      if (salary) paras.push(`薪资：${salary}`);
      paras.push(`链接：${job.url || "-"}`);
      paras.push(`结果：${statusLine(score, rec)}`);
      paras.push(`匹配度：${score.total ?? 0}%`);
      if (score.fitTotal != null && score.fitTotal !== score.total) {
        paras.push(`契合原分：${score.fitTotal}%`);
      }
      if (rec === REC.REVIEW) paras.push(`防漏：待复核（请人工确认）`);
      if (score.gateStatus === "fail") {
        paras.push(
          `门禁：硬门槛未过` +
            (score.fitTotal != null ? `（契合原分 ${score.fitTotal}%）` : "") +
            (score.gateFailed?.length ? `；${score.gateFailed.join("；")}` : "")
        );
      } else if (score.gateLabel) {
        paras.push(`门禁：${score.gateLabel}`);
      }
      if (r.durationMs != null) paras.push(`生成时长：${formatDuration(r.durationMs)}`);
      if (score.avoidHits?.length) paras.push(`避雷：${score.avoidHits.join("、")}`);
      if (score.attentionHits?.length) paras.push(`注意：${score.attentionHits.join("、")}`);
      if (score.hardGaps?.length) paras.push(`硬门槛缺口：${score.hardGaps.join("；")}`);
      const req = score.requirements || {};
      if (req.must?.length) paras.push(`必备能力：${req.must.slice(0, 16).join("、")}`);
      if (req.mustMiss?.length) paras.push(`必备未满足：${req.mustMiss.slice(0, 12).join("、")}`);
      if (req.preferred?.length) {
        paras.push(
          `优先项：${req.preferred.slice(0, 10).join("、")}` +
            (req.preferredMiss?.length ? `（未命中：${req.preferredMiss.slice(0, 8).join("、")}）` : "")
        );
      }
      if (req.bonus?.length) {
        paras.push(
          `加分项标签：${req.bonus.slice(0, 10).join("、")}` +
            (req.bonusMiss?.length ? `（未命中：${req.bonusMiss.slice(0, 8).join("、")}）` : "")
        );
      }
      if (score.pillars) {
        const p = score.pillars;
        paras.push(
          `四维：角色 ${p.role?.score ?? "-"} | 领域 ${p.domain?.score ?? "-"} | 能力 ${p.capability?.score ?? "-"} | 资质 ${p.qualify?.score ?? "-"}` +
            (score.scoreMode ? `（${score.scoreMode}）` : "")
        );
        if (score.semantic?.jobDomain) {
          paras.push(
            `领域识别：岗位「${score.semantic.jobDomain}」/ 简历「${score.semantic.resumeDomain || "-"}」`
          );
        }
      } else {
        paras.push(
          `分项：技能 ${dims.skill?.score ?? "-"} | 行业 ${dims.industry?.score ?? "-"} | 方向 ${dims.direction?.score ?? "-"} | 证书 ${dims.certificate?.score ?? "-"} | 语言 ${dims.language?.score ?? "-"}`
        );
      }
      if (job.keywords?.length) paras.push(`职位标签：${job.keywords.join("、")}`);
      if (r.llmLabel && r.analysis) paras.push(`模型：${r.llmLabel}`);
      if (r.analysis) {
        paras.push("分析结果：");
        for (const line of analysisBlock(r.analysis)) paras.push(line);
      } else if (r.skippedDeepseek) {
        paras.push(`模型：未调用（${r.skippedDeepseek}）`);
      } else {
        paras.push("模型：无分析结果");
      }
      if (mode === "detailed") {
        if (job.responsibilities) {
          paras.push("【工作职责】");
          paras.push(job.responsibilities.slice(0, 1500));
        }
        if (job.requirements) {
          paras.push("【任职要求】");
          paras.push(job.requirements.slice(0, 1200));
        }
        if (job.bonus) {
          paras.push("【加分项】");
          paras.push(job.bonus.slice(0, 600));
        }
      }
      paras.push("----------");
      paras.push("");
    });
  }

  return paras;
}

// —— 极简 DOCX（ZIP store）——

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  }
  return ~c >>> 0;
}

function u16(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}
function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function concat(chunks) {
  const len = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function zipStore(files) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = typeof text === "string" ? enc.encode(text) : text;
    const crc = crc32(data);
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data
    ]);
    const central = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const localPart = concat(locals);
  const centralPart = concat(centrals);
  const n = Object.keys(files).length;
  const endFixed = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(n),
    u16(n),
    u32(centralPart.length),
    u32(localPart.length),
    u16(0)
  ]);
  return concat([localPart, centralPart, endFixed]);
}

function isGroupHeader(p) {
  return /^【(建议投递|谨慎投递|已排除|谨慎|排除)】/.test(p) || p === "career-lens 精筛结果";
}

function paragraphToXml(p) {
  if (!p) return `<w:p/>`;

  // 分析字段：仅标签加粗
  const split = splitAnalysisLine(p);
  if (split.isField) {
    const prefix = /^[-*]\s*/.test(String(p).trim()) ? "- " : "";
    return `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escXml(prefix + split.label)}</w:t></w:r><w:r><w:t xml:space="preserve">${escXml(split.content)}</w:t></w:r></w:p>`;
  }

  const bold =
    isGroupHeader(p) ||
    /^\d+\.\s/.test(p) ||
    /^【.+】/.test(p) ||
    p === "分析结果：" ||
    p.startsWith("DeepSeek：") ||
    p.startsWith("建议：") ||
    p.startsWith("硬门槛缺口：");
  const rPr = bold ? `<w:rPr><w:b/></w:rPr>` : "";
  return `<w:p><w:r>${rPr}<w:t xml:space="preserve">${escXml(p)}</w:t></w:r></w:p>`;
}

function buildDocumentXml(paragraphs) {
  const body = paragraphs.map(paragraphToXml).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${body}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;
}

export function resultsToDocxBlob(results, { mode = "simple", deepseekCalls } = {}) {
  const paras = resultsToPlainParagraphs(results, { mode, deepseekCalls });
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

  const zip = zipStore({
    "[Content_Types].xml": contentTypes,
    "_rels/.rels": rels,
    "word/document.xml": buildDocumentXml(paras),
    "word/_rels/document.xml.rels": docRels
  });
  return new Blob([zip], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
}

export async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
    return { id, filename };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export async function downloadMarkdown(content, filename) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  return downloadBlob(blob, filename);
}

export async function downloadResults(results, { mode = "simple", format = "md", deepseekCalls } = {}) {
  if (format === "docx" || format === "word") {
    const filename = makeFilename("career-lens", "docx");
    const blob = resultsToDocxBlob(results, { mode, deepseekCalls });
    await downloadBlob(blob, filename);
    return { filename };
  }
  const filename = makeFilename("career-lens", "md");
  const md = resultsToMarkdown(results, { mode, deepseekCalls });
  await downloadMarkdown(md, filename);
  return { filename };
}

function csvEscape(val) {
  const s = String(val ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatLocalTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(ts);
  }
}

function applySourceLabel(row) {
  const p = row?.platform;
  if (p === "manual") return "精确";
  if (p === "boss") return "BOSS";
  if (p === "liepin") return "猎聘";
  if (p === "zhilian") return "智联";
  if (row?.source === "manual") return "精确";
  const url = row?.url || "";
  if (/zhipin\.com|bosszhipin/i.test(url)) return "BOSS";
  if (/liepin\.com/i.test(url)) return "猎聘";
  if (/zhaopin\.com/i.test(url)) return "智联";
  return "";
}

/** 投递列表 → UTF-8 BOM CSV（Excel 可直接打开） */
export function applyListToCsv(rows) {
  const headers = [
    "岗位名称",
    "公司",
    "链接",
    "展示匹配度",
    "契合原分",
    "建议分组",
    "是否待复核",
    "门禁状态",
    "门禁失败项",
    "硬门槛缺口",
    "必备未满足",
    "注意项",
    "来源",
    "是否打开过",
    "打开状态",
    "入列时间",
    "最近更新时间",
    "分析摘要"
  ];
  const lines = [headers.map(csvEscape).join(",")];
  const sorted = [...(rows || [])].sort((a, b) => {
    const sa = a.effectiveScore ?? a.fitTotal ?? a.total ?? 0;
    const sb = b.effectiveScore ?? b.fitTotal ?? b.total ?? 0;
    if (sb !== sa) return sb - sa;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  for (const row of sorted) {
    const opened = row.applyStatus === "已打开" ? "是" : "否";
    const gateLabel =
      row.gateStatus === "fail"
        ? "硬门槛未过"
        : row.gateStatus === "pass"
          ? "硬门槛通过"
          : row.gateLabel || "";
    const analysis = compactAnalysis(row.analysis || "").slice(0, 500).replace(/\n+/g, "；");
    lines.push(
      [
        row.title || "",
        row.company || "",
        row.url || "",
        row.total ?? "",
        row.fitTotal ?? row.effectiveScore ?? "",
        row.recommendation || "",
        row.reviewFlag || row.recommendation === REC.REVIEW ? "是" : "否",
        gateLabel,
        (row.gateFailed || []).join("；"),
        (row.hardGaps || []).join("；"),
        (row.mustMiss || []).join("；"),
        (row.attentionHits || []).join("；"),
        applySourceLabel(row),
        opened,
        row.applyStatus || "未打开",
        formatLocalTime(row.createdAt),
        formatLocalTime(row.updatedAt),
        analysis
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return `\uFEFF${lines.join("\r\n")}`;
}

export async function downloadApplyListExcel(rows) {
  const filename = makeFilename("career-lens-投递列表", "csv");
  const csv = applyListToCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  await downloadBlob(blob, filename);
  return { filename, count: (rows || []).length };
}
