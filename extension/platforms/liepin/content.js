/**
 * 猎聘列表/详情采集（CL_* 协议与 Boss 对齐）
 * 详情为独立 /job/xxx 页（新标签）；列表页只回链接，由侧栏开标签采集后关闭。
 */
(() => {
  if (window.__careerLensLiepinInjected) return;
  window.__careerLensLiepinInjected = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function textOf(el) {
    return (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isJobDetailUrl(url = location.href) {
    return /liepin\.com\/job\/\d+/i.test(url || "");
  }

  /** 风控/短信验证页（详情连开过快时常见） */
  function isRiskPage(url = location.href) {
    const href = url || "";
    if (/safe\.liepin\.com|\/intercept\/|verifysms/i.test(href)) return true;
    const body = textOf(document.body).slice(0, 3500);
    return /账号行为异常|异常访问行为|请进行短信验证|短信验证码/.test(body);
  }

  function isListPage() {
    return /liepin\.com\/zhaopin/i.test(location.href) || listCards().length > 0;
  }

  function listCards() {
    const sels = [
      ".job-card-pc-container",
      ".job-list-item",
      "[data-job-id]",
      ".job-card-wrap",
      "div.job-card-pc",
      ".job-detail-box",
      "[class*='job-card']"
    ];
    let nodes = [];
    for (const sel of sels) {
      const found = [...document.querySelectorAll(sel)].filter((n) => textOf(n).length > 20);
      if (found.length > nodes.length) nodes = found;
    }
    // 只要带 /job/ 链接的卡片，过滤企业广告位等
    return nodes.filter((n) => !!n.querySelector("a[href*='/job/']"));
  }

  function parseCard(el, index) {
    const title =
      textOf(el.querySelector(".job-title-box .ellipsis-1")) ||
      textOf(el.querySelector(".job-title-box")) ||
      textOf(el.querySelector(".job-title")) ||
      textOf(el.querySelector("a[href*='/job/']")) ||
      textOf(el.querySelector("a")) ||
      `岗位${index + 1}`;
    const company =
      textOf(el.querySelector(".company-name")) ||
      textOf(el.querySelector("[class*='company-name']")) ||
      textOf(el.querySelector(".comp-name")) ||
      "";
    const salary =
      textOf(el.querySelector(".job-salary")) ||
      textOf(el.querySelector("[class*='salary']")) ||
      "";
    const a = el.querySelector("a[href*='/job/']") || el.querySelector("a[href*='job']");
    let url = a?.href || "";
    if (url && !/^https?:/.test(url)) {
      try {
        url = new URL(url, location.origin).href;
      } catch {
        /* ignore */
      }
    }
    // 去掉追踪参数过多时仍保留 job id 路径
    const jobId = el.getAttribute("data-job-id") || url.match(/\/job\/(\d+)/)?.[1] || "";
    return {
      index,
      title: title.replace(/广告|急聘/g, "").trim(),
      company,
      salary,
      url,
      jobId,
      listText: textOf(el).slice(0, 500)
    };
  }

  const WELFARE_TAG_RE =
    /^(五险一金|绩效奖金|年终奖金|带薪年假|定期体检|节日礼物|团队聚餐|餐费补贴|通讯津贴|提供住宿|外派津贴|弹性工作|扁平管理|领导好|发展空间大|公司规模大|优秀员工奖|加班补助|股票期权|补充医疗|交通补助|住房补贴)$/;

  /** 是否已加载到真实职位介绍（勿用导航栏「职位」二字误判就绪） */
  function hasRealJobBody(text) {
    const t = String(text || "");
    if (t.length < 120) return false;
    if (/账号行为异常|短信验证码/.test(t)) return false;
    // 导航壳：有顶栏词但没有职责/任职
    if (/首页\s*职位\s*校园/.test(t) && !/任职要求|主要职责|岗位职责|职位介绍/.test(t)) {
      return false;
    }
    return /职位介绍|主要职责|岗位职责|工作职责|任职要求|任职资格/.test(t);
  }

  function cutJobNoise(text) {
    let s = String(text || "");
    const cuts = [
      "公司简介",
      "公司信息",
      "猎聘温馨提示",
      "猜你喜欢",
      "推荐企业",
      "相似职位",
      "看了又看",
      "经营范围",
      "扫码下载猎聘",
      "相关推荐"
    ];
    let cutAt = -1;
    for (const m of cuts) {
      const i = s.indexOf(m);
      if (i >= 80 && (cutAt < 0 || i < cutAt)) cutAt = i;
    }
    if (cutAt > 0) s = s.slice(0, cutAt);
    return s
      .replace(/投简历|聊一聊|微信分享扫码|收藏/g, " ")
      .replace(/当前在线|已认证/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * 抽取职位介绍正文。猎聘 SPA 常先出顶栏+福利标签，「职位介绍」稍后才有；
   * 绝不能用导航「职位」或福利 chips 当成已就绪。
   */
  function collectJobBodyText() {
    // 1) 优先：带「职位介绍」标题的内容块
    const headNodes = [
      ...document.querySelectorAll("h1,h2,h3,h4,dt,strong,b,.title,[class*='title'],[class*='name']")
    ];
    for (const h of headNodes) {
      const name = textOf(h).replace(/[:：]\s*$/, "");
      if (!/职位介绍|职位描述|岗位职责|工作职责|任职要求|主要职责/.test(name)) continue;
      const box =
        h.closest("[class*='job-intro']") ||
        h.closest("[class*='job-detail']") ||
        h.closest("section") ||
        h.parentElement;
      let t = textOf(box);
      // 若盒子过大（含公司简介），从标题起截
      const fromHead = t.search(/职位介绍|主要职责|任职要求/);
      if (fromHead >= 0) t = t.slice(fromHead);
      t = cutJobNoise(t);
      if (hasRealJobBody(t)) return t.slice(0, 12000);
    }

    // 2) 常见容器
    const sels = [
      "[class*='job-intro']",
      "[class*='job-introduce']",
      "[class*='job-description']",
      "[class*='job-require']",
      ".job-detail-box .content",
      ".content-left"
    ];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest("[class*='recommend'], [class*='guess'], [class*='similar']")) continue;
        let t = cutJobNoise(textOf(el));
        if (hasRealJobBody(t)) return t.slice(0, 12000);
      }
    }

    // 3) 整页 innerText：从「职位介绍」截到「公司简介/猜你喜欢」
    const body = textOf(document.body);
    const start = body.search(/职位介绍|主要职责描述|岗位职责|任职要求/);
    if (start >= 0) {
      const t = cutJobNoise(body.slice(start));
      if (hasRealJobBody(t)) return t.slice(0, 12000);
    }

    // 4) 未就绪：只回短壳，ready=false，让侧栏继续轮询
    return cutJobNoise(body.slice(0, 400));
  }

  function scrapeDetail() {
    if (isRiskPage()) {
      return {
        title: "",
        company: "",
        salary: "",
        url: location.href,
        jobId: "",
        keywords: [],
        description: "",
        listTitle: "",
        rawLength: 0,
        ready: false,
        blocked: true,
        blockReason: "猎聘账号行为异常/短信验证，请先在浏览器完成验证",
        pageKind: "risk"
      };
    }
    if (!isJobDetailUrl()) {
      // 列表页误调时只回空详情
      return {
        title: "",
        company: "",
        salary: "",
        url: location.href,
        jobId: "",
        keywords: [],
        description: "",
        listTitle: "",
        rawLength: 0,
        ready: false,
        pageKind: "list"
      };
    }

    // 主岗位区：排除「猜你喜欢」等推荐，避免薪资/公司串台
    const mainRoot =
      document.querySelector(".job-detail-box") ||
      document.querySelector(".job-detail") ||
      document.querySelector("[class*='job-detail']") ||
      document.querySelector("main") ||
      document.body;

    const title =
      textOf(mainRoot.querySelector("h1")) ||
      textOf(mainRoot.querySelector(".name-box .name")) ||
      textOf(mainRoot.querySelector("[class*='job-title']")) ||
      document.title.replace(/[-_|].*$/, "").trim() ||
      "";

    const salaryEl =
      mainRoot.querySelector(".job-salary") ||
      mainRoot.querySelector("[class*='job-salary']") ||
      mainRoot.querySelector(".salary");
    let salary = textOf(salaryEl);
    if (!salary) {
      // 仅在主标题附近取首个薪资，避免命中猜你喜欢
      const head = textOf(mainRoot).slice(0, 400);
      salary = (head.match(/\d{1,3}-\d{1,3}k(?:·\d+薪)?/i) || [])[0] || "";
    }

    let company = "";
    // HR 行常见：「人事行政· 上海淅减汽车悬架有限公司」
    const hrLine = [...mainRoot.querySelectorAll("div, p, span, a")].find((el) =>
      /人事|招聘|HR|猎头/.test(textOf(el)) && /有限公司|集团|股份|科技/.test(textOf(el))
    );
    if (hrLine) {
      const m = textOf(hrLine).match(/[·・]\s*([^\n]{2,40}?(?:有限公司|集团|股份|科技|研究所))/);
      if (m) company = m[1].trim();
    }
    if (!company) {
      const companyCand = [
        ...mainRoot.querySelectorAll(
          ".company-name, [class*='company-name'], .company-info .name, [class*='company-info'] a"
        )
      ].find((el) => !el.closest("[class*='recommend'], [class*='guess'], [class*='similar'], [class*='like']"));
      company = textOf(companyCand);
    }
    // 公司简介标题旁
    if (!company) {
      const intro = [...document.querySelectorAll("h2,h3,.title")].find((el) =>
        /^公司简介$/.test(textOf(el))
      );
      const near = intro?.parentElement ? textOf(intro.parentElement).slice(0, 80) : "";
      const m = near.match(/([\u4e00-\u9fffA-Za-z0-9（）()]{4,40}(?:有限公司|集团|股份))/);
      if (m) company = m[1];
    }

    const description = collectJobBodyText();
    const keywords = [
      ...mainRoot.querySelectorAll(
        ".tag-list span, .job-tags span, [class*='tag-item'], .labels span, .job-apply-tags span"
      )
    ]
      .map(textOf)
      .filter(
        (t) =>
          t &&
          t.length >= 2 &&
          t.length < 16 &&
          !/广告|急聘|聊一聊|投简历|收藏/.test(t) &&
          !WELFARE_TAG_RE.test(t)
      )
      .slice(0, 16);

    const ready = !!title && hasRealJobBody(description);

    return {
      title,
      company,
      salary,
      url: location.href.split("?")[0],
      jobId: location.href.match(/\/job\/(\d+)/)?.[1] || "",
      keywords,
      description,
      listTitle: title,
      rawLength: description.length,
      ready,
      pageKind: "detail"
    };
  }

  /**
   * 列表页：不点击（避免不可控新标签），把岗位 URL 交给侧栏开标签采集。
   */
  async function openListItem(index) {
    const cards = listCards();
    const el = cards[index];
    if (!el) return { ok: false, reason: "列表无此条目" };
    const card = parseCard(el, index);
    if (!card.url || !/\/job\/\d+/i.test(card.url)) {
      return { ok: false, reason: "该卡片无有效岗位链接（可能是广告位）" };
    }
    el.scrollIntoView({ block: "center" });
    await sleep(150);
    return {
      ok: true,
      opensNewTab: true,
      url: card.url,
      detail: {
        ...card,
        description: card.listText || "",
        rawLength: (card.listText || "").length,
        ready: false
      },
      listCount: cards.length
    };
  }

  async function scrollList() {
    const before = listCards().length;
    const box =
      document.querySelector(".job-list-container") ||
      document.querySelector("[class*='job-list']") ||
      document.scrollingElement;
    if (box && box !== document.scrollingElement) box.scrollTop += 500;
    else window.scrollBy(0, 500);
    await sleep(700 + Math.random() * 400);
    const after = listCards().length;
    return { before, after, grew: after > before, mode: "scroll" };
  }

  /**
   * 猎聘是分页（约 15–20 条/页），不是无限下拉。
   * 点「下一页」后列表替换，grew=true 表示已翻页（条数未必变多）。
   */
  async function nextPage() {
    if (isRiskPage()) {
      return { ok: false, grew: false, reason: "风控页，无法翻页" };
    }
    const beforeIds = listCards()
      .map((el, idx) => {
        const c = parseCard(el, idx);
        return c.jobId || c.url;
      })
      .filter(Boolean)
      .join("|");

    const root =
      document.querySelector(".ant-pagination") ||
      document.querySelector("[class*='pagination']") ||
      document.querySelector(".pager") ||
      document.body;

    const nextBtn =
      root.querySelector(".ant-pagination-next:not(.ant-pagination-disabled)") ||
      root.querySelector("li.ant-pagination-next:not(.ant-pagination-disabled) button") ||
      root.querySelector("a.next:not(.disabled)") ||
      [...root.querySelectorAll("a, button, li")].find((el) => {
        const t = textOf(el);
        const dis =
          el.classList?.contains("disabled") ||
          el.classList?.contains("ant-pagination-disabled") ||
          el.getAttribute("aria-disabled") === "true";
        return !dis && /^(下一页|下页|›|»|>)$/.test(t);
      });

    let clickEl = nextBtn;
    if (clickEl?.tagName === "LI") {
      clickEl = clickEl.querySelector("a, button") || clickEl;
    }

    // 无「下一页」时点当前页码 +1
    if (!clickEl) {
      const active =
        root.querySelector(".ant-pagination-item-active") ||
        root.querySelector("[class*='pagination'] .active") ||
        root.querySelector(".pager .selected");
      const cur = Number(textOf(active).replace(/\D/g, ""));
      if (cur > 0) {
        clickEl = [...root.querySelectorAll(".ant-pagination-item, a, button")].find(
          (el) => Number(textOf(el).replace(/\D/g, "")) === cur + 1
        );
      }
    }

    if (!clickEl) {
      return { ok: false, grew: false, reason: "未找到下一页按钮（可能已是末页）" };
    }

    clickEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    // 等列表替换
    const start = Date.now();
    while (Date.now() - start < 8000) {
      await sleep(400 + Math.random() * 300);
      if (isRiskPage()) {
        return { ok: false, grew: false, blocked: true, reason: "翻页后出现风控验证" };
      }
      const afterIds = listCards()
        .map((el, idx) => {
          const c = parseCard(el, idx);
          return c.jobId || c.url;
        })
        .filter(Boolean)
        .join("|");
      if (afterIds && afterIds !== beforeIds) {
        return {
          ok: true,
          grew: true,
          replaced: true,
          before: beforeIds.split("|").filter(Boolean).length,
          after: listCards().length,
          mode: "page"
        };
      }
    }
    return { ok: false, grew: false, reason: "翻页后列表未变化" };
  }

  function detectBlocker() {
    if (isRiskPage()) {
      return {
        blocked: true,
        reason: "猎聘账号行为异常/短信验证，请先在浏览器完成验证后再继续"
      };
    }
    const body = textOf(document.body).slice(0, 2000);
    if (/验证码|滑动验证|异常访问|人机验证|请完成验证/.test(body)) {
      return { blocked: true, reason: "检测到验证码或安全校验" };
    }
    if (/网络异常|网络不给力|加载失败|请刷新|出错了|系统繁忙|服务异常|请求失败/.test(body)) {
      return { blocked: true, reason: "检测到页面网络/加载异常，请刷新后等待自动继续" };
    }
    return { blocked: false };
  }

  function healthCheck() {
    const cards = listCards();
    const blocker = detectBlocker();
    const onDetail = isJobDetailUrl();
    const checks = [
      { name: "猎聘域名", ok: /liepin\.com/i.test(location.href), detail: location.hostname },
      {
        name: onDetail ? "职位详情页" : "职位列表卡片",
        ok: onDetail || cards.length > 0,
        detail: onDetail ? location.pathname : `识别 ${cards.length} 条`
      },
      { name: "页面可见", ok: document.visibilityState === "visible", detail: document.visibilityState },
      { name: "验证码/风控", ok: !blocker.blocked, detail: blocker.blocked ? blocker.reason : "无" }
    ];
    return {
      ok: checks.filter((c) => c.name !== "页面可见").every((c) => c.ok),
      checks,
      count: cards.length,
      href: location.href,
      blocked: blocker.blocked,
      reason: blocker.reason,
      platform: "liepin",
      pageKind: onDetail ? "detail" : isListPage() ? "list" : "other"
    };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case "CL_PING":
            sendResponse({
              ok: true,
              href: location.href,
              platform: "liepin",
              pageKind: isJobDetailUrl() ? "detail" : "list"
            });
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
            const items = listCards().map(parseCard);
            sendResponse({ ok: true, items, count: items.length, platform: "liepin" });
            break;
          }
          case "CL_OPEN_INDEX":
            sendResponse(await openListItem(msg.index));
            break;
          case "CL_SCRAPE_DETAIL":
            sendResponse({ ok: true, detail: scrapeDetail() });
            break;
          case "CL_FAVORITE":
            sendResponse({ ok: false, favorited: false, reason: "猎聘暂未实现自动收藏" });
            break;
          case "CL_SCROLL":
            sendResponse(await scrollList());
            break;
          case "CL_NEXT_PAGE":
            sendResponse(await nextPage());
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
