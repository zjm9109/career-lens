/**
 * 简历文件 → 纯文本（供用户确认后再提取标签）
 *
 * - TXT/MD：直接读
 * - DOCX：当 ZIP 解出 word/document.xml 再剥标签
 * - PDF：用本地 vendored 的 pdf.js（支持 ToUnicode，可解中文），
 *        旧版 latin1 扫括号会对中文 PDF 产生乱码，已废弃
 */

export async function parseResumeFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt") || name.endsWith(".md")) {
    return await file.text();
  }
  if (name.endsWith(".docx")) {
    return await parseDocx(file);
  }
  if (name.endsWith(".pdf")) {
    return await parsePdfWithPdfJs(file);
  }
  throw new Error("仅支持 PDF / DOCX / TXT / MD");
}

/** 使用 pdf.js 按页提取文本并拼成可读段落 */
async function parsePdfWithPdfJs(file) {
  const pdfjs = await import(chrome.runtime.getURL("vendor/pdfjs/pdf.min.mjs"));
  // Worker 必须指向扩展内路径，否则无法解析内容流
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");

  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    // 关闭在线字体，保证纯本地、零运维
    disableFontFace: false,
    isEvalSupported: false
  });
  const pdf = await loadingTask.promise;
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // pdf.js 的 item 带有变换矩阵；按 y 粗分行，避免全挤成一行
    pages.push(layoutTextContent(content));
  }

  const text = pages
    .join("\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!text || text.length < 20) {
    throw new Error("PDF 未能提取到有效文本（可能是扫描件），请改用 DOCX/TXT 或粘贴正文");
  }
  // 粗检：若几乎没有中文/字母，多半仍失败
  const useful = (text.match(/[\u4e00-\u9fffA-Za-z]/g) || []).length;
  if (useful < 20) {
    throw new Error("PDF 文本异常，请改用 DOCX/TXT 或手动粘贴简历");
  }
  return text;
}

/** 把 pdf.js TextContent 排成近似阅读顺序的纯文本 */
function layoutTextContent(content) {
  const items = (content.items || []).filter((it) => it && typeof it.str === "string");
  if (!items.length) return "";

  // 按行聚合：transform[5] 为 y（PDF 坐标系）
  const lines = [];
  const tol = 3;
  for (const it of items) {
    const x = it.transform?.[4] ?? 0;
    const y = it.transform?.[5] ?? 0;
    let line = lines.find((l) => Math.abs(l.y - y) <= tol);
    if (!line) {
      line = { y, parts: [] };
      lines.push(line);
    }
    line.parts.push({ x, str: it.str });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines
    .map((l) =>
      l.parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.str)
        .join("")
        .replace(/[ \t]{2,}/g, " ")
        .trim()
    )
    .filter(Boolean)
    .join("\n");
}

async function parseDocx(file) {
  const buf = await file.arrayBuffer();
  const unzipped = await inflateDocx(buf);
  const xml = unzipped["word/document.xml"];
  if (!xml) throw new Error("DOCX 中未找到 document.xml");
  const text = xml
    .replace(/<w:tab[^/]*\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:br[^/]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) throw new Error("DOCX 解析结果为空");
  return text;
}

/** 极简 ZIP 读取（store / deflate-raw） */
async function inflateDocx(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const files = {};
  let offset = 0;
  while (offset + 30 < u8.length) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break;
    const method = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const nameBytes = u8.slice(offset + 30, offset + 30 + nameLen);
    const name = new TextDecoder().decode(nameBytes);
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = u8.slice(dataStart, dataStart + compSize);
    offset = dataStart + compSize;
    if (method === 0) {
      files[name] = new TextDecoder().decode(data);
    } else if (method === 8) {
      files[name] = await inflateRaw(data);
    }
  }
  return files;
}

async function inflateRaw(data) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(ab);
}

/**
 * 从简历正文启发式抽取工作年限（年）
 * 优先显式写法；否则用最早/最晚工作年份粗估
 */
export function extractYearsExperience(text) {
  const s = String(text || "");
  if (!s.trim()) return 0;

  const explicit = [
    /工作年限\s*[:：]?\s*(\d{1,2})\s*年/,
    /工作经验\s*[:：]?\s*(\d{1,2})\s*年/,
    /(\d{1,2})\s*年(?:以上)?(?:相关)?工作经验/,
    /(\d{1,2})\s*年(?:以上)?[\u4e00-\u9fffA-Za-z]{0,12}经验/,
    /从业\s*(\d{1,2})\s*年/,
    /工龄\s*[:：]?\s*(\d{1,2})\s*年/,
    /累计\s*(\d{1,2})\s*年/
  ];
  let best = 0;
  for (const re of explicit) {
    const m = s.match(re);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= 1 && n <= 45) best = Math.max(best, n);
  }
  if (best > 0) return best;

  // 粗估：正文中的 20xx 年，取跨度（排除明显未来年）
  const years = [...s.matchAll(/\b(20\d{2})\b/g)]
    .map((m) => Number(m[1]))
    .filter((y) => y >= 1995 && y <= new Date().getFullYear() + 1);
  if (years.length >= 2) {
    const span = Math.max(...years) - Math.min(...years);
    if (span >= 1 && span <= 45) return span;
  }
  return 0;
}

/**
 * 从简历正文启发式预填标签（词典命中，可按人扩展 skillDict 等）
 * 微调入口：改下面各 *Dict 数组即可提高预填命中率
 */
export function suggestProfileFromText(text) {
  const skills = [];
  const certificates = [];
  const languages = [];
  const industries = [];
  const directions = [];

  const skillDict = [
    "项目管理", "PMP", "敏捷", "Scrum", "Jira", "需求分析", "产品经理",
    "Java", "Python", "SQL", "数据分析", "云计算", "AI", "大模型", "RAG",
    "实施交付", "PMO", "客户管理", "跨部门协调", "DevOps", "云原生",
    "容器云", "多云", "研发效能", "资源协调", "进度管控", "风险管理",
    "团队管理", "售前", "验收", "回款"
  ];
  const certDict = ["PMP", "软考", "CSPM", "PRINCE2", "CPA", "CET-6", "英语六级", "英语四级"];
  const langDict = ["英语", "英语六级", "英语四级", "日语", "CET-6", "CET-4"];
  const indDict = [
    "互联网", "金融", "证券", "银行", "电商", "教育", "医疗", "智能制造",
    "政务", "大数据", "人工智能", "运营商", "央企", "养老"
  ];
  const dirDict = [
    "项目经理", "PMO", "产品经理", "技术经理", "交付经理", "IT经理",
    "研发经理", "项目副经理"
  ];

  const hit = (dict, bucket) => {
    for (const w of dict) {
      if (text.includes(w) && !bucket.includes(w)) bucket.push(w);
    }
  };
  hit(skillDict, skills);
  hit(certDict, certificates);
  hit(langDict, languages);
  hit(indDict, industries);
  hit(dirDict, directions);

  return {
    skills,
    certificates,
    languages,
    industries,
    directions,
    yearsExperience: extractYearsExperience(text),
    resumeText: text
  };
}
