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

/** Boss 反爬常在汉字间插入「直聘」，如「AI漫直聘剧」→「AI漫剧」 */
export function denoiseJobText(text) {
  let s = String(text || "");
  s = s.replace(/直聘/g, "");
  s = s.replace(/⼯/g, "工").replace(/⽬/g, "目").replace(/⾼/g, "高");
  return s;
}

function stripNoise(text) {
  let s = denoiseJobText(text);
  s = s.replace(/\.[A-Za-z0-9_-]{2,80}\s*\{[^}]*\}/g, " ");
  s = s.replace(/来自BOSS直聘|BOSS直聘|kanzhun|\bboss\b/gi, "");
  // 上面 denoise 已去「直聘」，再清残留品牌词
  s = s.replace(/来自BOSS|BOSS/gi, "");
  s = s.replace(/收藏\s*立即沟通\s*举报[\s\S]{0,30}不合适/g, "\n");
  s = s.replace(/微信扫码分享|微信分享扫码/g, "");
  // 猎聘顶栏很长，不能用过短窗口
  s = s.replace(/首页\s*职位\s*校园[\s\S]{0,400}?我的沟通/g, "\n");
  s = s.replace(/投简历|聊一聊|当前在线|已认证/g, " ");
  s = s.replace(HR_TAIL_RE, "");
  // 从「职位介绍」起算职责（丢掉标题区福利 chips）
  {
    const intro = s.search(/职位介绍|主要职责描述|岗位职责|工作职责|任职要求/);
    if (intro > 0) s = s.slice(intro);
  }
  // 详情加载失败页常见前缀
  s = s.replace(/数据加载失败|点击重新加载|网络不给力[，,]?请稍后重试/g, " ");
  const cutMarks = [
    "求职工具",
    "热门职位",
    "热门城市",
    "热门企业",
    "附近城市",
    "去App与",
    "前往App与",
    "查看更多信息",
    "点击查看地图",
    "公司简介",
    "猎聘温馨提示",
    "猜你喜欢",
    "推荐企业",
    "相似职位"
  ];
  let cutAt = -1;
  for (const m of cutMarks) {
    const i = s.indexOf(m);
    if (i >= 0 && (cutAt < 0 || i < cutAt)) cutAt = i;
  }
  // 页脚标记一律裁掉（此前要求 cutAt>40，失败页正文极短时会整段保留「热门职位…招聘」）
  if (cutAt >= 0) s = s.slice(0, cutAt);
  // 工作地址起多为页脚
  const addr = s.search(/\n?工作地址/);
  if (addr > 80) s = s.slice(0, addr);
  return s.replace(/\u200b/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

function hasJobStructure(text) {
  return /任职要求|任职资格|岗位职责|工作职责|职位描述|岗位描述|职位介绍|主要职责/.test(
    String(text || "")
  );
}

/**
 * 详情未真正加载：失败提示、VIP/页脚 SEO 云、大量「xx招聘」串联。
 * 此类文本不得进入打分/建议投递。
 */
export function isUnusableJobDescription(text) {
  const raw = String(text || "");
  if (!raw.trim()) return true;
  if (/数据加载失败|点击重新加载|网络不给力|页面出错了|系统繁忙/.test(raw)) return true;
  if (/热门职位/.test(raw) && /热门城市|热门企业/.test(raw)) return true;
  const hireCloud = (raw.match(/[\u4e00-\u9fffA-Za-z]{2,16}招聘/g) || []).length;
  if (hireCloud >= 6) return true;
  if (/求职工具\s*VIP|VIP已开通有效期/.test(raw) && !hasJobStructure(raw)) return true;

  const cleaned = stripNoise(raw);
  // 裁掉页脚/失败提示后空了 → 不可用
  if (!cleaned.trim()) return true;
  if (/热门职位|求职工具|数据加载失败/.test(cleaned)) return true;
  if (hasJobStructure(cleaned) || hasJobStructure(raw)) return false;
  // 无结构时需足够长且像职责表述，避免列表残片/页脚冒充 JD
  if (cleaned.length >= 80 && /负责|熟悉|经验|要求|优先|本科|硕士|项目|交付|管理/.test(cleaned)) {
    return false;
  }
  return true;
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

  const welfareRe =
    /^(五险一金|绩效奖金|年终奖金|带薪年假|定期体检|节日礼物|团队聚餐|餐费补贴|通讯津贴|提供住宿|外派津贴|弹性工作|扁平管理|领导好|发展空间大|公司规模大|优秀员工奖|加班补助|股票期权|补充医疗|交通补助|住房补贴|双休|周末双休|包吃|包住)$/;
  let keywords = [...(domKeywords || [])]
    .map((k) => String(k || "").replace(/["""'']/g, "").trim())
    .filter((k) => {
      if (!k || k.length < 2 || k.length > 16) return false;
      if (/^[一二三四五六七八九十]+[、.．]?$/.test(k)) return false;
      if (/持\/交付|PMPPMP/.test(k)) return false;
      if (welfareRe.test(k)) return false;
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
  const dutyIdx = text.search(/岗位职责|工作职责|职位介绍|主要职责|职位描述：|岗位描述/);

  if (reqIdx >= 0) {
    let afterReq = text.slice(reqIdx).replace(/^(任职要求|任职资格|岗位要求|职位要求)[：:\s]*/, "");
    // 猎聘「其他信息」之后多为语言/行业标签，保留在任职里；公司简介已在 stripNoise 裁掉
    const otherIdx = afterReq.search(/\n?其他信息/);
    if (otherIdx > 40) {
      // 保留其他信息中的语言/行业，一并留在 requirements
    }
    const bonusInReq = afterReq.search(/\n?加分项[：:]/);
    if (bonusInReq >= 0) {
      bonus = afterReq.slice(bonusInReq).replace(/^\n?加分项[：:]\s*/, "").trim();
      afterReq = afterReq.slice(0, bonusInReq).trim();
    }
    // 任职里「…优先」句保留在 requirements，bonus 仅独立「加分项」标题
    requirements = afterReq.trim();
    const before = dutyIdx >= 0 && dutyIdx < reqIdx ? text.slice(0, reqIdx) : text.slice(0, reqIdx);
    responsibilities = before
      .replace(/^(职位介绍|岗位职责|工作职责|主要职责描述|职位描述：|岗位描述)[：:\s]*/, "")
      .replace(/^主要职责描述[：:\s]*/, "")
      .trim();
  } else if (dutyIdx >= 0) {
    responsibilities = text
      .slice(dutyIdx)
      .replace(/^(职位介绍|岗位职责|工作职责|主要职责描述|职位描述：|岗位描述)[：:\s]*/, "")
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
