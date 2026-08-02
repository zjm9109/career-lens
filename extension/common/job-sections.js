/**
 * 岗位文本结构化：标签 / 工作职责 / 任职要求 / 加分项
 * 采集后、打分与导出前统一走这里，避免 HR 名片当标题、摘要糊成一团
 */

const HR_TITLE_RE =
  /^(先生|女士|小姐)?[\u4e00-\u9fff]{1,4}(先生|女士|小姐)?\s*(\d*日内)?(在线|活跃|刚刚活跃|今日活跃)/;
const HR_TAIL_RE =
  /\s*[\u4e00-\u9fff]{1,4}(先生|女士)?\s*(\d*日内)?(在线|活跃|刚刚活跃|今日活跃)[\s\S]*$/;

export function isHrNameTitle(title) {
  const t = String(title || "").trim();
  if (!t) return true;
  if (HR_TITLE_RE.test(t)) return true;
  if (/(在线|活跃|招聘者|HR|hrbp)/i.test(t) && t.length <= 16) return true;
  return false;
}

/** 优先列表岗位名，丢掉详情里误抓的 HR 名片 */
export function pickJobTitle(detailTitle, listTitle) {
  const list = String(listTitle || "").trim();
  const detail = String(detailTitle || "").trim();
  if (list && !isHrNameTitle(list)) return list;
  if (detail && !isHrNameTitle(detail)) return detail;
  return list || detail || "未命名岗位";
}

/** 无可读数字的薪资（Boss 字体加密）视为无效 */
export function normalizeSalary(salary) {
  const s = String(salary || "").trim();
  if (!s) return "";
  if (!/\d/.test(s)) return "";
  return s.replace(/\s+/g, "");
}

function stripNoise(text) {
  let s = String(text || "");
  s = s.replace(/\.[A-Za-z0-9_-]{2,80}\s*\{[^}]*\}/g, " ");
  s = s.replace(/来自BOSS直聘|BOSS直聘|kanzhun|\bboss\b/gi, "");
  s = s.replace(/收藏\s*立即沟通\s*举报[\s\S]{0,30}不合适/g, "\n");
  s = s.replace(/微信扫码分享/g, "");
  s = s.replace(HR_TAIL_RE, "");
  const cutMarks = [
    "求职工具",
    "热门职位",
    "热门城市",
    "热门企业",
    "附近城市",
    "去App与",
    "前往App与",
    "查看更多信息",
    "点击查看地图"
  ];
  let cutAt = -1;
  for (const m of cutMarks) {
    const i = s.indexOf(m);
    if (i >= 0 && (cutAt < 0 || i < cutAt)) cutAt = i;
  }
  if (cutAt > 40) s = s.slice(0, cutAt);
  // 工作地址起多为页脚
  const addr = s.search(/\n?工作地址/);
  if (addr > 80) s = s.slice(0, addr);
  return s.replace(/\u200b/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * 从职位描述区开头连续短词推断标签（DOM 未刮到 chips 时的兜底）
 */
function inferKeywordsFromHead(text, max = 16) {
  const head = text.slice(0, 120);
  // 「职位描述」后到「岗位职责/工作职责」前的粘连标签
  const m = head.match(/职位描述(.+?)(岗位职责|工作职责|任职要求|职位描述：)/);
  const chunk = m ? m[1] : "";
  if (!chunk || chunk.length > 80) return [];
  // 按常见 2–8 字片段切（启发式，不完美）
  const parts = chunk
    .replace(/职位描述/g, "")
    .split(/(?<=[\u4e00-\u9fff]{2,8})(?=[\u4e00-\u9fffA-Za-z])/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && x.length <= 12);
  return [...new Set(parts)].slice(0, max);
}

/**
 * @returns {{
 *  keywords: string[],
 *  responsibilities: string,
 *  requirements: string,
 *  bonus: string,
 *  description: string
 * }}
 */
export function parseJobSections(rawDescription, domKeywords = []) {
  let text = stripNoise(rawDescription);
  text = text.replace(/^职位描述\s*/g, "");

  let keywords = [...(domKeywords || [])]
    .map((k) => String(k || "").replace(/["""'']/g, "").trim())
    .filter((k) => {
      if (!k || k.length < 2 || k.length > 16) return false;
      if (/^[一二三四五六七八九十]+[、.．]?$/.test(k)) return false;
      if (/持\/交付|PMPPMP/.test(k)) return false;
      return /[\u4e00-\u9fffA-Za-z]/.test(k);
    });
  keywords = [...new Set(keywords)];
  if (!keywords.length) {
    keywords = inferKeywordsFromHead(`职位描述${text}`);
  }

  // 开头到「岗位职责/任职要求」之间若无编号列表，视为标签粘连，整段丢掉
  {
    const idx = text.search(/岗位职责|工作职责|任职要求|任职资格/);
    if (idx > 0 && idx < 160) {
      const before = text.slice(0, idx);
      if (!/\d+\s*[、.]/.test(before)) {
        text = text.slice(idx);
      }
    }
  }

  let responsibilities = "";
  let requirements = "";
  let bonus = "";

  const reqIdx = text.search(/任职要求|任职资格|岗位要求|职位要求/);
  const dutyIdx = text.search(/岗位职责|工作职责|职位描述：|岗位描述/);

  if (reqIdx >= 0) {
    let afterReq = text.slice(reqIdx).replace(/^(任职要求|任职资格|岗位要求|职位要求)[：:\s]*/, "");
    const bonusInReq = afterReq.search(/\n?加分项[：:]/);
    if (bonusInReq >= 0) {
      bonus = afterReq.slice(bonusInReq).replace(/^\n?加分项[：:]\s*/, "").trim();
      afterReq = afterReq.slice(0, bonusInReq).trim();
    }
    // 任职里「…优先」句保留在 requirements，bonus 仅独立「加分项」标题
    requirements = afterReq.trim();
    const before = dutyIdx >= 0 && dutyIdx < reqIdx ? text.slice(0, reqIdx) : text.slice(0, reqIdx);
    responsibilities = before
      .replace(/^(岗位职责|工作职责|职位描述：|岗位描述)[：:\s]*/, "")
      .trim();
  } else if (dutyIdx >= 0) {
    responsibilities = text
      .slice(dutyIdx)
      .replace(/^(岗位职责|工作职责|职位描述：|岗位描述)[：:\s]*/, "")
      .trim();
  } else {
    responsibilities = text;
  }

  // 从任职要求中再拆「加分项：」内联
  if (!bonus && requirements) {
    const bi = requirements.search(/加分项[：:]/);
    if (bi >= 0) {
      bonus = requirements.slice(bi).replace(/^加分项[：:]\s*/, "").trim();
      requirements = requirements.slice(0, bi).trim();
    }
  }

  const description = [
    keywords.length ? `【职位标签】${keywords.join("、")}` : "",
    responsibilities ? `【工作职责】\n${responsibilities}` : "",
    requirements ? `【任职要求】\n${requirements}` : "",
    bonus ? `【加分项】\n${bonus}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    keywords,
    responsibilities,
    requirements,
    bonus,
    description: description || text
  };
}

/** 压缩 DeepSeek 分析结果多余空行 */
export function compactAnalysis(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
