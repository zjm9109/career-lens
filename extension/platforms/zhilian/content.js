/**
 * 智联招聘列表/详情采集（CL_* 协议与 Boss 对齐）
 * DOM 若改版，优先改本文件选择器。
 */
(() => {
  if (window.__careerLensZhilianInjected) return;
  window.__careerLensZhilianInjected = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function textOf(el) {
    return (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function listCards() {
    const sels = [
      ".joblist-box .jobinfo",
      ".positionlist .jobinfo",
      "div.joblist-item",
      ".job-card",
      "[class*='joblist'] a.jobname",
      ".soulistitem"
    ];
    for (const sel of sels) {
      let nodes = [...document.querySelectorAll(sel)];
      // 若命中的是标题链接，上溯到卡片容器
      if (nodes.length && nodes[0].tagName === "A") {
        nodes = nodes.map((a) => a.closest("div") || a.parentElement).filter(Boolean);
      }
      nodes = [...new Set(nodes)].filter((n) => textOf(n).length > 10);
      if (nodes.length) return nodes;
    }
    return [];
  }

  function parseCard(el, index) {
    const title =
      textOf(el.querySelector(".jobname")) ||
      textOf(el.querySelector("a.jobname")) ||
      textOf(el.querySelector("[class*='job-name']")) ||
      textOf(el.querySelector("a")) ||
      `岗位${index + 1}`;
    const company =
      textOf(el.querySelector(".companyname")) ||
      textOf(el.querySelector("[class*='company']")) ||
      "";
    const salary =
      textOf(el.querySelector(".salary")) || textOf(el.querySelector("[class*='salary']")) || "";
    const a =
      el.querySelector("a.jobname") ||
      el.querySelector("a[href*='job']") ||
      el.querySelector("a[href*='position']") ||
      el.querySelector("a");
    let url = a?.href || "";
    if (url && !/^https?:/.test(url)) url = new URL(url, location.origin).href;
    const jobId = url.match(/\/(\d+)\.htm/)?.[1] || url.match(/job[Ii]d=(\d+)/)?.[1] || "";
    return { index, title, company, salary, url, jobId, listText: textOf(el).slice(0, 500) };
  }

  function detailRoot() {
    return (
      document.querySelector(".job-detail") ||
      document.querySelector(".position-detail") ||
      document.querySelector("[class*='job-detail']") ||
      document.querySelector("main") ||
      document.body
    );
  }

  function scrapeDetail() {
    const root = detailRoot();
    const title =
      textOf(root.querySelector("h1")) ||
      textOf(root.querySelector(".jobname")) ||
      textOf(document.querySelector("h1")) ||
      "";
    const company =
      textOf(root.querySelector(".company-name")) ||
      textOf(root.querySelector("[class*='company'] a")) ||
      "";
    const description =
      textOf(root.querySelector(".describtion")) ||
      textOf(root.querySelector(".description")) ||
      textOf(root.querySelector("[class*='job-detail']")) ||
      textOf(root).slice(0, 12000);
    const keywords = [...root.querySelectorAll(".job-tags span, .welfare-list span, [class*='tag']")]
      .map(textOf)
      .filter((t) => t && t.length >= 2 && t.length < 16)
      .slice(0, 12);
    return {
      title,
      company,
      salary: "",
      url: location.href,
      jobId: location.href.match(/\/(\d+)\.htm/)?.[1] || "",
      keywords,
      description,
      listTitle: title
    };
  }

  async function openListItem(index) {
    const cards = listCards();
    const el = cards[index];
    if (!el) return { ok: false, reason: "列表无此条目" };
    const card = parseCard(el, index);
    const clickable = el.querySelector("a.jobname") || el.querySelector("a") || el;
    clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    await sleep(1200);
    const detail = scrapeDetail();
    return { ok: true, detail: { ...card, ...detail, title: detail.title || card.title } };
  }

  async function scrollList() {
    const before = listCards().length;
    window.scrollBy(0, 600);
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
      { name: "智联域名", ok: /zhaopin\.com/i.test(location.href), detail: location.hostname },
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
      platform: "zhilian"
    };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case "CL_PING":
            sendResponse({ ok: true, href: location.href, platform: "zhilian" });
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
            sendResponse({ ok: true, items, count: items.length, platform: "zhilian" });
            break;
          }
          case "CL_OPEN_INDEX":
            sendResponse(await openListItem(msg.index));
            break;
          case "CL_SCRAPE_DETAIL":
            sendResponse({ ok: true, detail: scrapeDetail() });
            break;
          case "CL_FAVORITE":
            sendResponse({ ok: false, favorited: false, reason: "智联暂未实现自动收藏" });
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
