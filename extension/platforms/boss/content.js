/**
 * Boss 直聘页面适配器（Content Script）
 *
 * 注意（geek 列表页）：
 * - 点开岗位多为右侧抽屉，location.href 仍是搜索页 → 链接从卡片 data-jobid / job_detail 取
 * - 薪资常用私有字体防爬 → 尽量读 data-*；解不开则原样带回并在导出里提示
 * - 详情下方有「热门职位/广告销售」等页脚 → 必须裁切，否则避雷误杀
 */
(() => {
  if (window.__careerLensBoss) return;
  window.__careerLensBoss = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 可见文本：去掉 script/style，避免把 CSS 规则拼进摘要 */
  function visibleText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, svg, link").forEach((n) => n.remove());
    // 隐藏节点（含 Boss 反爬插入的不可见 span）
    clone.querySelectorAll("*").forEach((n) => {
      const style = n.getAttribute("style") || "";
      const cls = n.className?.toString?.() || "";
      if (
        /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0/i.test(style) ||
        n.getAttribute("hidden") != null ||
        n.getAttribute("aria-hidden") === "true"
      ) {
        n.remove();
        return;
      }
      // 极小尺寸反爬节点
      if (/width:\s*0\.1px|height:\s*0\.1px/i.test(style)) n.remove();
    });
    return (clone.innerText || clone.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function textOf(el) {
    return visibleText(el);
  }

  /** 去掉 CSS 碎片、站点噪声，截断到岗位正文结束 */
  function cleanJobText(raw) {
    let s = String(raw || "");
    // 去掉嵌入的 CSS 规则块
    s = s.replace(/\.[A-Za-z0-9_-]{2,80}\s*\{[^}]*\}/g, " ");
    s = s.replace(/\{[^}]{0,200}display\s*:\s*(?:none|inline-block)[^}]*\}/gi, " ");
    // 常见水印噪声；并去掉汉字间插入的「直聘」（反爬：AI漫直聘剧→AI漫剧）
    s = s.replace(/来自BOSS直聘/g, "");
    s = s.replace(/BOSS直聘/g, "");
    s = s.replace(/直聘/g, "");
    s = s.replace(/kanzhun/gi, "");
    s = s.replace(/\bboss\b/gi, "");
    s = s.replace(/⼯/g, "工").replace(/⽬/g, "目").replace(/⾼/g, "高");
    // UI 操作区噪声（若被拼进正文）
    s = s.replace(/收藏\s*立即沟通\s*举报[\s\S]{0,40}不合适/g, "\n");
    s = s.replace(/微信扫码分享/g, "");
    s = s.replace(/数据加载失败|点击重新加载/g, " ");
    // 截断页脚 / 侧栏推荐（否则「广告销售招聘」会误触避雷「销售」）
    const cutMarks = [
      "求职工具",
      "热门职位",
      "热门城市",
      "热门企业",
      "附近城市",
      "去App与BOSS随时沟通",
      "前往App与BOSS随时沟通",
      "查看更多信息",
      "点击查看地图",
      "工作地址"
    ];
    let cutAt = -1;
    for (const m of cutMarks) {
      const i = s.indexOf(m);
      if (i >= 0 && (cutAt < 0 || i < cutAt)) cutAt = i;
    }
    // 失败页正文极短时「求职工具」也在前 80 字内，必须裁掉
    if (cutAt >= 0) s = s.slice(0, cutAt);
    // 若仍含「岗位职责/任职」，尽量从该处起取
    const startMarks = ["职位描述", "岗位职责", "岗位描述", "任职要求", "任职资格", "工作职责"];
    let start = -1;
    for (const m of startMarks) {
      const i = s.indexOf(m);
      if (i >= 0 && (start < 0 || i < start)) start = i;
    }
    if (start > 0 && start < 200) s = s.slice(start);
    return s.replace(/\s+/g, " ").replace(/\s*([1-9]、|\d+\.)\s*/g, "\n$1 ").trim();
  }

  function absUrl(href) {
    if (!href || href === "#" || href.startsWith("javascript:")) return "";
    try {
      return new URL(href, location.origin).href;
    } catch {
      return "";
    }
  }

  function isSearchUrl(url) {
    return /\/web\/geek\/jobs/.test(url || "") || /\/job_detail\//.test(url || "") === false && /[?&]city=/.test(url || "");
  }

  function listItems() {
    const selectors = [
      "li.job-card-box",
      "li.job-card-wrapper",
      ".job-list-box li.job-card-wrapper",
      ".job-list-box li.job-card-box",
      ".job-list-container li",
      "ul.rec-job-list li",
      "li[data-jobid]",
      "li[class*='job-card']"
    ];
    for (const sel of selectors) {
      const nodes = [...document.querySelectorAll(sel)].filter((n) => {
        const t = textOf(n);
        return t.length > 8;
      });
      if (nodes.length >= 3) return nodes;
      if (nodes.length) return nodes;
    }
    return [];
  }

  function pickJobId(el) {
    const attrs = ["data-jobid", "data-job-id", "data-lid", "data-encrypt-job-id"];
    for (const a of attrs) {
      const v = el.getAttribute?.(a) || el.querySelector?.(`[${a}]`)?.getAttribute(a);
      if (v) return v;
    }
    const href =
      el.querySelector?.("a[href*='job_detail']")?.getAttribute("href") ||
      el.querySelector?.("a[href*='/job/']")?.getAttribute("href") ||
      "";
    const m = href.match(/job_detail\/([^?.#]+)/) || href.match(/\/job\/([^?.#]+)/);
    return m?.[1] || "";
  }

  function jobUrlFromId(jobId) {
    if (!jobId) return "";
    // encryptJobId 通常已是 URL 安全串
    return `https://www.zhipin.com/job_detail/${jobId}.html`;
  }

  function pickSalary(el) {
    if (!el) return "";
    const nodes = [
      el.querySelector(".salary"),
      el.querySelector("[class*='salary']"),
      el.querySelector(".job-salary"),
      el.querySelector("span.salary")
    ].filter(Boolean);
    for (const n of nodes) {
      const data =
        n.getAttribute("data-salary") ||
        n.getAttribute("data-val") ||
        n.getAttribute("aria-label") ||
        "";
      if (/\d/.test(data)) return data.replace(/\s+/g, "");
      const t = textOf(n);
      // 正常数字薪资
      if (/\d+\s*[-~]\s*\d+\s*[Kk千]/.test(t) || /\d+[Kk]/.test(t)) return t.replace(/\s+/g, "");
      if (t && /K|薪|万/.test(t)) return t.replace(/\s+/g, "");
    }
    // 从整卡文本里抓「30-40K」类（若未被字体加密）
    const all = textOf(el);
    const m = all.match(/(\d{1,2}\s*[-~]\s*\d{1,2}\s*K(?:·\d+薪)?)/i);
    if (m) return m[1].replace(/\s+/g, "");
    return "";
  }

  function pickCompany(el) {
    if (!el) return "";
    const sels = [
      ".company-name",
      ".boss-name",
      ".company-info .name",
      "[class*='company-name']",
      ".info-company a",
      ".company-text",
      "h3.company-name",
      ".job-card-footer .company-name",
      ".job-card-right .company-name"
    ];
    for (const sel of sels) {
      const t = textOf(el.querySelector(sel));
      if (t && t.length >= 2 && t.length < 40 && !/立即沟通|收藏|举报/.test(t)) return t;
    }
    // 列表卡底部常见：「公司名 · 区域」
    const footer = textOf(el.querySelector(".job-card-footer") || el.querySelector("[class*='card-footer']"));
    if (footer) {
      const part = footer.split(/[·|]/)[0]?.trim();
      if (part && part.length >= 2 && part.length < 40) return part;
    }
    return "";
  }

  function parseListCard(el, index) {
    const jobId = pickJobId(el);
    const linkEl =
      el.querySelector("a[href*='job_detail']") ||
      el.querySelector("a[href*='/job/']") ||
      el.querySelector("a.job-name") ||
      el.querySelector("a");
    let url = absUrl(linkEl?.getAttribute("href") || "");
    if (!url || isSearchUrl(url) || /\/web\/geek\//.test(url)) {
      url = jobUrlFromId(jobId) || url;
    }
    const title =
      textOf(el.querySelector(".job-name")) ||
      textOf(el.querySelector(".job-title")) ||
      textOf(el.querySelector("a.job-name")) ||
      textOf(linkEl)?.split(/\d|\s/)[0] ||
      textOf(el).slice(0, 40);

    return {
      index,
      title: title.replace(/收藏|立即沟通/g, "").trim(),
      salary: pickSalary(el),
      company: pickCompany(el),
      url,
      jobId,
      listText: cleanJobText(textOf(el)).slice(0, 400)
    };
  }

  function detailRoot() {
    const selectors = [
      ".job-detail-box",
      ".job-detail-container",
      ".job-boss-info",
      "#main .job-detail",
      "[class*='job-detail-box']",
      "[class*='JobDetail']"
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && visibleText(el).length > 40) return el;
    }
    // 勿回退到 body/main（会带页脚热门职位）
    return document.querySelector(".job-detail") || null;
  }

  function descriptionRoot(root) {
    if (!root) return null;
    const sels = [
      ".job-sec-text",
      ".job-detail-section .text",
      ".job-detail-body",
      "[class*='job-sec-text']",
      ".job-detail-section",
      "div.job-sec"
    ];
    for (const sel of sels) {
      const nodes = [...root.querySelectorAll(sel)];
      const joined = nodes.map(visibleText).filter((t) => t.length > 30);
      if (joined.length) {
        // 合成一个虚拟容器文本
        const wrap = document.createElement("div");
        wrap.textContent = joined.join("\n");
        return wrap;
      }
    }
    return root;
  }

  function isHrTitle(t) {
    const s = String(t || "").trim();
    return !s || (/(在线|活跃|招聘者|HR|hrbp)/i.test(s) && s.length <= 18);
  }

  function scrapeKeywords(root) {
    if (!root) return [];
    const sels = [
      ".job-detail-section .job-keyword-list li",
      "ul.job-keyword-list li",
      ".job-sec .job-tags span",
      ".job-tags span",
      "[class*='keyword-list'] li",
      "[class*='job-tag'] li",
      "[class*='job-tag'] span"
    ];
    let nodes = [];
    for (const sel of sels) {
      const found = [...root.querySelectorAll(sel)];
      if (found.length) {
        nodes = found;
        break;
      }
    }
    // 职位描述标题后的第一组短标签
    if (!nodes.length) {
      const sec = root.querySelector(".job-detail-section, .job-sec, [class*='job-sec']");
      if (sec) {
        nodes = [...sec.querySelectorAll("li, span")].filter((el) => {
          const t = textOf(el);
          return t.length >= 2 && t.length <= 16 && el.children.length === 0;
        });
      }
    }
    return [...new Set(
      nodes
        .map(textOf)
        .filter(Boolean)
        .filter((t) => t.length >= 2 && t.length <= 24)
        .filter((t) => !/^(北京|上海|杭州|广州|深圳|成都|南京|武汉|本科|大专|硕士|\d+-\d+年|经验|职位描述)$/.test(t))
    )].slice(0, 24);
  }

  /** 详情区是否加载失败 / 刮到页脚 SEO 云（不可打分） */
  function isBrokenDetailText(raw) {
    const s = String(raw || "");
    if (/数据加载失败|点击重新加载|网络不给力|网络异常|加载失败/.test(s)) return true;
    if (/热门职位/.test(s) && /热门城市|热门企业/.test(s)) return true;
    if (/求职工具\s*VIP|VIP已开通/.test(s) && !/任职要求|岗位职责|工作职责|职位描述/.test(s)) {
      return true;
    }
    if ((s.match(/[\u4e00-\u9fffA-Za-z]{2,16}招聘/g) || []).length >= 6) return true;
    return false;
  }

  function looksLikeJobBody(s) {
    const t = String(s || "");
    if (!t || t.length < 40 || isBrokenDetailText(t)) return false;
    if (/任职要求|任职资格|岗位职责|工作职责|职位描述|岗位描述|职位介绍/.test(t)) return true;
    return t.length >= 80 && /负责|熟悉|经验|要求|优先|本科|硕士|项目|交付|管理/.test(t);
  }

  function scrapeDetail() {
    const root = detailRoot();
    const listActive =
      document.querySelector("li.job-card-box.active") ||
      document.querySelector("li.job-card-wrapper.active") ||
      document.querySelector("li[class*='job-card'].active") ||
      document.querySelector(".job-card-wrapper.actived") ||
      document.querySelector("li.job-card-box.select") ||
      document.querySelector(".job-list-box li.active");

    const fromList = listActive ? parseListCard(listActive, -1) : null;

    // 详情区常见岗位名节点（避免 .name 命中 HR）
    const detailTitleCand =
      textOf(root?.querySelector(".job-detail .name.info-primary .name")) ||
      textOf(root?.querySelector(".info-primary .name")) ||
      textOf(root?.querySelector("h1")) ||
      textOf(root?.querySelector(".job-name")) ||
      "";
    const title = !isHrTitle(fromList?.title)
      ? fromList.title
      : !isHrTitle(detailTitleCand)
        ? detailTitleCand
        : fromList?.title || detailTitleCand || "";

    let salary = pickSalary(root) || fromList?.salary || "";
    // 无可读数字则清空（字体加密）
    if (salary && !/\d/.test(salary)) salary = "";

    let company =
      pickCompany(root) ||
      textOf(root?.querySelector(".company-info a")) ||
      textOf(root?.querySelector(".company-info .name"))?.split(/[·|]/)[0]?.trim() ||
      fromList?.company ||
      "";

    const keywords = scrapeKeywords(root);

    const descEl = descriptionRoot(root);
    const rawProbe = [
      root ? visibleText(root).slice(0, 4000) : "",
      descEl ? visibleText(descEl).slice(0, 4000) : ""
    ].join("\n");
    const loadFailed = isBrokenDetailText(rawProbe);

    let description = cleanJobText(visibleText(descEl));
    if (description.length < 40 && root && !loadFailed) {
      description = cleanJobText(visibleText(root));
    }
    if (loadFailed || isBrokenDetailText(description) || !looksLikeJobBody(description)) {
      description = "";
    }

    const favBtn = findFavoriteButton(root || document);
    const favorited = isFavorited(favBtn);

    let jobId = fromList?.jobId || pickJobId(root || document.body);
    let url = fromList?.url || jobUrlFromId(jobId);
    if (/job_detail\//.test(location.href)) {
      url = location.href.split("?")[0];
      jobId = pickJobId(document.body) || jobId;
    }
    if (!url || isSearchUrl(url)) {
      url = jobUrlFromId(jobId) || fromList?.url || "";
    }

    const ready = !loadFailed && looksLikeJobBody(description);

    return {
      title: String(title || "").replace(/收藏|立即沟通|举报/g, "").trim(),
      listTitle: fromList?.title || "",
      salary,
      company,
      keywords,
      description,
      url,
      jobId,
      favorited,
      loadFailed,
      ready,
      rawLength: description.length
    };
  }

  function findFavoriteButton(root = document) {
    if (!root) return null;
    const candidates = [...root.querySelectorAll("a, button, span, div")].filter((el) => {
      const t = textOf(el);
      const aria = `${el.getAttribute("aria-label") || ""}${el.getAttribute("title") || ""}`;
      return t === "收藏" || t === "已收藏" || aria.includes("收藏");
    });
    return candidates[0] || null;
  }

  function isFavorited(btn) {
    if (!btn) return false;
    const t = textOf(btn);
    const cls = btn.className?.toString?.() || "";
    return t.includes("已收藏") || /active|collected|liked|favorited/i.test(cls);
  }

  async function ensureFavorite() {
    const btn = findFavoriteButton(detailRoot() || document);
    if (!btn) return { ok: false, reason: "未找到收藏按钮", favorited: false };
    if (isFavorited(btn)) return { ok: true, favorited: true, skipped: true };
    btn.click();
    await sleep(600);
    return { ok: true, favorited: isFavorited(btn), skipped: false };
  }

  async function openListItem(index) {
    const items = listItems();
    if (index < 0 || index >= items.length) {
      return { ok: false, reason: `列表索引越界 ${index}/${items.length}` };
    }
    const el = items[index];
    const card = parseListCard(el, index);
    const before = scrapeDetail();
    el.scrollIntoView({ block: "center" });
    await sleep(200);
    const clickable =
      el.querySelector("a.job-name") ||
      el.querySelector("a[href*='job_detail']") ||
      el.querySelector(".job-title") ||
      el.querySelector("a") ||
      el;
    clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));

    const start = Date.now();
    while (Date.now() - start < 10000) {
      await sleep(350);
      const now = scrapeDetail();
      if (now.loadFailed) {
        // 明确失败页：继续等到超时，勿把页脚当 JD
        continue;
      }
      const titleChanged = now.title && before.title && now.title !== before.title;
      const descReady = now.ready && now.rawLength > 60;
      if ((titleChanged || index === 0 || now.jobId) && descReady) {
        return {
          ok: true,
          detail: mergeCard(now, card),
          listCount: items.length
        };
      }
    }
    const last = scrapeDetail();
    if (last.loadFailed || isBrokenDetailText(visibleText(detailRoot()))) {
      return {
        ok: false,
        detail: mergeCard({ ...last, description: "", rawLength: 0, ready: false, loadFailed: true }, card),
        listCount: items.length,
        reason: "详情数据加载失败，请刷新后重试"
      };
    }
    const detail = mergeCard(last, card);
    return {
      ok: false,
      detail,
      listCount: items.length,
      reason: detail.ready && detail.rawLength > 40 ? "" : "详情加载超时或正文不可用，请刷新后重试"
    };
  }

  function mergeCard(detail, card) {
    // 失败/空详情不要用列表摘要冒充 JD 去打高分
    const desc =
      detail.loadFailed || detail.ready === false
        ? detail.description || ""
        : detail.description || card.listText || "";
    return {
      ...detail,
      title: detail.title || card.title,
      salary: detail.salary || card.salary,
      company: detail.company || card.company,
      url: (!detail.url || isSearchUrl(detail.url) ? card.url : detail.url) || card.url,
      jobId: detail.jobId || card.jobId,
      keywords: detail.keywords?.length ? detail.keywords : [],
      description: desc,
      loadFailed: !!detail.loadFailed,
      ready: !!detail.ready && !!desc
    };
  }

  async function scrollJobList() {
    const containers = [
      document.querySelector(".job-list-container"),
      document.querySelector(".job-list-box"),
      document.querySelector("[class*='job-list']"),
      document.scrollingElement
    ].filter(Boolean);

    const before = listItems().length;
    const box = containers[0];
    if (box && box !== document.scrollingElement) {
      box.scrollTop = box.scrollTop + Math.min(600, box.clientHeight || 400);
    } else {
      window.scrollBy(0, 500);
    }
    await sleep(800 + Math.random() * 700);
    const after = listItems().length;
    return { before, after, grew: after > before };
  }

  function detectBlocker() {
    const body = visibleText(document.body).slice(0, 2500);
    const detailText = visibleText(detailRoot()).slice(0, 2500);
    const probe = `${detailText}\n${body}`;
    if (/验证码|滑动验证|异常访问|人机验证|请完成验证/.test(probe)) {
      return { blocked: true, reason: "检测到验证码或安全校验" };
    }
    if (
      /数据加载失败|点击重新加载|网络异常|网络不给力|加载失败|请刷新|出错了|系统繁忙|服务异常|请求失败/.test(
        probe
      )
    ) {
      return { blocked: true, reason: "检测到页面网络/加载异常，请刷新后等待自动继续" };
    }
    return { blocked: false };
  }

  /** 开跑前 DOM / 页面健康检查 */
  function healthCheck() {
    const href = location.href || "";
    const onBoss = /zhipin\.com/.test(href);
    const items = listItems();
    const listOk = items.length > 0;
    const detailRoot =
      document.querySelector(".job-detail") ||
      document.querySelector(".job-detail-box") ||
      document.querySelector("[class*='job-detail']");
    const blocker = detectBlocker();
    const visible = document.visibilityState === "visible";
    const checks = [
      { name: "Boss 域名", ok: onBoss, detail: onBoss ? "ok" : href.slice(0, 80) },
      { name: "职位列表卡片", ok: listOk, detail: `识别 ${items.length} 条` },
      {
        name: "详情容器",
        ok: !!detailRoot || listOk,
        detail: detailRoot ? "已找到" : listOk ? "列表页可稍后加载详情" : "未找到"
      },
      { name: "页面可见", ok: visible, detail: document.visibilityState },
      { name: "验证码/风控", ok: !blocker.blocked, detail: blocker.blocked ? blocker.reason : "无" }
    ];
    const ok = checks.every((c) => c.ok);
    return { ok, checks, count: items.length, href, blocked: blocker.blocked, reason: blocker.reason };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case "CL_PING":
            sendResponse({ ok: true, href: location.href, visible: document.visibilityState });
            break;
          case "CL_HEALTH":
            sendResponse(healthCheck());
            break;
          case "CL_VISIBILITY":
            sendResponse({
              visible: document.visibilityState === "visible",
              focused: document.hasFocus(),
              visibilityState: document.visibilityState
            });
            break;
          case "CL_BLOCKER":
            sendResponse(detectBlocker());
            break;
          case "CL_LIST": {
            const items = listItems().map(parseListCard);
            sendResponse({ ok: true, items, count: items.length });
            break;
          }
          case "CL_OPEN_INDEX":
            sendResponse(await openListItem(msg.index));
            break;
          case "CL_SCRAPE_DETAIL":
            sendResponse({ ok: true, detail: scrapeDetail() });
            break;
          case "CL_FAVORITE":
            sendResponse(await ensureFavorite());
            break;
          case "CL_SCROLL":
            sendResponse(await scrollJobList());
            break;
          case "CL_NEXT_PAGE":
            sendResponse({ ok: false, grew: false, reason: "Boss 使用下拉加载，无需翻页" });
            break;
          default:
            sendResponse({ ok: false, reason: "unknown type" });
        }
      } catch (e) {
        sendResponse({ ok: false, reason: String(e?.message || e) });
      }
    })();
    return true;
  });
})();
