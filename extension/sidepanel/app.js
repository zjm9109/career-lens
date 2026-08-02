/**
 * 侧边栏主控：画像 / 设置 / 精筛 / 投递列表
 */
import {
  DEFAULT_AVOID_TAGS,
  DEFAULT_WEIGHTS,
  APPLY_LIST_PAGE_SIZE
} from "../common/constants.js";
import {
  getProfile,
  saveProfile,
  getSettings,
  saveSettings,
  getRunState,
  saveRunState,
  clearRunState,
  getListSession,
  saveListSession,
  clearListSession,
  getApplyList,
  upsertApplyListItem,
  removeApplyListIds,
  patchApplyListStatus
} from "../common/storage.js";
import { scoreJob } from "../common/scoring.js";
import { analyzeJobWithLlm, LLM_PROVIDERS, resolveLlmConfig } from "../common/llm.js";
import { downloadResults, sortResults, formatDuration } from "../common/export.js";
import { parseResumeFile, suggestProfileFromText } from "../common/resume-parse.js";
import {
  compactAnalysis,
  normalizeSalary,
  parseJobSections,
  pickJobTitle
} from "../common/job-sections.js";
import {
  REC,
  enrichResult,
  estimateDeepseekCost,
  groupResultsByRecommendation
} from "../common/recommend.js";
import { detectPlatformFromUrl, allPlatformUrlPatterns } from "../common/platform.js";

const $ = (id) => document.getElementById(id);

const state = {
  running: false,
  paused: false,
  stopFlag: false,
  results: [],
  order: 0,
  processedInBatch: 0,
  sinceRest: 0,
  deepseekCalls: 0,
  nextIndex: 0,
  target: 0,
  /** 当前筛选列表指纹与已处理岗位，用于接着往后筛 */
  listFingerprint: "",
  seenKeys: new Set()
};

function jobKeyOf(cardOrJob) {
  if (!cardOrJob) return "";
  return (
    cardOrJob.jobId ||
    cardOrJob.url ||
    `${cardOrJob.company || ""}|${cardOrJob.title || ""}`
  );
}

function listFingerprintOf(items) {
  return (items || [])
    .slice(0, 5)
    .map((it) => jobKeyOf(it) || it.title || "")
    .join("||");
}

async function refreshStartButton() {
  const btn = $("btnStart");
  if (!btn || state.running) return;
  const sess = await getListSession();
  if (sess.listCursor > 0) {
    btn.textContent = "接着筛选";
    btn.title = `从列表第 ${sess.listCursor + 1} 条接着跑（本批 ${$("batchSize")?.value || 10} 条）`;
  } else {
    btn.textContent = "开始精筛";
    btn.title = "从列表第 1 条开始";
  }
}

const applyUi = {
  page: 0,
  list: []
};

function log(msg) {
  const el = $("log");
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  el.textContent += `[${t}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function setPill(text, cls = "") {
  const el = $("statusPill");
  el.textContent = text;
  el.className = `pill ${cls}`.trim();
}

let toastTimer = null;
function toast(message, type = "ok", ms = 2800) {
  const el = $("toast");
  if (!el) return;
  el.hidden = false;
  el.textContent = message;
  el.className = `toast show ${type === "error" ? "error" : type === "info" ? "info" : ""}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
    el.className = "toast";
  }, ms);
}

function updateDeepseekStats() {
  const est = estimateDeepseekCost(state.deepseekCalls);
  const el = $("deepseekStats");
  if (el) el.textContent = `模型调用：${est.calls} 次 · 预估 ¥${est.yuanText}`;
}

async function exportResultsWithTip(results, mode, format) {
  if (!results?.length) {
    toast("暂无结果可导出", "error");
    return;
  }
  const fmt = format || $("exportFormat")?.value || "md";
  toast(`正在导出 ${fmt === "docx" ? "Word" : "Markdown"}…`, "info", 4000);
  try {
    const { filename } = await downloadResults(results, {
      mode,
      format: fmt,
      deepseekCalls: state.deepseekCalls
    });
    log(`已下载：${filename}（浏览器默认下载目录）`);
    toast(`下载成功：${filename}`, "ok", 3500);
  } catch (e) {
    const msg = e?.message || String(e);
    log(`下载失败：${msg}`);
    toast(`下载失败：${msg}`, "error", 4000);
  }
}

function normalizeJobRecord(raw, listCard = {}) {
  const sections = parseJobSections(raw.description || "", raw.keywords || []);
  const title = pickJobTitle(raw.title || raw.listTitle, listCard.title || raw.listTitle);
  return {
    ...raw,
    title,
    salary: normalizeSalary(raw.salary || listCard.salary),
    company: raw.company || listCard.company || "",
    url: raw.url || listCard.url || "",
    keywords: sections.keywords.length ? sections.keywords : raw.keywords || [],
    responsibilities: sections.responsibilities,
    requirements: sections.requirements,
    bonus: sections.bonus,
    description: sections.description
  };
}

function splitTags(str) {
  return String(str || "")
    .split(/[,，、\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinTags(arr) {
  return (arr || []).join(", ");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitWhilePaused() {
  while (state.paused && !state.stopFlag) {
    await sleep(200);
  }
}

async function getPlatformTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab = tabs[0];
  let platform = detectPlatformFromUrl(tab?.url || "");
  if (!platform) {
    const all = await chrome.tabs.query({ url: allPlatformUrlPatterns() });
    tab = all.find((t) => detectPlatformFromUrl(t.url)) || all[0];
    platform = detectPlatformFromUrl(tab?.url || "");
  }
  if (!tab?.id || !platform) {
    throw new Error("请先打开 Boss / 猎聘 / 智联 职位列表页");
  }
  const label = $("platformLabel");
  if (label) label.textContent = platform.label;
  return { tab, platform };
}

async function sendToPlatform(message) {
  const { tab, platform } = await getPlatformTab();
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [platform.contentScript]
    });
    return await chrome.tabs.sendMessage(tab.id, message);
  }
}

/** @deprecated 兼容旧名 */
async function sendToBoss(message) {
  return sendToPlatform(message);
}

async function refreshPlatformLabel() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const p = detectPlatformFromUrl(tabs[0]?.url || "");
    $("platformLabel").textContent = p ? p.label : "未识别平台（请打开招聘列表）";
  } catch {
    $("platformLabel").textContent = "未识别平台";
  }
}

function renderLlmSettings(settings) {
  const box = $("llmProviderBox");
  const keys = $("llmKeyFields");
  if (!box || !keys) return;
  const current = settings.llmProvider || "deepseek";
  box.innerHTML = LLM_PROVIDERS.map(
    (p) => `<label><input type="radio" name="llmProvider" value="${p.id}" ${
      p.id === current ? "checked" : ""
    }/> ${p.label}<span class="hint" style="margin:0">（${p.region === "cn" ? "国产" : "国外"} · ${p.model}）</span></label>`
  ).join("");
  keys.innerHTML = LLM_PROVIDERS.map(
    (p) => `<label class="block" data-key-for="${p.id}" ${p.id === current ? "" : "hidden"}>
      ${p.label} API Key
      <input id="apiKey_${p.id}" type="password" autocomplete="off" placeholder="sk-..." />
    </label>`
  ).join("");
  for (const p of LLM_PROVIDERS) {
    const el = $(`apiKey_${p.id}`);
    if (el) {
      el.value = settings.apiKeys?.[p.id] || (p.id === "deepseek" ? settings.deepseekApiKey : "") || "";
    }
  }
  box.querySelectorAll("input[name=llmProvider]").forEach((radio) => {
    radio.addEventListener("change", () => {
      keys.querySelectorAll("[data-key-for]").forEach((el) => {
        el.hidden = el.dataset.keyFor !== radio.value;
      });
    });
  });
}

function renderTagBoxes(profile) {
  const mk = (boxId, selectedKey) => {
    const box = $(boxId);
    box.innerHTML = "";
    for (const tag of DEFAULT_AVOID_TAGS) {
      const label = document.createElement("label");
      const checked = (profile[selectedKey] || []).includes(tag);
      label.innerHTML = `<input type="checkbox" value="${tag}" ${checked ? "checked" : ""}/> ${tag}`;
      box.appendChild(label);
    }
  };
  mk("avoidBox", "avoidSelected");
  mk("attentionBox", "attentionSelected");
}

function readTagBox(boxId) {
  return [...$(boxId).querySelectorAll("input:checked")].map((i) => i.value);
}

function readWeightsFromUI() {
  return {
    skill: Number($("wSkill").value) || 0,
    industry: Number($("wIndustry").value) || 0,
    direction: Number($("wDirection").value) || 0,
    certificate: Number($("wCertificate").value) || 0,
    language: Number($("wLanguage").value) || 0
  };
}

function weightSum(weights) {
  return Object.values(weights).reduce((a, b) => a + (Number(b) || 0), 0);
}

function fillWeightsUI(weights) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  $("wSkill").value = w.skill;
  $("wIndustry").value = w.industry;
  $("wDirection").value = w.direction;
  $("wCertificate").value = w.certificate;
  $("wLanguage").value = w.language;
  updateWeightSumHint();
}

function updateWeightSumHint() {
  const sum = weightSum(readWeightsFromUI());
  const el = $("weightSumHint");
  if (!el) return;
  el.textContent = `合计：${sum} / 100`;
  el.classList.toggle("ok", sum === 100);
  el.classList.toggle("bad", sum !== 100);
}

/** @returns {{ ok: true, value: number } | { ok: false, error: string }} */
function readYearsExperience() {
  const raw = $("yearsExperience").value;
  if (raw === "" || raw == null) {
    return { ok: false, error: "请填写工作年限（0–50 的整数）" };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 50) {
    return { ok: false, error: "工作年限须为 0–50 的整数" };
  }
  return { ok: true, value: n };
}

function sourceLabel(row) {
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
  return "—";
}

function applyListThresholdOf(settings) {
  const v = settings.applyListThreshold;
  if (v == null || v === "") return settings.favoriteThreshold ?? 80;
  return Number(v) || 0;
}

async function refreshContinueButton() {
  const rs = await getRunState();
  const btn = $("btnContinue");
  if (!btn) return;
  const can =
    !state.running &&
    rs &&
    typeof rs.nextIndex === "number" &&
    typeof rs.processedInBatch === "number" &&
    rs.processedInBatch < Math.min(100, Math.max(10, Number($("batchSize")?.value) || 10));
  // 中途停下且本批未满才显示续跑；本批已完成则用「接着筛选」
  const unfinished = can && rs.target != null && rs.nextIndex < (rs.target || Infinity);
  btn.disabled = !unfinished;
  btn.title = unfinished
    ? `中断续跑：列表第 ${rs.nextIndex + 1} 条（本批已 ${rs.processedInBatch} 条）`
    : "无中断断点（本批完成后请点「接着筛选」）";
}

async function loadUI() {
  const profile = await getProfile();
  const settings = await getSettings();

  $("resumeText").value = profile.resumeText || "";
  $("yearsExperience").value =
    profile.yearsExperience != null && profile.yearsExperience !== ""
      ? String(profile.yearsExperience)
      : "";
  $("skills").value = joinTags(profile.skills);
  $("industries").value = joinTags(profile.industries);
  $("directions").value = joinTags(profile.directions);
  $("certificates").value = joinTags(profile.certificates);
  $("languages").value = joinTags(profile.languages);
  $("avoidCustom").value = joinTags(profile.avoidCustom);
  $("attentionCustom").value = joinTags(profile.attentionCustom);
  renderTagBoxes(profile);
  fillWeightsUI(settings.weights);

  renderLlmSettings(settings);
  $("exportMode").value = settings.exportMode || "simple";
  if ($("exportFormat")) $("exportFormat").value = settings.exportFormat || "md";
  $("deepseekThreshold").value = settings.deepseekThreshold ?? 60;
  $("favoriteThreshold").value = settings.favoriteThreshold ?? 80;
  $("applyListThreshold").value = applyListThresholdOf(settings);

  const sel = $("batchSize");
  sel.innerHTML = "";
  for (let n = 10; n <= 100; n += 10) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = String(n);
    if (n === (settings.batchSize || 10)) opt.selected = true;
    sel.appendChild(opt);
  }

  updateDeepseekStats();
  await refreshPlatformLabel();
  await refreshContinueButton();
  await refreshStartButton();
  await renderApplyList();
}

function collectProfileFromUI() {
  const years = readYearsExperience();
  return {
    resumeText: $("resumeText").value.trim(),
    yearsExperience: years.ok ? years.value : null,
    skills: splitTags($("skills").value),
    industries: splitTags($("industries").value),
    directions: splitTags($("directions").value),
    certificates: splitTags($("certificates").value),
    languages: splitTags($("languages").value),
    avoidSelected: readTagBox("avoidBox"),
    avoidCustom: splitTags($("avoidCustom").value),
    attentionSelected: readTagBox("attentionBox"),
    attentionCustom: splitTags($("attentionCustom").value)
  };
}

function collectSettingsFromUI(base) {
  const fav = Number($("favoriteThreshold").value) || 0;
  let applyTh = Number($("applyListThreshold").value);
  if (!Number.isFinite(applyTh)) applyTh = fav;
  const llmProvider =
    document.querySelector("input[name=llmProvider]:checked")?.value || base.llmProvider || "deepseek";
  const apiKeys = { ...(base.apiKeys || {}) };
  for (const p of LLM_PROVIDERS) {
    const el = $(`apiKey_${p.id}`);
    const fromUi = el?.value?.trim() || "";
    apiKeys[p.id] = fromUi || apiKeys[p.id] || "";
  }
  return {
    ...base,
    llmProvider,
    apiKeys,
    deepseekApiKey: apiKeys.deepseek || "",
    directionStrict: false,
    exportMode: $("exportMode").value,
    exportFormat: $("exportFormat")?.value || "md",
    deepseekThreshold: Number($("deepseekThreshold").value) || 0,
    favoriteThreshold: fav,
    applyListThreshold: applyTh,
    batchSize: Number($("batchSize").value) || 10,
    // 权重仅经「确认权重」写入；此处沿用已生效值，避免未确认草稿覆盖
    weights: { ...DEFAULT_WEIGHTS, ...(base.weights || {}) }
  };
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(s, n = 18) {
  const t = String(s || "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function recClass(rec) {
  if (rec === REC.SUGGEST) return "tag-suggest";
  if (rec === REC.EXCLUDE) return "tag-exclude";
  return "tag-caution";
}

function groupClass(rec) {
  if (rec === REC.SUGGEST) return "suggest";
  if (rec === REC.EXCLUDE) return "exclude";
  return "caution";
}

function renderResults() {
  const root = $("resultList");
  // 全局按匹配度降序后分组：建议投递 → 谨慎投递 → 已排除；组内再按匹配度
  const enriched = sortResults(state.results).map(enrichResult);
  $("resultCount").textContent = String(enriched.length);
  const buckets = groupResultsByRecommendation(enriched);
  const parts = [];
  for (const title of [REC.SUGGEST, REC.CAUTION, REC.EXCLUDE]) {
    const list = (buckets[title] || []).slice().sort(
      (a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0)
    );
    if (!list.length) continue;
    parts.push(
      `<div class="result-group-title ${groupClass(title)}">${escapeHtml(title)}（${list.length}）</div>`
    );
    parts.push(
      `<ul class="result-list" style="max-height:none">` +
        list
          .map((r) => {
            const rec = r.recommendation;
            const company = r.job?.company ? ` · ${escapeHtml(truncate(r.job.company, 12))}` : "";
            const gaps = r.score?.hardGaps?.length
              ? ` · 缺口:${escapeHtml(r.score.hardGaps[0])}`
              : "";
            const attn = r.score?.attentionHits?.length
              ? ` · 注意:${escapeHtml(r.score.attentionHits.join("/"))}`
              : "";
            const dur =
              r.durationMs != null ? ` · ${escapeHtml(formatDuration(r.durationMs))}` : "";
            return `<li>
        <div><strong>${escapeHtml(truncate(r.job?.title || "", 22))}</strong>${company}</div>
        <div>匹配度 ${r.score?.total ?? 0}%
        · <span class="result-rec ${recClass(rec)}">${escapeHtml(rec)}</span>${dur}</div>
        <div>${r.job?.url ? `<a href="${escapeHtml(r.job.url)}" target="_blank" rel="noreferrer">打开</a>` : ""}
        ${gaps}${attn}</div>
      </li>`;
          })
          .join("") +
        `</ul>`
    );
  }
  root.innerHTML = parts.join("");
  updateDeepseekStats();
}

/** 暂停时弹框提醒（切页/验证码/手动暂停），避免只看日志漏掉 */
function notifyPaused(reason, { autoResumeHint = true } = {}) {
  const dlg = $("pauseDialog");
  const body = $("pauseDialogBody");
  const msg =
    reason ||
    "精筛已暂停。请回到招聘列表页后点击「继续运行」。";
  if (body) {
    body.textContent =
      msg + (autoResumeHint ? "\n\n处理完验证码或切回列表后，点下方按钮继续。" : "");
  }
  setPill("已暂停", "pause");
  $("btnResume").disabled = false;
  toast("已暂停 — 请查看弹窗", "error", 5000);
  try {
    if (dlg && typeof dlg.showModal === "function" && !dlg.open) dlg.showModal();
  } catch {
    /* ignore */
  }
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("career-lens 已暂停", { body: msg.slice(0, 120) });
    } else if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

function dismissPauseDialog() {
  const dlg = $("pauseDialog");
  try {
    if (dlg?.open) dlg.close();
  } catch {
    /* ignore */
  }
}

function jobApplyId(job) {
  return job.jobId || job.url || `${job.company || ""}|${job.title || ""}|${Date.now()}`;
}

async function maybeAddToApplyList(result, settings) {
  const r = enrichResult(result);
  if (r.score?.excluded) return;
  const th = applyListThresholdOf(settings);
  if ((r.score?.total ?? 0) < th) return;
  const platform =
    r.platform ||
    (r.source === "manual" ? "manual" : null) ||
    detectPlatformFromUrl(r.job?.url || "")?.id ||
    "boss";
  await upsertApplyListItem(
    {
      id: jobApplyId(r.job || {}),
      title: r.job?.title || "",
      company: r.job?.company || "",
      url: r.job?.url || "",
      total: r.score?.total ?? 0,
      recommendation: r.recommendation,
      analysis: r.analysis || "",
      hardGaps: r.score?.hardGaps || [],
      attentionHits: r.score?.attentionHits || [],
      durationMs: r.durationMs,
      excluded: !!r.score?.excluded,
      applyStatus: "未打开",
      source: r.source || "batch",
      platform
    },
    th
  );
}

async function checkpoint() {
  await saveRunState({
    version: 1,
    nextIndex: state.nextIndex,
    target: state.target,
    results: state.results,
    order: state.order,
    processedInBatch: state.processedInBatch,
    sinceRest: state.sinceRest,
    deepseekCalls: state.deepseekCalls,
    listFingerprint: state.listFingerprint,
    seenKeys: [...state.seenKeys],
    savedAt: Date.now()
  });
  await saveListSession({
    listCursor: state.nextIndex,
    seenKeys: [...state.seenKeys],
    fingerprint: state.listFingerprint,
    results: state.results,
    order: state.order,
    deepseekCalls: state.deepseekCalls
  });
  await refreshContinueButton();
  await refreshStartButton();
}

async function ensureListCount(need, have) {
  let count = have;
  let guard = 0;
  while (count < need && guard < 12) {
    await waitWhilePaused();
    if (state.stopFlag) break;
    const blocker = await sendToBoss({ type: "CL_BLOCKER" });
    if (blocker.blocked) throw new Error(blocker.reason || "安全校验");
    const vis = await sendToBoss({ type: "CL_VISIBILITY" });
    if (!vis.visible) {
      state.paused = true;
      log("页面不可见，已暂停。回到列表页后点「继续」");
      notifyPaused("检测到招聘页不可见（可能切走了标签页），精筛已暂停。");
      await waitWhilePaused();
      dismissPauseDialog();
    }
    log(`列表不足，缓慢下拉补齐（当前 ${count}，目标 ${need}）…`);
    const scrolled = await sendToBoss({ type: "CL_SCROLL" });
    const list = await sendToBoss({ type: "CL_LIST" });
    count = list.count || 0;
    if (!scrolled.grew && guard > 2) break;
    guard += 1;
    await sleep(randomBetween(800, 1600));
  }
  return count;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

async function runHealthCheck() {
  log("运行前检查 DOM / 页面…");
  const health = await sendToBoss({ type: "CL_HEALTH" });
  for (const c of health.checks || []) {
    log(`  ${c.ok ? "✓" : "✗"} ${c.name}：${c.detail || ""}`);
  }
  if (health.blocked) throw new Error(health.reason || "检测到验证码，请先完成验证");
  if (!health.ok) throw new Error("页面检查未通过，请确认在 Boss 职位列表页且可见");
  log(`检查通过，列表约 ${health.count || 0} 条`);
  return health;
}

async function processOneJob(index, profile, settings, platformId = "boss") {
  const t0 = Date.now();
  await waitWhilePaused();
  if (state.stopFlag) return null;

  const blocker = await sendToPlatform({ type: "CL_BLOCKER" });
  if (blocker.blocked) throw new Error(blocker.reason || "检测到验证，请处理后点继续");

  const vis = await sendToPlatform({ type: "CL_VISIBILITY" });
  if (!vis.visible) {
    state.paused = true;
    log("页面不可见，已暂停");
    notifyPaused("检测到招聘页不可见（可能切走了标签页），精筛已暂停。");
    await waitWhilePaused();
    dismissPauseDialog();
    if (state.stopFlag) return null;
  }

  const list = await sendToPlatform({ type: "CL_LIST" });
  const card = list.items?.[index];
  if (!card) throw new Error(`无法读取列表第 ${index + 1} 条`);

  log(`#${index + 1} 打开详情：${card.title}`);
  const opened = await sendToPlatform({ type: "CL_OPEN_INDEX", index });
  if (!opened.ok && !opened.detail) throw new Error(opened.reason || "打开详情失败");

  await sleep(Math.max(settings.minDetailWaitMs || 3000, 1000));
  const scraped = await sendToPlatform({ type: "CL_SCRAPE_DETAIL" });
  const d = { ...(opened.detail || {}), ...(scraped.detail || {}) };
  const job = normalizeJobRecord(
    {
      ...d,
      company: d.company || card.company,
      url: (d.url && !/\/web\/geek\/jobs/.test(d.url) ? d.url : null) || card.url || d.url,
      jobId: d.jobId || card.jobId,
      salary: d.salary || card.salary,
      keywords: d.keywords?.length ? d.keywords : [],
      description: d.description || card.listText || "",
      listTitle: d.listTitle || card.title
    },
    card
  );

  const score = scoreJob(job, profile, settings);
  log(
    `#${index + 1} 规则分 ${score.total}%` +
      (score.excluded ? `｜避雷:${score.avoidHits.join("/")}` : "") +
      (score.hardGaps?.length ? `｜缺口:${score.hardGaps.join("/")}` : "") +
      (score.attentionHits.length ? `｜注意:${score.attentionHits.join("/")}` : "")
  );

  let analysis = "";
  let skippedDeepseek = "";
  let favorited = false;
  let llmLabel = "";
  const { provider, apiKey } = resolveLlmConfig(settings);

  if (score.excluded) {
    skippedDeepseek = `避雷命中：${score.avoidHits.join("、")}`;
    await sleep(randomBetween(2000, 5000));
  } else if (score.total < (settings.deepseekThreshold ?? 60)) {
    skippedDeepseek = `低于分析阈值 ${settings.deepseekThreshold}`;
    await sleep(randomBetween(2000, 5000));
  } else if (!apiKey) {
    skippedDeepseek = `未配置 ${provider.label} API Key`;
    await sleep(randomBetween(2000, 5000));
  } else {
    try {
      log(`#${index + 1} 调用 ${provider.label} 分析…`);
      const out = await analyzeJobWithLlm({ settings, profile, job, score });
      analysis = compactAnalysis(out.text);
      llmLabel = out.providerLabel;
      if (!analysis) {
        skippedDeepseek = `${provider.label} 返回空内容`;
        log(`#${index + 1} ${skippedDeepseek}`);
      } else {
        state.deepseekCalls += 1;
        updateDeepseekStats();
        log(`#${index + 1} ${provider.label} 分析完成`);
      }
    } catch (e) {
      skippedDeepseek = `${provider.label} 失败：${e.message || e}`;
      log(skippedDeepseek);
    }
    await sleep(randomBetween(3000, 10000));
  }

  if (!score.excluded && score.total >= (settings.favoriteThreshold ?? 80)) {
    try {
      const fav = await sendToPlatform({ type: "CL_FAVORITE" });
      favorited = !!fav.favorited;
      if (fav.skipped) log(`#${index + 1} 已收藏，跳过`);
      else if (fav.ok) log(`#${index + 1} 已自动收藏`);
      else if (fav.reason) log(`#${index + 1} 收藏：${fav.reason}`);
    } catch (e) {
      log(`#${index + 1} 收藏异常：${e.message || e}`);
    }
  }

  const durationMs = Date.now() - t0;
  const result = enrichResult({
    order: ++state.order,
    job,
    score,
    analysis,
    skippedDeepseek,
    favorited,
    llmLabel,
    durationMs,
    platform: platformId,
    source: "batch"
  });
  log(`#${index + 1} 建议：${result.recommendation} · 耗时 ${formatDuration(durationMs)}`);
  await maybeAddToApplyList(result, settings);
  return result;
}

async function finishBatch(settings, reason) {
  log(reason);
  const est = estimateDeepseekCost(state.deepseekCalls);
  log(`本批模型调用 ${est.calls} 次，费用预估约 ¥${est.yuanText}`);
  log(`列表游标已停在第 ${state.nextIndex + 1} 条，未改筛时可再点「接着筛选」`);
  setPill("空闲");
  // 只清中途断点，保留列表游标，方便下一批接着跑
  await clearRunState();
  await saveListSession({
    listCursor: state.nextIndex,
    seenKeys: [...state.seenKeys],
    fingerprint: state.listFingerprint,
    results: state.results,
    order: state.order,
    deepseekCalls: state.deepseekCalls
  });
  await refreshContinueButton();
  await refreshStartButton();
  await renderApplyList();
  if (!state.results.length) {
    toast(reason || "本批无结果", "info");
    return;
  }
  await exportResultsWithTip(state.results, settings.exportMode, settings.exportFormat);
}

async function runBatch({ resume = false } = {}) {
  const years = readYearsExperience();
  if (!years.ok) {
    toast(years.error, "error");
    return;
  }
  const profile = collectProfileFromUI();
  let settings = collectSettingsFromUI(await getSettings());
  await saveProfile(profile);
  await saveSettings(settings);

  state.running = true;
  state.paused = false;
  state.stopFlag = false;

  const batchSize = Math.min(100, Math.max(10, settings.batchSize || 10));

  if (resume) {
    const rs = await getRunState();
    if (!rs) {
      toast("没有可续跑的断点", "error");
      state.running = false;
      return;
    }
    state.results = rs.results || [];
    state.order = rs.order || state.results.length;
    state.processedInBatch = rs.processedInBatch || 0;
    state.sinceRest = rs.sinceRest || 0;
    state.deepseekCalls = rs.deepseekCalls || 0;
    state.nextIndex = rs.nextIndex || 0;
    state.target = rs.target || state.nextIndex + batchSize;
    state.listFingerprint = rs.listFingerprint || "";
    state.seenKeys = new Set(rs.seenKeys || []);
    log(`续跑：从列表第 ${state.nextIndex + 1} 条继续（本批目标至第 ${state.target} 条）`);
  } else {
    await clearRunState();
    state.processedInBatch = 0;
    state.sinceRest = 0;

    // 先探测列表指纹，决定接着跑还是重头
    try {
      await sendToPlatform({ type: "CL_PING" });
      const peek = await sendToPlatform({ type: "CL_LIST" });
      const fp = listFingerprintOf(peek.items || []);
      const sess = await getListSession();
      if (sess.fingerprint && fp && sess.fingerprint !== fp) {
        log("检测到列表/筛选已变化，从第 1 条重新开始");
        toast("列表已变化，从头筛选", "info");
        await clearListSession();
        state.nextIndex = 0;
        state.seenKeys = new Set();
        state.listFingerprint = fp;
        state.results = [];
        state.order = 0;
        state.deepseekCalls = 0;
      } else {
        state.nextIndex = sess.listCursor || 0;
        state.seenKeys = new Set(sess.seenKeys || []);
        state.listFingerprint = fp || sess.fingerprint || "";
        // 接着跑时保留历史结果展示；也可只显示本批——保留累积更符合「接着」
        state.results = sess.results || [];
        state.order = sess.order || state.results.length;
        state.deepseekCalls = sess.deepseekCalls || 0;
        if (state.nextIndex > 0) {
          log(`接着筛选：从列表第 ${state.nextIndex + 1} 条起再跑 ${batchSize} 条（跳过已分析）`);
        } else {
          log(`开始精筛：从列表第 1 条起跑 ${batchSize} 条`);
        }
      }
    } catch (e) {
      // 探测失败时仍进入主流程的健康检查
      state.nextIndex = 0;
      state.seenKeys = new Set();
      state.listFingerprint = "";
      state.results = [];
      state.order = 0;
      state.deepseekCalls = 0;
      log(`列表探测：${e.message || e}，将从第 1 条尝试`);
    }
    state.target = state.nextIndex + batchSize;
  }

  renderResults();
  updateDeepseekStats();
  setPill("运行中", "busy");
  $("btnStart").disabled = true;
  $("btnContinue").disabled = true;
  $("btnResetList").disabled = true;
  $("btnPause").disabled = false;
  $("btnResume").disabled = true;
  $("btnStop").disabled = false;

  const batchGoal = batchSize;
  $("progress").textContent = `本批 ${batchGoal} 条 · 列表从第 ${state.nextIndex + 1} 条`;

  try {
    const { platform } = await getPlatformTab();
    const platformId = platform?.id || "boss";
    await sendToPlatform({ type: "CL_PING" });
    await runHealthCheck();

    let list = await sendToPlatform({ type: "CL_LIST" });
    if (!list.count) throw new Error("未识别到职位列表，请打开 Boss / 猎聘 / 智联 搜索列表页");

    const fp = listFingerprintOf(list.items || []);
    if (!state.listFingerprint) state.listFingerprint = fp;
    else if (fp && state.listFingerprint && fp !== state.listFingerprint && !resume) {
      log("运行中发现列表指纹变化，已重置游标");
      state.nextIndex = 0;
      state.seenKeys = new Set();
      state.listFingerprint = fp;
      state.target = batchSize;
    }

    await ensureListCount(Math.min(state.target, list.count + 5), list.count);
    list = await sendToPlatform({ type: "CL_LIST" });

    let i = state.nextIndex;
    while (state.processedInBatch < batchGoal) {
      if (state.stopFlag) break;
      await waitWhilePaused();
      if (state.stopFlag) break;

      list = await sendToPlatform({ type: "CL_LIST" });
      if (i >= (list.count || 0)) {
        await ensureListCount(i + 1, list.count || 0);
        list = await sendToPlatform({ type: "CL_LIST" });
        if (i >= (list.count || 0)) {
          log("列表已无更多岗位，提前结束");
          break;
        }
      }

      const card = list.items?.[i];
      const key = jobKeyOf(card);
      if (key && state.seenKeys.has(key)) {
        log(`#${i + 1} 已分析过，跳过：${card?.title || key}`);
        i += 1;
        state.nextIndex = i;
        await checkpoint();
        continue;
      }

      if (batchGoal >= 50 && state.sinceRest >= 30) {
        log("已处理 30 条，强制休息 30 秒…");
        setPill("休息中", "pause");
        for (let s = 30; s > 0; s--) {
          if (state.stopFlag) break;
          $("progress").textContent = `休息中 ${s}s`;
          await sleep(1000);
        }
        state.sinceRest = 0;
        setPill("运行中", "busy");
      }

      try {
        const item = await processOneJob(i, profile, settings, platformId);
        if (item) {
          const k = jobKeyOf(item.job) || key;
          if (k) state.seenKeys.add(k);
          state.results.push(item);
          state.processedInBatch += 1;
          state.sinceRest += 1;
          i += 1;
          state.nextIndex = i;
          state.target = Math.max(state.target, i);
          renderResults();
          await checkpoint();
        } else {
          i += 1;
          state.nextIndex = i;
        }
      } catch (e) {
        const msg = String(e.message || e);
        log(`错误：${msg}`);
        await checkpoint();
        if (/验证|安全校验|验证码/.test(msg)) {
          state.paused = true;
          notifyPaused("检测到验证码/安全校验，精筛已暂停。完成后点「继续运行」，或稍后用「续跑」。");
          await waitWhilePaused();
          dismissPauseDialog();
          continue;
        }
        i += 1;
        state.nextIndex = i;
      }

      $("progress").textContent = `本批已分析 ${state.processedInBatch} / ${batchGoal}（列表第 ${state.nextIndex} 条）`;
    }

    if (state.stopFlag) {
      await checkpoint();
      log("已停止，断点已保存；可用「续跑」或下次「接着筛选」");
      await exportResultsWithTip(state.results, settings.exportMode, settings.exportFormat);
      setPill("空闲");
    } else {
      await finishBatch(settings, "本批完成，导出结果");
    }
  } catch (e) {
    log(`运行失败：${e.message || e}`);
    await checkpoint();
    if (state.results.length) {
      await exportResultsWithTip(state.results, settings.exportMode, settings.exportFormat);
    }
    setPill("空闲");
  } finally {
    state.running = false;
    state.paused = false;
    $("btnStart").disabled = false;
    $("btnResetList").disabled = false;
    $("btnPause").disabled = true;
    $("btnResume").disabled = true;
    $("btnStop").disabled = true;
    await refreshContinueButton();
    await refreshStartButton();
    await renderApplyList();
  }
}

async function manualAnalyze() {
  const years = readYearsExperience();
  if (!years.ok) {
    toast(years.error, "error");
    $("manualOut").textContent = years.error;
    return;
  }
  const title = ($("manualTitle")?.value || "").trim();
  if (!title) {
    toast("请填写岗位名称", "error");
    $("manualOut").textContent = "请填写岗位名称（必填）";
    return;
  }
  const description = $("manualBody").value.trim();
  if (!description) {
    toast("请粘贴岗位正文", "error");
    $("manualOut").textContent = "请粘贴岗位正文";
    return;
  }

  const profile = collectProfileFromUI();
  const settings = collectSettingsFromUI(await getSettings());
  await saveProfile(profile);
  await saveSettings(settings);

  const company = ($("manualCompany")?.value || "").trim();
  const url = ($("manualUrl")?.value || "").trim();
  const raw = {
    title,
    salary: "",
    url,
    company,
    keywords: [],
    description
  };
  const job = normalizeJobRecord(raw, { title: raw.title });

  const t0 = Date.now();
  const score = scoreJob(job, profile, settings);
  let analysis = "";
  let skipped = "";
  let llmLabel = "";
  const { provider, apiKey } = resolveLlmConfig(settings);
  if (score.excluded) skipped = `避雷：${score.avoidHits.join("、")}`;
  else if (score.total < settings.deepseekThreshold) skipped = `低于阈值 ${settings.deepseekThreshold}`;
  else if (!apiKey) skipped = `未配置 ${provider.label} API Key`;
  else {
    try {
      const out = await analyzeJobWithLlm({ settings, profile, job, score });
      analysis = compactAnalysis(out.text);
      llmLabel = out.providerLabel;
      if (!analysis) skipped = `${provider.label} 返回空内容`;
      else {
        state.deepseekCalls += 1;
        updateDeepseekStats();
      }
    } catch (e) {
      skipped = e.message || String(e);
    }
  }

  const durationMs = Date.now() - t0;
  const result = enrichResult({
    order: ++state.order,
    job,
    score,
    analysis,
    skippedDeepseek: skipped,
    favorited: false,
    llmLabel,
    durationMs,
    source: "manual",
    platform: "manual"
  });
  state.results.push(result);
  renderResults();
  await maybeAddToApplyList(result, settings);
  await renderApplyList();

  $("manualOut").textContent = [
    `岗位：${title}${company ? ` · ${company}` : ""}`,
    `建议：${result.recommendation}`,
    `匹配度：${score.total}%`,
    `生成时长：${formatDuration(durationMs)}`,
    score.excluded ? `已排除：${score.avoidHits.join("、")}` : "未排除",
    score.hardGaps?.length ? `硬门槛缺口：${score.hardGaps.join("；")}` : "",
    score.attentionHits?.length ? `注意：${score.attentionHits.join("、")}` : "",
    `分项：技能${score.dimensions.skill.score} 行业${score.dimensions.industry.score} 方向${score.dimensions.direction.score} 证书${score.dimensions.certificate.score} 语言${score.dimensions.language.score}`,
    skipped ? `模型：${skipped}` : llmLabel ? `模型：${llmLabel}` : "",
    analysis || ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function renderApplyList() {
  applyUi.list = await getApplyList();
  const total = applyUi.list.length;
  const pages = Math.max(1, Math.ceil(total / APPLY_LIST_PAGE_SIZE) || 1);
  if (applyUi.page >= pages) applyUi.page = pages - 1;
  const start = applyUi.page * APPLY_LIST_PAGE_SIZE;
  const pageItems = applyUi.list.slice(start, start + APPLY_LIST_PAGE_SIZE);

  $("applyMeta").textContent = `共 ${total} 条（最多 100）`;
  $("applyPageInfo").textContent = `${applyUi.page + 1} / ${pages}`;
  $("btnApplyPrev").disabled = applyUi.page <= 0;
  $("btnApplyNext").disabled = applyUi.page >= pages - 1;
  $("applySelectAll").checked = false;

  $("applyBody").innerHTML = pageItems
    .map((row) => {
      const title = escapeHtml(truncate(row.title, 6));
      const company = escapeHtml(truncate(row.company || "-", 8));
      const source = escapeHtml(sourceLabel(row));
      return `<tr data-id="${escapeHtml(row.id)}">
        <td class="col-check"><input type="checkbox" class="apply-check" value="${escapeHtml(row.id)}" /></td>
        <td class="col-title"><span class="apply-cell" data-act="open" title="${escapeHtml(row.title || "")}（点击打开链接）">${title}</span></td>
        <td class="col-company"><span class="apply-cell muted" title="${escapeHtml(row.company || "")}">${company}</span></td>
        <td class="col-score"><span class="apply-cell" data-act="analysis" title="点击查看分析结果">${row.total ?? 0}%</span></td>
        <td class="col-source"><span class="apply-cell muted" title="来源">${source}</span></td>
      </tr>`;
    })
    .join("");
}

function selectedApplyIds() {
  return [...document.querySelectorAll("#applyBody .apply-check:checked")].map((el) => el.value);
}

async function openApplyIds(ids) {
  const list = await getApplyList();
  const map = new Map(list.map((x) => [x.id, x]));
  let n = 0;
  for (const id of ids) {
    const row = map.get(id);
    if (!row?.url) continue;
    chrome.tabs.create({ url: row.url, active: n === 0 });
    n += 1;
  }
  if (n) {
    await patchApplyListStatus(ids, "已打开");
    await renderApplyList();
    toast(`已打开 ${n} 个岗位`, "ok");
  } else toast("无有效链接可打开", "error");
}

function showAnalysis(row) {
  $("analysisDialogTitle").textContent = `${row.title || "岗位"} · ${row.total ?? 0}%`;
  $("analysisDialogBody").textContent = [
    `建议：${row.recommendation || "-"}`,
    row.hardGaps?.length ? `硬门槛缺口：${row.hardGaps.join("；")}` : "",
    row.attentionHits?.length ? `注意：${row.attentionHits.join("、")}` : "",
    "",
    row.analysis || "暂无 DeepSeek 分析"
  ]
    .filter((x, i, a) => x || a[i - 1])
    .join("\n");
  $("analysisDialog").showModal();
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $(`tab-${btn.dataset.tab}`).classList.add("active");
      if (btn.dataset.tab === "apply") renderApplyList();
    });
  });
}

function bindEvents() {
  $("btnSaveProfile").addEventListener("click", async () => {
    try {
      const years = readYearsExperience();
      if (!years.ok) {
        toast(years.error, "error");
        return;
      }
      await saveProfile(collectProfileFromUI());
      // 权重不经此按钮写入，仅保存其它运行相关设置
      const settings = collectSettingsFromUI(await getSettings());
      await saveSettings(settings);
      log("画像已保存（权重请用「确认权重」单独生效）");
      setPill("已保存画像");
      toast("画像保存成功", "ok");
    } catch (e) {
      const msg = e?.message || String(e);
      log(`画像保存失败：${msg}`);
      toast(`画像保存失败：${msg}`, "error");
    }
  });

  $("btnConfirmWeights")?.addEventListener("click", async () => {
    try {
      const draft = readWeightsFromUI();
      const sum = weightSum(draft);
      updateWeightSumHint();
      if (sum !== 100) {
        const saved = await getSettings();
        fillWeightsUI(saved.weights);
        toast(`权重合计须为 100（当前 ${sum}），未生效，已恢复上次确认值`, "error", 4000);
        return;
      }
      const settings = await getSettings();
      await saveSettings({ ...settings, weights: draft });
      fillWeightsUI(draft);
      log("五维权重已确认生效");
      toast("权重已生效（合计 100）", "ok");
    } catch (e) {
      toast(`权重确认失败：${e.message || e}`, "error");
    }
  });
  document.querySelectorAll(".weight-input").forEach((el) => {
    el.addEventListener("input", updateWeightSumHint);
  });

  $("btnSaveSettings").addEventListener("click", async () => {
    try {
      const settings = collectSettingsFromUI(await getSettings());
      await saveSettings(settings);
      log("模型设置已保存");
      setPill("已保存模型设置");
      toast("模型设置保存成功", "ok");
    } catch (e) {
      const msg = e?.message || String(e);
      log(`模型设置保存失败：${msg}`);
      toast(`模型设置保存失败：${msg}`, "error");
    }
  });

  $("resumeFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      toast(`正在解析：${file.name}`, "info");
      const text = await parseResumeFile(file);
      $("resumeText").value = text;
      const sug = suggestProfileFromText(text);
      if (sug.yearsExperience > 0 && !$("yearsExperience").value) {
        $("yearsExperience").value = String(sug.yearsExperience);
      }
      log(`已解析简历文件：${file.name}${sug.yearsExperience ? `，识别年限约 ${sug.yearsExperience} 年` : ""}`);
      toast(`简历解析成功（${text.length} 字），可再点「提取标签」`, "ok", 3500);
    } catch (err) {
      log(`简历解析失败：${err.message || err}`);
      toast(`简历解析失败：${err.message || err}`, "error", 4000);
    }
  });

  $("btnSuggest").addEventListener("click", () => {
    const sug = suggestProfileFromText($("resumeText").value || "");
    const merge = (id, arr) => {
      const cur = splitTags($(id).value);
      $(id).value = joinTags([...new Set([...cur, ...arr])]);
    };
    merge("skills", sug.skills);
    merge("industries", sug.industries);
    merge("directions", sug.directions);
    merge("certificates", sug.certificates);
    merge("languages", sug.languages);
    if (sug.yearsExperience > 0) {
      $("yearsExperience").value = String(sug.yearsExperience);
      log(`已从文本提取标签与工作年限约 ${sug.yearsExperience} 年（请核对后保存）`);
    } else {
      log("已从文本提取标签（未识别到明确年限，请手填；保存前请检查）");
    }
  });

  $("btnStart").addEventListener("click", () => runBatch({ resume: false }));
  $("btnContinue").addEventListener("click", () => runBatch({ resume: true }));
  $("btnResetList").addEventListener("click", async () => {
    if (state.running) return;
    await clearListSession();
    await clearRunState();
    state.results = [];
    state.nextIndex = 0;
    state.seenKeys = new Set();
    state.listFingerprint = "";
    state.order = 0;
    state.deepseekCalls = 0;
    renderResults();
    updateDeepseekStats();
    await refreshContinueButton();
    await refreshStartButton();
    log("已重置列表游标，下次将从第 1 条开始");
    toast("已从头开始", "ok");
  });
  $("btnPause").addEventListener("click", async () => {
    state.paused = true;
    await checkpoint();
    notifyPaused("已手动暂停（断点已保存）。需要时点「继续运行」。");
  });
  const resumeRun = () => {
    state.paused = false;
    setPill("运行中", "busy");
    $("btnResume").disabled = true;
    const dlg = $("pauseDialog");
    if (dlg?.open) dlg.close();
    log("继续运行");
  };
  $("btnResume").addEventListener("click", resumeRun);
  $("btnPauseDialogResume")?.addEventListener("click", resumeRun);
  $("btnPauseDialogOk")?.addEventListener("click", () => {
    $("pauseDialog")?.close();
  });
  $("btnStop").addEventListener("click", () => {
    state.stopFlag = true;
    state.paused = false;
    $("pauseDialog")?.close();
    log("正在停止…");
  });
  $("btnExport").addEventListener("click", async () => {
    const settings = await getSettings();
    await exportResultsWithTip(
      state.results,
      $("exportMode").value || settings.exportMode,
      $("exportFormat")?.value || settings.exportFormat || "md"
    );
  });
  $("btnClearLog").addEventListener("click", () => {
    $("log").textContent = "";
  });
  $("btnManualAnalyze").addEventListener("click", () => manualAnalyze());

  $("btnApplyRefresh").addEventListener("click", () => renderApplyList());
  $("btnApplySaveTh")?.addEventListener("click", async () => {
    try {
      const settings = collectSettingsFromUI(await getSettings());
      await saveSettings(settings);
      toast("投递列表阈值已保存", "ok");
    } catch (e) {
      toast(`保存失败：${e.message || e}`, "error");
    }
  });
  $("btnApplyPrev").addEventListener("click", () => {
    applyUi.page -= 1;
    renderApplyList();
  });
  $("btnApplyNext").addEventListener("click", () => {
    applyUi.page += 1;
    renderApplyList();
  });
  $("applySelectAll").addEventListener("change", (e) => {
    document.querySelectorAll("#applyBody .apply-check").forEach((c) => {
      c.checked = e.target.checked;
    });
  });
  $("btnApplyOpen").addEventListener("click", async () => {
    const ids = selectedApplyIds();
    if (!ids.length) {
      toast("请先勾选岗位", "info");
      return;
    }
    await openApplyIds(ids);
  });
  $("btnApplyDelete").addEventListener("click", async () => {
    const ids = selectedApplyIds();
    if (!ids.length) {
      toast("请先勾选岗位", "info");
      return;
    }
    await removeApplyListIds(ids);
    await renderApplyList();
    toast(`已删除 ${ids.length} 条`, "ok");
  });
  $("applyBody").addEventListener("click", async (e) => {
    const cell = e.target.closest("[data-act]");
    if (!cell) return;
    const tr = cell.closest("tr");
    const id = tr?.dataset?.id;
    if (!id) return;
    const row = applyUi.list.find((x) => x.id === id);
    if (!row) return;
    if (cell.dataset.act === "analysis") showAnalysis(row);
    else if (cell.dataset.act === "open") await openApplyIds([id]);
  });
}

bindTabs();
bindEvents();
loadUI().then(() => {
  log("career-lens 已就绪。打开 Boss / 猎聘 / 智联 列表后开始精筛。");
  refreshPlatformLabel();
});
setInterval(() => {
  if (!state.running) refreshPlatformLabel();
}, 3000);
