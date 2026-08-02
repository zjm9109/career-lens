/**
 * 猎聘列表/详情采集（CL_* 协议与 Boss 对齐）
 * DOM 若改版，优先改本文件选择器。
 */
(() => {
  if (window.__careerLensLiepinInjected) return;
  window.__careerLensLiepinInjected = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function textOf(el) {
    return (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function listCards() {
    const sels = [
      ".job-card-pc-container",
      ".job-list-item",
      "[data-job-id]",
      ".job-card-wrap",
      "div.job-card-pc"
    ];
    for (const sel of sels) {
      const nodes = [...document.querySelectorAll(sel)].filter((n) => textOf(n).length > 10);
      if (nodes.length) return nodes;
    }
    return [];
  }

  function parseCard(el, index) {
    const title =
      textOf(el.querySelector(".job-title-box .ellipsis-1")) ||
      textOf(el.querySelector(".job-title")) ||
      textOf(el.querySelector("a[href*='/job/']")) ||
      textOf(el.querySelector("a")) ||
      `岗位${index + 1}`;
    const company =
      textOf(el.querySelector(".company-name")) ||
      textOf(el.querySelector("[class*='company']")) ||
      "";
    const salary = textOf(el.querySelector(".job-salary")) || textOf(el.querySelector("[class*='salary']")) || "";
    const a = el.querySelector("a[href*='/job/']") || el.querySelector("a[href*='job']") || el.querySelector("a");
    let url = a?.href || "";
    if (url && !/^https?:/.test(url)) url = new URL(url, location.origin).href;
    const jobId = el.getAttribute("data-job-id") || url.match(/\/job\/(\d+)/)?.[1] || "";
    return { index, title, company, salary, url, jobId, listText: textOf(el).slice(0, 500) };
  }

  function detailRoot() {
    return (
      document.querySelector(".job-detail-box") ||
      document.querySelector(".job-detail") ||
      document.querySelector("[class*='job-detail']") ||
      document.querySelector("main")
    );
  }

  function scrapeDetail() {
    const root = detailRoot();
    const title =
      textOf(root?.querySelector("h1")) ||
      textOf(root?.querySelector(".job-title")) ||
      textOf(document.querySelector("h1")) ||
      "";
    const company =
      textOf(root?.querySelector(".company-name")) ||
      textOf(root?.querySelector("[class*='company-name']")) ||
      "";
    const description =
      textOf(root?.querySelector(".job-description")) ||
      textOf(root?.querySelector("[class*='description']")) ||
      textOf(root) ||
      "";
    const keywords = [...(root?.querySelectorAll(".job-tags span, .tag-list span, [class*='tag']") || [])]
      .map(textOf)
      .filter((t) => t && t.length < 16)
      .slice(0, 12);
    return {
      title,
      company,
      salary: "",
      url: location.href,
      jobId: location.href.match(/\/job\/(\d+)/)?.[1] || "",
      keywords,
      description: description.slice(0, 12000),
      listTitle: title
    };
  }

  async function openListItem(index) {
    const cards = listCards();
    const el = cards[index];
    if (!el) return { ok: false, reason: "列表无此条目" };
    const card = parseCard(el, index);
    const clickable =
      el.querySelector("a[href*='/job/']") || el.querySelector(".job-title") || el.querySelector("a") || el;
    clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    await sleep(1200);
    const detail = scrapeDetail();
    return { ok: true, detail: { ...card, ...detail, title: detail.title || card.title } };
  }

  async function scrollList() {
    const before = listCards().length;
    const box =
      document.querySelector(".job-list-container") ||
      document.querySelector("[class*='job-list']") ||
      document.scrollingElement;
    if (box && box !== document.scrollingElement) box.scrollTop += 500;
    else window.scrollBy(0, 500);
    await sleep(900);
    const after = listCards().length;
    return { before, after, grew: after > before };
  }

  function detectBlocker() {
    const body = textOf(document.body).slice(0, 2000);
    if (/验证码|滑动验证|异常访问|人机验证|请完成验证/.test(body)) {
      return { blocked: true, reason: "检测到验证码或安全校验" };
    }
    return { blocked: false };
  }

  function healthCheck() {
    const cards = listCards();
    const blocker = detectBlocker();
    const checks = [
      { name: "猎聘域名", ok: /liepin\.com/i.test(location.href), detail: location.hostname },
      { name: "职位列表卡片", ok: cards.length > 0, detail: `识别 ${cards.length} 条` },
      { name: "页面可见", ok: document.visibilityState === "visible", detail: document.visibilityState },
      { name: "验证码/风控", ok: !blocker.blocked, detail: blocker.blocked ? blocker.reason : "无" }
    ];
    return {
      ok: checks.every((c) => c.ok),
      checks,
      count: cards.length,
      href: location.href,
      blocked: blocker.blocked,
      reason: blocker.reason,
      platform: "liepin"
    };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case "CL_PING":
            sendResponse({ ok: true, href: location.href, platform: "liepin" });
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
