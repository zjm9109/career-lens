/**
 * 侧边栏主控：画像 / 设置 / 精筛 / 投递列表
 */
import {
  DEFAULT_AVOID_TAGS,
  DEFAULT_WEIGHTS,
  DEFAULT_PILLAR_WEIGHTS,
  APPLY_LIST_PAGE_SIZE,
  DAILY_RISK_LOCK_COUNT,
  DAILY_LIEPIN_DETAIL_OPEN_MAX,
  normalizeWeights
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
  patchApplyListStatus,
  isUsageNoticeAccepted,
  acceptUsageNotice,
  checkDailySafetyGate,
  recordRiskEvent,
  recordDetailOpen,
  getSafetyState
} from "../common/storage.js";
import { scoreJob, mergeSemanticIntoScore } from "../common/scoring.js";
import {
  matchTitleDomainSkip,
  buildTitleDomainExcludeScore
} from "../common/title-domain-skip.js";
import { scoreSemanticPillars } from "../common/semantic-score.js";
import { analyzeJobWithLlm, LLM_PROVIDERS, resolveLlmConfig } from "../common/llm.js";
import { PILLAR_LABELS } from "../common/pillars.js";
import {
  downloadResults,
  downloadApplyListExcel,
  compareApplyListRows,
  sortResults,
  formatDuration
} from "../common/export.js";
import { parseResumeFile, suggestProfileFromText } from "../common/resume-parse.js";
import {
  compactAnalysis,
  isUnusableJobDescription,
  normalizeSalary,
  parseJobSections,
  pickJobTitle
} from "../common/job-sections.js";
import {
  REC,
  REC_ORDER,
  enrichResult,
  effectiveFitScore,
  estimateDeepseekCost,
  groupResultsByRecommendation
} from "../common/recommend.js";
import { detectPlatformFromUrl, allPlatformUrlPatterns } from "../common/platform.js";
import { getDefaultPack } from "../common/packs/it-delivery-pm.js";
import {
  buildRuleProfileReport,
  buildAiProfileReport,
  formatProfileReportText
} from "../common/profile-report.js";

const $ = (id) => document.getElementById(id);

const state = {
  running: false,
  paused: false,
  /** 系统暂停（切页/验证码/网络）允许自动恢复；手动暂停不自动恢复 */
  autoResumeAllowed: false,
  pauseReason: "",
  stopFlag: false,
  /** 本批结果（侧栏展示 + 自动/手动导出） */
  results: [],
  /** 同一筛选列表上的累计结果（仅会话续跑用，不整包导出） */
  sessionResults: [],
  order: 0,
  profileReport: null,
  processedInBatch: 0,
  sinceRest: 0,
  /** 自上次「每5条轻抖」以来开详情数 */
  sinceJitter5: 0,
  /** 自上次人味操作以来开详情数；阈值每次随机 8–12 */
  sinceHumanize: 0,
  humanizeEvery: 10,
  deepseekCalls: 0,
  /** 本批内的模型调用次数（导出费用按本批计） */
  batchDeepseekCalls: 0,
  nextIndex: 0,
  target: 0,
  /** 当前筛选列表指纹与已处理岗位，用于接着往后筛 */
  listFingerprint: "",
  seenKeys: new Set(),
  /** 当前批次画像，供待复核判定（方向词） */
  profile: null
};

/** 从 Boss/猎聘等链接抽出稳定岗位 id */
function extractJobIdFromUrl(url) {
  const s = String(url || "");
  const boss = s.match(/\/job_detail\/([^./?#]+)/i);
  if (boss) return boss[1];
  const liepin = s.match(/\/job\/(\d+)/i);
  if (liepin) return liepin[1];
  const zl = s.match(/\/jobdetail\/(\d+)/i) || s.match(/[?&]jobNumber=([^&]+)/i);
  if (zl) return zl[1];
  return "";
}

function normalizeJobUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const id = extractJobIdFromUrl(u.href);
    if (id) return `idpath:${id}`;
    return `${u.origin}${u.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return raw.split("?")[0].toLowerCase();
  }
}

/**
 * 同一岗位可能出现：仅有 jobId / 仅有 url / 仅有 公司|标题。
 * 返回多别名，任一命中即视为已分析。
 */
function jobKeysOf(cardOrJob) {
  if (!cardOrJob) return [];
  const keys = new Set();
  const jobId = String(cardOrJob.jobId || extractJobIdFromUrl(cardOrJob.url) || "").trim();
  if (jobId) {
    keys.add(`id:${jobId}`);
    keys.add(jobId);
  }
  const nu = normalizeJobUrl(cardOrJob.url);
  if (nu) keys.add(`url:${nu}`);
  const bareUrl = String(cardOrJob.url || "").split("?")[0].trim();
  if (bareUrl) keys.add(bareUrl);
  const title = String(cardOrJob.title || "")
    .replace(/\s+/g, "")
    .slice(0, 48);
  const company = String(cardOrJob.company || "")
    .replace(/\s+/g, "")
    .slice(0, 32);
  if (title && company) keys.add(`tc:${company}|${title}`);
  return [...keys].filter(Boolean);
}

function jobKeyOf(cardOrJob) {
  return jobKeysOf(cardOrJob)[0] || "";
}

function hasSeenJob(cardOrJob) {
  return jobKeysOf(cardOrJob).some((k) => state.seenKeys.has(k));
}

function markSeenJob(...cards) {
  for (const c of cards) {
    for (const k of jobKeysOf(c)) state.seenKeys.add(k);
  }
}

/** 用历史结果回填 seenKeys，避免只存了一种 key 导致重复分析 */
function seedSeenFromResults(results) {
  for (const r of results || []) markSeenJob(r.job);
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

async function exportResultsWithTip(results, mode, format, { deepseekCalls } = {}) {
  if (!results?.length) {
    toast("暂无本批结果可导出", "error");
    return;
  }
  const fmt = format || $("exportFormat")?.value || "md";
  const calls =
    deepseekCalls != null
      ? deepseekCalls
      : results.filter((r) => r.analysis && !r.skippedDeepseek).length;
  toast(`正在导出本批 ${results.length} 条（${fmt === "docx" ? "Word" : "Markdown"}）…`, "info", 4000);
  try {
    const { filename } = await downloadResults(results, {
      mode,
      format: fmt,
      deepseekCalls: calls
    });
    log(`已下载：${filename}（本批 ${results.length} 条；浏览器默认下载目录）`);
    toast(`下载成功：${filename}（本批 ${results.length} 条）`, "ok", 3500);
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

function withTimeout(promise, ms, label = "操作") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 是否为可自动恢复的瞬时故障（网络/脚本未注入/超时） */
function isTransientPlatformError(msg) {
  return /网络|超时|timeout|Failed to fetch|Receiving end does not exist|Could not establish|连接|ERR_|net::|消息通道|Script|未注入|加载失败|请刷新|不给力|出错了|页面检查未通过|页脚噪声|正文不可用|正文未加载/i.test(
    String(msg || "")
  );
}

/** 猎聘短信/行为异常：列表页仍可读，不能靠「列表探测」自动继续，必须人工验证后点继续 */
function requiresManualResume(reason) {
  return /行为异常|短信验证|safe\.liepin|账号异常|异常访问行为|无法关闭.*详情|详情标签仍存在/i.test(
    String(reason || "")
  );
}

/**
 * 探测招聘页是否已可继续：无风控、列表可读。
 * 可见性：后台标签允许（用户可能在看侧栏）；仅当完全失联/无列表时判未就绪。
 * 注意：猎聘详情风控时列表仍可读，不得据此自动恢复。
 */
async function probePlatformReady() {
  try {
    if (requiresManualResume(state.pauseReason)) {
      return { ok: false, reason: "需完成短信验证并点「继续运行」" };
    }
    await withTimeout(sendToPlatform({ type: "CL_PING" }), 4000, "页面探测");
    const blocker = await withTimeout(sendToPlatform({ type: "CL_BLOCKER" }), 4000, "风控探测");
    if (blocker?.blocked) {
      return { ok: false, reason: blocker.reason || "仍有安全校验" };
    }
    if (requiresManualResume(blocker?.reason)) {
      return { ok: false, reason: blocker.reason };
    }
    const list = await withTimeout(sendToPlatform({ type: "CL_LIST" }), 5000, "列表探测");
    if (!(list?.count > 0 || (list?.items || []).length > 0)) {
      return { ok: false, reason: "列表尚未就绪" };
    }
    return { ok: true, count: list.count || list.items.length };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

/**
 * 等待暂停结束。允许自动恢复时每 ~10s 探测；短信/行为异常须手动继续。
 */
async function waitWhilePaused() {
  const PROBE_EVERY_MS = 10000;
  // 首次探测推迟一轮，避免风控刚报错时列表仍可读导致立刻误恢复
  let lastProbe = Date.now();
  while (state.paused && !state.stopFlag) {
    const now = Date.now();
    const canAuto =
      state.autoResumeAllowed && !requiresManualResume(state.pauseReason);
    if (canAuto && now - lastProbe >= PROBE_EVERY_MS) {
      lastProbe = now;
      const probe = await probePlatformReady();
      if (probe.ok) {
        state.paused = false;
        state.autoResumeAllowed = false;
        state.pauseReason = "";
        setPill("运行中", "busy");
        $("btnResume").disabled = true;
        dismissPauseDialog();
        log(`页面已恢复（列表约 ${probe.count} 条），自动继续精筛`);
        toast("已自动继续", "ok", 2500);
        break;
      }
      const tip = probe.reason ? `（${probe.reason}）` : "";
      log(`等待恢复中，约 10 秒后再检测${tip}`);
      $("progress").textContent = `已暂停，自动检测恢复中…${tip}`;
    } else if (!canAuto && state.paused) {
      $("progress").textContent = requiresManualResume(state.pauseReason)
        ? "已暂停：请完成短信/安全验证后点「继续运行」"
        : "已暂停";
    }
    await sleep(400);
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

async function sendToTab(tabId, message, contentScript) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    if (contentScript) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [contentScript]
      });
      return await chrome.tabs.sendMessage(tabId, message);
    }
    throw new Error("无法连接页面脚本，请刷新招聘页后重试");
  }
}

async function sendToPlatform(message) {
  const { tab, platform } = await getPlatformTab();
  return sendToTab(tab.id, message, platform.contentScript);
}

/** @deprecated 兼容旧名 */
async function sendToBoss(message) {
  return sendToPlatform(message);
}

function waitTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") {
          resolve(tab);
          return;
        }
      } catch (e) {
        reject(e);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("详情页加载超时"));
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

function isLiepinRiskUrl(url = "") {
  return /safe\.liepin\.com|\/intercept\/|verifysms/i.test(url || "");
}

/** 猎聘等：后台打开详情标签，采完由调用方关闭 */
async function openDetailTab(url, platformId = "") {
  const tab = await chrome.tabs.create({ url, active: false });
  await waitTabComplete(tab.id);
  // 猎聘详情较慢且风控敏感：多等一会再采
  await sleep(platformId === "liepin" ? randomBetween(900, 1600) : 400);
  try {
    const t = await chrome.tabs.get(tab.id);
    if (isLiepinRiskUrl(t?.url || "")) {
      const closed = await closeTabSafe(tab.id, { retries: platformId === "liepin" ? 4 : 1 });
      if (platformId === "liepin" && !closed.ok) {
        throw new Error(
          `无法关闭猎聘详情页${closed.reason ? `（${closed.reason}）` : ""}，请手动关闭该标签后点「继续运行」`
        );
      }
      throw new Error("猎聘账号行为异常/短信验证，请先在浏览器完成验证后再继续");
    }
  } catch (e) {
    if (/短信验证|行为异常|安全校验|验证码|无法关闭/.test(String(e.message || e))) throw e;
  }
  return tab.id;
}

async function scrapeDetailFromTab(tabId, contentScript, timeoutMs = 8000, opts = {}) {
  const liepinStrict = !!opts.liepinStrict;
  const limit = liepinStrict ? Math.max(timeoutMs, 14000) : timeoutMs;
  const start = Date.now();
  let last = null;
  while (Date.now() - start < limit) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isLiepinRiskUrl(tab?.url || "")) {
        return {
          blocked: true,
          blockReason: "猎聘账号行为异常/短信验证，请先在浏览器完成验证后再继续",
          url: tab.url,
          description: "",
          rawLength: 0,
          ready: false,
          pageKind: "risk"
        };
      }
      const res = await sendToTab(tabId, { type: "CL_SCRAPE_DETAIL" }, contentScript);
      last = res?.detail || null;
      if (last?.blocked) return last;
      // 猎聘必须等 ready（真正出现职位介绍）；勿用 rawLength≥80 误收顶栏壳
      if (liepinStrict) {
        if (last?.ready) return last;
      } else if (last?.ready || (last?.rawLength || 0) >= 80) {
        return last;
      }
    } catch (e) {
      if (/短信验证|行为异常|安全校验|验证码/.test(String(e.message || e))) throw e;
      /* 脚本可能尚未注入 */
    }
    await sleep(liepinStrict ? 400 : 280);
  }
  if (last) return last;
  const res = await sendToTab(tabId, { type: "CL_SCRAPE_DETAIL" }, contentScript);
  return res?.detail || {};
}

async function closeTabSafe(tabId, { retries = 1 } = {}) {
  if (!tabId) return { ok: true, skipped: true };
  let lastErr = "";
  const attempts = Math.max(1, Number(retries) || 1);
  for (let i = 0; i < attempts; i++) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      lastErr = String(e?.message || e || "tabs.remove 失败");
    }
    await sleep(250 + i * 200);
    try {
      await chrome.tabs.get(tabId);
      // 仍在：继续重试关闭
      lastErr = lastErr || "详情标签仍存在";
    } catch {
      return { ok: true };
    }
  }
  return { ok: false, reason: lastErr || "无法关闭详情标签", tabId };
}

/**
 * 单条结束后补间隔，降低连开详情触发风控的概率。
 * 猎聘：开过详情约 12–20s/条；仅列表跳过用短间隔。
 */
async function paceAfterJob(t0, platformId = "", { light = false } = {}) {
  const elapsed = Date.now() - t0;
  if (platformId === "liepin") {
    const minGap = light ? randomBetween(1500, 3000) : randomBetween(12000, 20000);
    if (elapsed < minGap) await sleep(minGap - elapsed);
    return;
  }
  if (light) {
    await sleep(randomBetween(400, 1200));
    return;
  }
  if (elapsed < 3000) {
    await sleep(randomBetween(2000, 5000));
  }
}

/** 随机人味操作：滚动列表 / 停顿 / 再探列表（不投递、不多开详情） */
async function humanizeBrowse(platformId = "") {
  log(`模拟浏览停顿（${platformId || "平台"}）：轻微滚动/等待…`);
  try {
    await sendToPlatform({ type: "CL_SCROLL" });
    await sleep(randomBetween(800, 2000));
    if (Math.random() < 0.55) {
      await sendToPlatform({ type: "CL_LIST" });
    }
    await sleep(randomBetween(1500, 4500));
    if (Math.random() < 0.35) {
      await sendToPlatform({ type: "CL_PING" });
    }
  } catch (e) {
    log(`模拟浏览略过：${String(e.message || e).slice(0, 80)}`);
  }
}

async function afterDetailOpenPacing(platformId) {
  state.sinceJitter5 += 1;
  state.sinceHumanize += 1;
  // 每 5 次开详情：额外休息 1–3 秒
  if (state.sinceJitter5 >= 5) {
    const extra = randomBetween(1000, 3000);
    log(`已开详情 5 条，额外休息 ${(extra / 1000).toFixed(1)}s…`);
    await sleep(extra);
    state.sinceJitter5 = 0;
  }
  // 每随机 8–12 次：人味操作
  if (state.sinceHumanize >= state.humanizeEvery) {
    await humanizeBrowse(platformId);
    state.sinceHumanize = 0;
    state.humanizeEvery = randomBetween(8, 12);
    log(`下次模拟浏览约在再开 ${state.humanizeEvery} 条详情后`);
  }
}

function buildListOnlyResult({
  card,
  listJob,
  score,
  skippedDeepseek,
  profile,
  platformId,
  t0,
  skipReason = ""
}) {
  const durationMs = Date.now() - t0;
  const result = enrichResult({
    order: ++state.order,
    job: listJob,
    score,
    analysis: "",
    skippedDeepseek,
    llmRequired: false,
    hasLlmKey: false,
    favorited: false,
    llmLabel: "",
    durationMs,
    platform: platformId,
    source: "batch",
    profile,
    listOnly: true,
    skipReason
  });
  return result;
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
    role: Number($("wRole")?.value) || 0,
    domain: Number($("wDomain")?.value) || 0,
    capability: Number($("wCapability")?.value) || 0,
    qualify: Number($("wQualify")?.value) || 0
  };
}

function weightSum(weights) {
  return Object.values(weights).reduce((a, b) => a + (Number(b) || 0), 0);
}

function fillWeightsUI(weights) {
  const w = normalizeWeights(weights || DEFAULT_WEIGHTS);
  if ($("wRole")) $("wRole").value = w.role;
  if ($("wDomain")) $("wDomain").value = w.domain;
  if ($("wCapability")) $("wCapability").value = w.capability;
  if ($("wQualify")) $("wQualify").value = w.qualify;
  updateWeightSumHint();
}

/** 规则分 +（有 Key 时）语义/向量四维；瞬时失败会随 chatCompletion 内重试 */
async function scoreJobFull(job, profile, settings) {
  let score = scoreJob(job, profile, settings);
  if (settings.semanticFit === false) return score;
  const { apiKey, provider } = resolveLlmConfig(settings);
  if (!apiKey) return score;
  try {
    const sem = await scoreSemanticPillars({ settings, profile, job });
    if (sem) {
      score = mergeSemanticIntoScore(score, sem, settings);
      log(
        `语义契合（${sem.mode}/${provider.label}）：角色${score.pillars?.role?.score} 领域${score.pillars?.domain?.score} 能力${score.pillars?.capability?.score} 资质${score.pillars?.qualify?.score}`
      );
    } else {
      score = {
        ...score,
        semanticDegraded: true,
        semanticError: "语义接口无结果，已沿用规则四维"
      };
      log(`语义契合无结果，沿用规则四维（高分将进待复核，不直接建议投递）`);
    }
  } catch (e) {
    score = {
      ...score,
      semanticDegraded: true,
      semanticError: String(e.message || e)
    };
    log(`语义契合失败，沿用规则四维：${e.message || e}`);
  }
  return score;
}

function formatPillarLine(score) {
  const p = score?.pillars;
  if (!p) {
    const d = score?.dimensions || {};
    return `分项：技能${d.skill?.score ?? "-"} 行业${d.industry?.score ?? "-"} 方向${d.direction?.score ?? "-"} 证书${d.certificate?.score ?? "-"} 语言${d.language?.score ?? "-"}`;
  }
  return `四维：${PILLAR_LABELS.role}${p.role?.score ?? "-"} ${PILLAR_LABELS.domain}${p.domain?.score ?? "-"} ${PILLAR_LABELS.capability}${p.capability?.score ?? "-"} ${PILLAR_LABELS.qualify}${p.qualify?.score ?? "-"}${score.scoreMode && score.scoreMode !== "rule" ? ` ·${score.scoreMode}` : ""}`;
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
    rs.processedInBatch < Math.min(100, Math.max(1, Number($("batchSize")?.value) || 5));
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
  renderPackRoles();
  if (profile.profileReport) renderProfileReport(profile.profileReport);
  else refreshRuleReportFromUI();

  renderLlmSettings(settings);
  $("exportMode").value = settings.exportMode || "simple";
  if ($("exportFormat")) $("exportFormat").value = settings.exportFormat || "md";
  $("deepseekThreshold").value = settings.deepseekThreshold ?? 60;
  $("favoriteThreshold").value = settings.favoriteThreshold ?? 80;
  $("applyListThreshold").value = applyListThresholdOf(settings);

  const sel = $("batchSize");
  sel.innerHTML = "";
  const batchOpts = [5, 8, 10, 15, 20, 30, 50, 80, 100];
  const curBatch = Number(settings.batchSize) || 5;
  for (const n of batchOpts) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = String(n);
    if (n === curBatch) opt.selected = true;
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
  const pack = getDefaultPack();
  let profileReport = state.profileReport || null;
  if (!profileReport) {
    profileReport = buildRuleProfileReport(
      {
        resumeText: $("resumeText").value.trim(),
        yearsExperience: years.ok ? years.value : 0,
        skills: splitTags($("skills").value),
        industries: splitTags($("industries").value),
        directions: splitTags($("directions").value),
        certificates: splitTags($("certificates").value),
        languages: splitTags($("languages").value)
      },
      pack
    );
    state.profileReport = profileReport;
  }
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
    attentionCustom: splitTags($("attentionCustom").value),
    careerPackId: pack.id,
    profileReport
  };
}

function renderPackRoles() {
  const pack = getDefaultPack();
  if ($("packLabel")) $("packLabel").textContent = pack.label;
  const fill = (id, items) => {
    const el = $(id);
    if (!el) return;
    el.innerHTML = (items || []).map((r) => `<li>${escapeHtml(r)}</li>`).join("");
  };
  fill("suitableRoles", pack.suitableRoles);
  fill("cautiousRoles", pack.cautiousRoles);
}

function renderProfileReport(report) {
  state.profileReport = report || null;
  const el = $("profileReportOut");
  if (!el) return;
  el.textContent = report ? formatProfileReportText(report) : "尚未生成侧写。可点「刷新规则侧写」或先提取标签。";
}

function refreshRuleReportFromUI() {
  const years = readYearsExperience();
  const profile = {
    resumeText: $("resumeText").value.trim(),
    yearsExperience: years.ok ? years.value : Number($("yearsExperience")?.value) || 0,
    skills: splitTags($("skills").value),
    industries: splitTags($("industries").value),
    directions: splitTags($("directions").value),
    certificates: splitTags($("certificates").value),
    languages: splitTags($("languages").value)
  };
  const report = buildRuleProfileReport(profile, getDefaultPack());
  renderProfileReport(report);
  return report;
}

function scoreDisplayLine(score) {
  if (!score) return "";
  if (score.gateStatus === "fail") {
    const fit = score.fitTotal != null ? ` · 契合原分 ${score.fitTotal}%` : "";
    return `硬门槛未过 · 展示 ${score.total ?? 0}%${fit}`;
  }
  return `匹配度 ${score.total ?? 0}%`;
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
    batchSize: Number($("batchSize").value) || 5,
    // 权重仅经「确认权重」写入；此处沿用已生效值，避免未确认草稿覆盖
    weights: normalizeWeights(base.weights || DEFAULT_PILLAR_WEIGHTS)
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
  if (rec === REC.REVIEW) return "tag-review";
  if (rec === REC.EXCLUDE) return "tag-exclude";
  return "tag-caution";
}

function groupClass(rec) {
  if (rec === REC.SUGGEST) return "suggest";
  if (rec === REC.REVIEW) return "review";
  if (rec === REC.EXCLUDE) return "exclude";
  return "caution";
}

function withProfile(result) {
  return {
    ...result,
    profile: result.profile || state.profile || null
  };
}

function renderResults() {
  const root = $("resultList");
  // 只展示本批；累计条数在角标旁提示（接着筛选不会把上批混进「本批结果」）
  const enriched = sortResults(state.results).map((r) => enrichResult(withProfile(r)));
  const batchN = enriched.length;
  const sessionN = state.sessionResults?.length || 0;
  $("resultCount").textContent =
    sessionN > batchN ? `${batchN}（累计 ${sessionN}）` : String(batchN);
  const buckets = groupResultsByRecommendation(enriched);
  const parts = [];
  for (const title of REC_ORDER) {
    const list = buckets[title] || [];
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
            const miss = r.score?.requirements?.mustMiss?.length
              ? ` · 未满足:${escapeHtml(r.score.requirements.mustMiss.slice(0, 3).join("/"))}`
              : r.score?.hardGaps?.length
                ? ` · 缺口:${escapeHtml(r.score.hardGaps[0])}`
                : "";
            const attn = r.score?.attentionHits?.length
              ? ` · 注意:${escapeHtml(r.score.attentionHits.join("/"))}`
              : "";
            const dur =
              r.durationMs != null ? ` · ${escapeHtml(formatDuration(r.durationMs))}` : "";
            const gateMiss =
              r.score?.gateStatus === "fail" && r.score?.gateFailed?.length
                ? ` · ${escapeHtml(r.score.gateFailed.slice(0, 2).join("/"))}`
                : miss;
            return `<li>
        <div><strong>${escapeHtml(truncate(r.job?.title || "", 22))}</strong>${company}</div>
        <div>${escapeHtml(scoreDisplayLine(r.score))}
        · <span class="result-rec ${recClass(rec)}">${escapeHtml(rec)}</span>${dur}</div>
        <div>${r.job?.url ? `<a href="${escapeHtml(r.job.url)}" target="_blank" rel="noreferrer">打开</a>` : ""}
        ${gateMiss}${attn}</div>
      </li>`;
          })
          .join("") +
        `</ul>`
    );
  }
  root.innerHTML = parts.join("");
  updateDeepseekStats();
}

/** 暂停时弹框提醒（切页/验证码/网络/手动暂停），避免只看日志漏掉 */
function notifyPaused(reason, { autoResumeHint = true, autoResume = true } = {}) {
  state.paused = true;
  const manual = requiresManualResume(reason) || !autoResume;
  state.autoResumeAllowed = !manual;
  state.pauseReason = reason || "";
  const dlg = $("pauseDialog");
  const body = $("pauseDialogBody");
  const msg =
    reason ||
    "精筛已暂停。请回到招聘列表页后点击「继续运行」。";
  if (body) {
    let extra = "";
    if (!manual && autoResumeHint) {
      extra =
        "\n\n将每约 10 秒自动检测页面是否恢复；网络异常请刷新列表页。也可点下方「继续运行」。";
    } else if (autoResumeHint) {
      extra = requiresManualResume(reason)
        ? "\n\n猎聘「账号行为异常」时列表页仍可能正常，不会自动继续。请先在浏览器完成短信验证，再点「继续运行」。"
        : "\n\n处理完后点下方「继续运行」。";
    }
    body.textContent = msg + extra;
  }
  setPill("已暂停", "pause");
  $("btnResume").disabled = false;
  toast(manual ? "已暂停 — 请验证后点继续" : "已暂停 — 将自动检测恢复", "error", 5000);
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
  try {
    const dlg = $("pauseDialog");
    if (dlg?.open) dlg.close();
  } catch {
    /* ignore */
  }
}

function jobApplyId(job) {
  return job.jobId || job.url || `${job.company || ""}|${job.title || ""}|${Date.now()}`;
}

async function maybeAddToApplyList(result, settings) {
  const r = enrichResult(withProfile(result));
  if (r.score?.excluded) return;
  const th = applyListThresholdOf(settings);
  const eff = effectiveFitScore(r.score);
  if (eff < th) return;
  const platform =
    r.platform ||
    (r.source === "manual" ? "manual" : null) ||
    detectPlatformFromUrl(r.job?.url || "")?.id ||
    "boss";
  const { evicted } = await upsertApplyListItem(
    {
      id: jobApplyId(r.job || {}),
      title: r.job?.title || "",
      company: r.job?.company || "",
      url: r.job?.url || "",
      total: r.score?.total ?? 0,
      fitTotal: r.score?.fitTotal ?? eff,
      effectiveScore: eff,
      gateStatus: r.score?.gateStatus,
      gateLabel: r.score?.gateLabel,
      gateFailed: r.score?.gateFailed || [],
      reviewFlag: !!r.reviewFlag,
      recommendation: r.recommendation,
      analysis: r.analysis || "",
      hardGaps: r.score?.hardGaps || [],
      mustMiss: r.score?.requirements?.mustMiss || [],
      attentionHits: r.score?.attentionHits || [],
      durationMs: r.durationMs,
      excluded: !!r.score?.excluded,
      applyStatus: "未打开",
      source: r.source || "batch",
      platform
    },
    th
  );
  if (evicted?.title) {
    log(
      `投递列表已满 100，已替换最低分且入列最久：${evicted.title}` +
        `（匹配${evicted.total ?? "-"} / 契合${evicted.fitTotal ?? evicted.effectiveScore ?? "-"}）`
    );
  }
}

async function checkpoint() {
  try {
    await saveRunState({
      version: 1,
      nextIndex: state.nextIndex,
      target: state.target,
      results: state.results,
      sessionResults: state.sessionResults,
      order: state.order,
      processedInBatch: state.processedInBatch,
      sinceRest: state.sinceRest,
      deepseekCalls: state.deepseekCalls,
      batchDeepseekCalls: state.batchDeepseekCalls,
      listFingerprint: state.listFingerprint,
      seenKeys: [...state.seenKeys],
      savedAt: Date.now()
    });
    await saveListSession({
      listCursor: state.nextIndex,
      seenKeys: [...state.seenKeys],
      fingerprint: state.listFingerprint,
      results: state.sessionResults,
      order: state.order,
      deepseekCalls: state.deepseekCalls
    });
  } catch (e) {
    const msg = String(e?.message || e);
    log(`断点保存失败：${msg}`);
    if (/quota|Quota|QUOTA/i.test(msg)) {
      log("本地存储配额已满：已尝试压缩；可点「从头」清空会话，或在扩展管理页清除本扩展数据后重试");
      toast("本地存储已满，已压缩断点；必要时点「从头」", "warn");
    } else {
      throw e;
    }
  }
  await refreshContinueButton();
  await refreshStartButton();
}

/**
 * 列表不够时补齐。Boss/智联：下拉；猎聘：先滚再翻页（分页替换列表）。
 * @returns {{ count: number, pageAdvanced?: boolean }}
 */
async function ensureListCount(need, have, platformId = "") {
  let count = have;
  let guard = 0;
  let pageAdvanced = false;
  while (count < need && guard < 12) {
    await waitWhilePaused();
    if (state.stopFlag) break;
    try {
      const blocker = await sendToPlatform({ type: "CL_BLOCKER" });
      if (blocker.blocked) {
        const br = blocker.reason || "检测到安全校验或页面异常";
        notifyPaused(br, { autoResume: !requiresManualResume(br) });
        await waitWhilePaused();
        dismissPauseDialog();
        continue;
      }
      const vis = await sendToPlatform({ type: "CL_VISIBILITY" });
      if (!vis.visible) {
        log("页面不可见，已暂停。恢复后将自动继续");
        notifyPaused("检测到招聘页不可见（可能切走了标签页），精筛已暂停。", {
          autoResume: true
        });
        await waitWhilePaused();
        dismissPauseDialog();
      }
    } catch (e) {
      if (isTransientPlatformError(e.message || e)) {
        notifyPaused(`列表补齐时异常：${String(e.message || e).slice(0, 80)}`, {
          autoResume: true
        });
        await waitWhilePaused();
        dismissPauseDialog();
        continue;
      }
      throw e;
    }

    log(`列表不足，缓慢下拉补齐（当前 ${count}，目标 ${need}）…`);
    const scrolled = await sendToPlatform({ type: "CL_SCROLL" });
    let list = await sendToPlatform({ type: "CL_LIST" });
    count = list.count || 0;
    if (scrolled.grew) {
      guard += 1;
      await sleep(randomBetween(800, 1600));
      continue;
    }

    // 猎聘：本页到底后点页码翻页（列表会整页替换）
    if (platformId === "liepin") {
      log("本页已到底，尝试猎聘翻页…");
      const next = await sendToPlatform({ type: "CL_NEXT_PAGE" });
      if (next?.blocked) throw new Error(next.reason || "翻页触发风控验证");
      if (next?.ok && (next.grew || next.replaced)) {
        pageAdvanced = true;
        list = await sendToPlatform({ type: "CL_LIST" });
        count = list.count || 0;
        log(`已翻到下一页，本页约 ${count} 条`);
        await sleep(randomBetween(1500, 2800));
        break;
      }
      log(next?.reason || "无法继续翻页");
      break;
    }

    if (guard > 2) break;
    guard += 1;
    await sleep(randomBetween(800, 1600));
  }
  return { count, pageAdvanced };
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
  let detailTabId = null;
  await waitWhilePaused();
  if (state.stopFlag) return null;

  try {
    const blocker = await withTimeout(sendToPlatform({ type: "CL_BLOCKER" }), 5000, "风控检测");
    if (blocker.blocked) {
      const br = blocker.reason || "检测到验证或页面异常";
      notifyPaused(br, {
        autoResume: !requiresManualResume(br)
      });
      await waitWhilePaused();
      dismissPauseDialog();
      if (state.stopFlag) return null;
      const again = await withTimeout(sendToPlatform({ type: "CL_BLOCKER" }), 5000, "风控检测");
      if (again.blocked) {
        throw new Error(again.reason || "页面仍异常，稍后重试");
      }
    }

    const vis = await sendToPlatform({ type: "CL_VISIBILITY" });
    if (!vis.visible) {
      log("页面不可见，已暂停");
      notifyPaused("检测到招聘页不可见（可能切走了标签页），精筛已暂停。", {
        autoResume: true
      });
      await waitWhilePaused();
      dismissPauseDialog();
      if (state.stopFlag) return null;
    }

    const list = await withTimeout(sendToPlatform({ type: "CL_LIST" }), 8000, "读取列表");
    const card = list.items?.[index];
    if (!card) throw new Error(`无法读取列表第 ${index + 1} 条`);

    // 通用预筛：标题强跨域 / 列表避雷 → 不开详情，直接出结果（降平台风控）
    const listJob = normalizeJobRecord(
      {
        title: card.title,
        company: card.company,
        salary: card.salary,
        url: card.url,
        jobId: card.jobId,
        keywords: card.keywords || [],
        description: card.listText || card.title || "",
        listTitle: card.title
      },
      card
    );
    const domainSkip = matchTitleDomainSkip(card.title || listJob.title, profile);
    if (domainSkip.skip) {
      const score = buildTitleDomainExcludeScore(domainSkip.term);
      log(`#${index + 1} ${domainSkip.reason}：${card.title}`);
      const result = buildListOnlyResult({
        card,
        listJob,
        score,
        skippedDeepseek: domainSkip.reason,
        profile,
        platformId,
        t0,
        skipReason: domainSkip.reason
      });
      log(
        `#${index + 1} 建议：${result.recommendation} · 耗时 ${formatDuration(result.durationMs)}（未开详情）`
      );
      await maybeAddToApplyList(result, settings);
      await paceAfterJob(t0, platformId, { light: true });
      return result;
    }
    const preScore = scoreJob(listJob, profile, settings);
    if (preScore.excluded) {
      log(
        `#${index + 1} 列表已命中避雷（${preScore.avoidHits.join("/")}），跳过开详情：${card.title}`
      );
      const result = buildListOnlyResult({
        card,
        listJob,
        score: preScore,
        skippedDeepseek: `避雷命中：${preScore.avoidHits.join("、")}`,
        profile,
        platformId,
        t0,
        skipReason: "避雷"
      });
      log(
        `#${index + 1} 建议：${result.recommendation} · 耗时 ${formatDuration(result.durationMs)}（未开详情）`
      );
      await maybeAddToApplyList(result, settings);
      await paceAfterJob(t0, platformId, { light: true });
      return result;
    }

    // 开详情前再探风控 + 日限额
    const dayGate = await checkDailySafetyGate(platformId);
    if (!dayGate.ok) {
      throw new Error(dayGate.reason || "今日安全限额已用尽");
    }

    log(`#${index + 1} 打开详情：${card.title}`);
    const opened = await withTimeout(
      sendToPlatform({ type: "CL_OPEN_INDEX", index }),
      20000,
      "打开详情"
    );
    if (!opened.ok && !opened.detail && !opened.url) {
      throw new Error(opened.reason || "打开详情失败");
    }
    if (
      opened.detail?.loadFailed ||
      /加载失败|正文不可用|页脚|请刷新/.test(String(opened.reason || ""))
    ) {
      throw new Error(opened.reason || "详情数据加载失败，请刷新后重试");
    }
    await recordDetailOpen(platformId);

    const { platform } = await getPlatformTab();
    let d = { ...(opened.detail || {}) };

    if (opened.opensNewTab && (opened.url || card.url)) {
      const detailUrl = opened.url || card.url;
      log(`#${index + 1} 新标签打开详情页…`);
      detailTabId = await openDetailTab(detailUrl, platformId);
      const scraped = await scrapeDetailFromTab(detailTabId, platform.contentScript, 8000, {
        liepinStrict: platformId === "liepin"
      });
      if (scraped?.blocked || isLiepinRiskUrl(scraped?.url || "")) {
        // 风控页也尽量关掉；关不掉则改为「无法关闭」暂停，避免标签堆积
        try {
          await closeDetailTabOrPause(detailTabId, platformId);
          detailTabId = null;
        } catch (closeErr) {
          detailTabId = null;
          throw closeErr;
        }
        throw new Error(
          scraped?.blockReason || "猎聘账号行为异常/短信验证，请先在浏览器完成验证后再继续"
        );
      }
      d = { ...d, ...scraped };
      if (platformId === "liepin" && !scraped?.ready) {
        log(`#${index + 1} 职位介绍未就绪，避免用顶栏壳打分；保留列表字段`);
        // 无真实 JD 时不要把导航/福利壳当职责
        if (!/任职要求|职位介绍|主要职责|岗位职责/.test(String(scraped?.description || ""))) {
          d.description = card.listText || "";
          d.rawLength = (d.description || "").length;
          d.ready = false;
        }
      }
      // 详情误刮到「猜你喜欢」时，薪资/公司回退列表卡
      if (platformId === "liepin") {
        if (card.salary && d.salary && card.salary !== d.salary) {
          const cardSal = String(card.salary).replace(/\s/g, "");
          const detailSal = String(d.salary).replace(/\s/g, "");
          if (cardSal && detailSal && !detailSal.includes(cardSal.slice(0, 4)) && !cardSal.includes(detailSal.slice(0, 4))) {
            log(`#${index + 1} 详情薪资与列表不一致（${d.salary} vs ${card.salary}），采用列表`);
            d.salary = card.salary;
          }
        }
        if (card.company && d.company && card.company !== d.company) {
          // 列表公司通常更准；详情易串到猜你喜欢
          if (!String(d.company).includes(String(card.company).slice(0, 4))) {
            log(`#${index + 1} 详情公司与列表不一致（${d.company} vs ${card.company}），采用列表`);
            d.company = card.company;
          }
        }
      }
    } else {
      // Boss 等：CL_OPEN_INDEX 内已轮询就绪；正文不足或失败页时再短轮询
      const needMore =
        d.loadFailed ||
        !d.ready ||
        !(d.description && (d.rawLength >= 60 || d.description.length >= 60));
      if (needMore) {
        const start = Date.now();
        while (Date.now() - start < 4000) {
          const scraped = await sendToPlatform({ type: "CL_SCRAPE_DETAIL" });
          d = { ...d, ...(scraped.detail || {}) };
          if (d.loadFailed) {
            throw new Error("详情数据加载失败，请刷新后重试");
          }
          if (d.ready && (d.rawLength || d.description?.length || 0) >= 60) break;
          await sleep(300);
        }
      }
    }

    // 失败页/页脚 SEO 不得入库打分（曾出现「数据加载失败+热门职位」仍建议投递）
    const descCandidate =
      d.loadFailed || isUnusableJobDescription(d.description || "")
        ? ""
        : d.description || (d.ready === false ? "" : card.listText || "");
    if (d.loadFailed || isUnusableJobDescription(descCandidate)) {
      throw new Error("详情正文未加载成功或为页脚噪声，请刷新后重试");
    }

    const job = normalizeJobRecord(
      {
        ...d,
        company: d.company || card.company,
        url:
          (d.url && !/\/web\/geek\/jobs/.test(d.url) && !/\/zhaopin\//.test(d.url)
            ? d.url
            : null) ||
          card.url ||
          d.url,
        jobId: d.jobId || card.jobId,
        salary: d.salary || card.salary,
        keywords: d.keywords?.length ? d.keywords : [],
        description: descCandidate,
        listTitle: d.listTitle || card.title
      },
      card
    );

    if (isUnusableJobDescription(job.description || job.responsibilities || "")) {
      throw new Error("详情正文未加载成功或为页脚噪声，请刷新后重试");
    }

    const score = await scoreJobFull(job, profile, settings);
    log(
      `#${index + 1} ${scoreDisplayLine(score)}` +
        (score.excluded ? `｜避雷:${score.avoidHits.join("/")}` : "") +
        (score.gateStatus === "fail" && score.gateFailed?.length
          ? `｜门禁:${score.gateFailed.slice(0, 3).join("/")}`
          : "") +
        (score.hardGaps?.length && score.gateStatus !== "fail"
          ? `｜缺口:${score.hardGaps.join("/")}`
          : "") +
        (score.attentionHits.length ? `｜注意:${score.attentionHits.join("/")}` : "")
    );

    let analysis = "";
    let skippedDeepseek = "";
    let favorited = false;
    let llmLabel = "";
    const { provider, apiKey } = resolveLlmConfig(settings);

    const fitForAi = effectiveFitScore(score);
    /** 已配置 Key 且达到分析阈值：必须有模型正文，推荐状态才可信 */
    const llmRequired =
      !!apiKey && !score.excluded && fitForAi >= (settings.deepseekThreshold ?? 60);

    if (score.excluded) {
      skippedDeepseek = `避雷命中：${score.avoidHits.join("、")}`;
    } else if (fitForAi < (settings.deepseekThreshold ?? 60)) {
      skippedDeepseek = `低于分析阈值 ${settings.deepseekThreshold}（契合原分 ${fitForAi}）`;
    } else if (!apiKey) {
      skippedDeepseek = `未配置 ${provider.label} API Key`;
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
          state.batchDeepseekCalls += 1;
          updateDeepseekStats();
          log(`#${index + 1} ${provider.label} 分析完成`);
        }
      } catch (e) {
        skippedDeepseek = `${provider.label} 失败：${e.message || e}`;
        log(skippedDeepseek);
        log(`#${index + 1} 模型结论不可用，推荐改为待复核（不按不可信状态建议投递）`);
      }
    }

    // 收藏：仅「建议投递」路径；门禁失败 / 待复核 / 硬缺口不收藏
    const mustMissN = score.requirements?.mustMiss?.length || 0;
    const preRec = enrichResult({
      job,
      score,
      analysis,
      skippedDeepseek,
      llmRequired,
      hasLlmKey: !!apiKey,
      profile
    }).recommendation;
    if (
      !opened.opensNewTab &&
      !score.excluded &&
      score.gateStatus !== "fail" &&
      preRec === REC.SUGGEST &&
      mustMissN === 0 &&
      !(score.hardGaps || []).some((g) => /必备|语言|证书|年限|门禁|领域/.test(g)) &&
      score.total >= (settings.favoriteThreshold ?? 80)
    ) {
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

    await closeDetailTabOrPause(detailTabId, platformId);
    detailTabId = null;

    const durationMs = Date.now() - t0;
    const result = enrichResult({
      order: ++state.order,
      job,
      score,
      analysis,
      skippedDeepseek,
      llmRequired,
      hasLlmKey: !!apiKey,
      favorited,
      llmLabel,
      durationMs,
      platform: platformId,
      source: "batch",
      profile
    });
    log(`#${index + 1} 建议：${result.recommendation} · 耗时 ${formatDuration(durationMs)}`);
    await maybeAddToApplyList(result, settings);
    // 条末补间隔（不计入上方耗时展示）；猎聘更长，防连开详情触发风控
    await paceAfterJob(t0, platformId);
    await afterDetailOpenPacing(platformId);
    return result;
  } finally {
    if (detailTabId) {
      try {
        await closeDetailTabOrPause(detailTabId, platformId);
      } catch (e) {
        // finally 内再抛会导致掩盖主错误；猎聘关不掉时记入暂停态，由外层下一轮感知
        const msg = String(e.message || e);
        if (platformId === "liepin" && requiresManualResume(msg)) {
          log(`错误：${msg}`);
          notifyPaused(msg, { autoResume: false });
        }
      }
    }
  }
}

/** 关闭详情标签；猎聘关闭失败则抛错以触发暂停 */
async function closeDetailTabOrPause(tabId, platformId = "") {
  if (!tabId) return { ok: true, skipped: true };
  const retries = platformId === "liepin" ? 4 : 1;
  const closed = await closeTabSafe(tabId, { retries });
  if (platformId === "liepin" && !closed.ok) {
    throw new Error(
      `无法关闭猎聘详情页${closed.reason ? `（${closed.reason}）` : ""}，请手动关闭该标签后点「继续运行」`
    );
  }
  if (!closed.ok) {
    log(`详情标签未能关闭：${closed.reason || tabId}`);
  }
  return closed;
}

async function finishBatch(settings, reason) {
  log(reason);
  const est = estimateDeepseekCost(state.batchDeepseekCalls);
  log(
    `本批 ${state.results.length} 条 · 模型调用 ${est.calls} 次，费用预估约 ¥${est.yuanText}` +
      (state.sessionResults.length > state.results.length
        ? `（本列表累计已分析 ${state.sessionResults.length} 条，导出仅含本批）`
        : "")
  );
  log(`列表游标已停在第 ${state.nextIndex + 1} 条，未改筛时可再点「接着筛选」`);
  setPill("空闲");
  // 只清中途断点，保留列表游标，方便下一批接着跑
  await clearRunState();
  await saveListSession({
    listCursor: state.nextIndex,
    seenKeys: [...state.seenKeys],
    fingerprint: state.listFingerprint,
    results: state.sessionResults,
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
  await exportResultsWithTip(state.results, settings.exportMode, settings.exportFormat, {
    deepseekCalls: state.batchDeepseekCalls
  });
}

async function ensureUsageNoticeAccepted() {
  if (await isUsageNoticeAccepted()) return true;
  const dlg = $("usageNoticeDialog");
  if (!dlg) {
    toast("请先阅读并同意使用须知", "error");
    return false;
  }
  return new Promise((resolve) => {
    const ok = $("btnUsageNoticeOk");
    const cancel = $("btnUsageNoticeCancel");
    const check = $("usageNoticeCheck");
    if (check) check.checked = false;
    const cleanup = () => {
      ok?.removeEventListener("click", onOk);
      cancel?.removeEventListener("click", onCancel);
    };
    const onOk = async () => {
      if (!check?.checked) {
        toast("请勾选「我已阅读并同意」", "error");
        return;
      }
      await acceptUsageNotice();
      cleanup();
      try {
        dlg.close();
      } catch {
        /* ignore */
      }
      resolve(true);
    };
    const onCancel = () => {
      cleanup();
      try {
        dlg.close();
      } catch {
        /* ignore */
      }
      resolve(false);
    };
    ok?.addEventListener("click", onOk);
    cancel?.addEventListener("click", onCancel);
    try {
      if (typeof dlg.showModal === "function") dlg.showModal();
      else dlg.setAttribute("open", "");
    } catch {
      resolve(false);
    }
  });
}

async function runBatch({ resume = false } = {}) {
  const years = readYearsExperience();
  if (!years.ok) {
    toast(years.error, "error");
    return;
  }
  if (!(await ensureUsageNoticeAccepted())) {
    toast("需同意使用须知后才能精筛", "error");
    return;
  }
  let platformIdHint = "";
  try {
    const { platform } = await getPlatformTab();
    platformIdHint = platform?.id || "";
  } catch {
    /* 稍后健康检查再报 */
  }
  const dayGate = await checkDailySafetyGate(platformIdHint);
  if (!dayGate.ok) {
    log(dayGate.reason);
    toast(dayGate.reason, "error", 6000);
    notifyPaused(dayGate.reason, { autoResume: false, autoResumeHint: true });
    return;
  }
  const safety = dayGate.safety || (await getSafetyState());
  log(
    `安全计数：今日风控 ${safety.dayCounters?.riskEvents || 0}/${DAILY_RISK_LOCK_COUNT}` +
      (platformIdHint === "liepin"
        ? ` · 猎聘开详情 ${safety.dayCounters?.liepinDetailOpens || 0}/${DAILY_LIEPIN_DETAIL_OPEN_MAX}`
        : "")
  );

  const profile = collectProfileFromUI();
  let settings = collectSettingsFromUI(await getSettings());
  await saveProfile(profile);
  await saveSettings(settings);
  state.profile = profile;

  state.running = true;
  state.paused = false;
  state.stopFlag = false;
  state.sinceJitter5 = 0;
  state.sinceHumanize = 0;
  state.humanizeEvery = randomBetween(8, 12);

  const batchSize = Math.min(100, Math.max(1, settings.batchSize || 5));

  if (resume) {
    const rs = await getRunState();
    if (!rs) {
      toast("没有可续跑的断点", "error");
      state.running = false;
      return;
    }
    // 中途续跑：恢复本批 + 会话累计
    state.results = rs.batchResults || rs.results || [];
    state.sessionResults = rs.sessionResults || rs.results || [];
    state.order = rs.order || state.sessionResults.length;
    state.processedInBatch = rs.processedInBatch || 0;
    state.sinceRest = rs.sinceRest || 0;
    state.deepseekCalls = rs.deepseekCalls || 0;
    state.batchDeepseekCalls = rs.batchDeepseekCalls || 0;
    state.nextIndex = rs.nextIndex || 0;
    state.target = rs.target || state.nextIndex + batchSize;
    state.listFingerprint = rs.listFingerprint || "";
    state.seenKeys = new Set(rs.seenKeys || []);
    seedSeenFromResults(state.sessionResults);
    log(`续跑：从列表第 ${state.nextIndex + 1} 条继续（本批目标至第 ${state.target} 条）`);
  } else {
    await clearRunState();
    state.processedInBatch = 0;
    state.sinceRest = 0;
    state.batchDeepseekCalls = 0;
    // 新开一批：清空本批展示；会话累计从 listSession 接上
    state.results = [];

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
        state.sessionResults = [];
        state.order = 0;
        state.deepseekCalls = 0;
      } else {
        state.nextIndex = sess.listCursor || 0;
        state.seenKeys = new Set(sess.seenKeys || []);
        state.listFingerprint = fp || sess.fingerprint || "";
        state.sessionResults = sess.results || [];
        seedSeenFromResults(state.sessionResults);
        state.order = sess.order || state.sessionResults.length;
        state.deepseekCalls = sess.deepseekCalls || 0;
        if (state.nextIndex > 0) {
          log(
            `接着筛选：从列表第 ${state.nextIndex + 1} 条起再跑 ${batchSize} 条（跳过已分析 ${state.seenKeys.size} 个键；本批单独导出；累计 ${state.sessionResults.length} 条）`
          );
        } else {
          log(`开始精筛：从列表第 1 条起跑 ${batchSize} 条`);
        }
      }
    } catch (e) {
      // 探测失败时仍进入主流程的健康检查
      state.nextIndex = 0;
      state.seenKeys = new Set();
      state.listFingerprint = "";
      state.sessionResults = [];
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
      log("运行中发现列表指纹变化，已重置游标与本批/累计结果");
      state.nextIndex = 0;
      state.seenKeys = new Set();
      state.listFingerprint = fp;
      state.target = batchSize;
      state.results = [];
      state.sessionResults = [];
      state.order = 0;
      state.processedInBatch = 0;
      state.batchDeepseekCalls = 0;
    }

    await ensureListCount(
      Math.min(state.target, list.count + 5),
      list.count,
      platformId
    );
    list = await sendToPlatform({ type: "CL_LIST" });

    let i = state.nextIndex;
    while (state.processedInBatch < batchGoal) {
      if (state.stopFlag) break;
      await waitWhilePaused();
      if (state.stopFlag) break;

      list = await sendToPlatform({ type: "CL_LIST" });
      if (i >= (list.count || 0)) {
        const filled = await ensureListCount(i + 1, list.count || 0, platformId);
        list = await sendToPlatform({ type: "CL_LIST" });
        // 猎聘翻页后列表整页替换：游标回到本页第 1 条，已看过的靠 seenKeys 跳过
        if (filled?.pageAdvanced) {
          i = 0;
          state.nextIndex = 0;
          state.listFingerprint = listFingerprintOf(list.items || []) || state.listFingerprint;
          log("已进入下一页，从本页第 1 条继续（已分析过的会跳过）");
        } else if (i >= (list.count || 0)) {
          log("列表已无更多岗位，提前结束");
          break;
        }
      }

      const card = list.items?.[i];
      if (hasSeenJob(card)) {
        log(`#${i + 1} 已分析过，跳过：${card?.title || jobKeyOf(card)}`);
        i += 1;
        state.nextIndex = i;
        await checkpoint();
        continue;
      }

      // 猎聘风控更严：每 5 条（实际开过详情的）长休息；列表避雷跳过不计入
      const restEvery = platformId === "liepin" ? 5 : 30;
      const restSec = platformId === "liepin" ? 75 : 30;
      if (state.sinceRest >= restEvery && (platformId === "liepin" || batchGoal >= 50)) {
        log(`已开详情 ${restEvery} 条，强制休息 ${restSec} 秒（降猎聘风控）…`);
        setPill("休息中", "pause");
        for (let s = restSec; s > 0; s--) {
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
          // 列表卡可能缺 jobId，详情刮完后再核一次，避免同岗入库两次
          const dup = hasSeenJob(item.job);
          markSeenJob(card, item.job);
          if (dup) {
            log(`#${i + 1} 与已分析岗位重复，跳过入库：${item.job?.title || ""}`);
            i += 1;
            state.nextIndex = i;
            await checkpoint();
            continue;
          }
          state.results.push(item);
          state.sessionResults.push(item);
          state.processedInBatch += 1;
          // 仅真实开过详情才累加休息计数（listOnly 避雷跳过不计）
          if (!item.listOnly) state.sinceRest += 1;
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
        if (
          /行为异常|短信验证|safe\.liepin|异常访问行为|无法关闭.*详情|今日已触发平台风控|今日猎聘已打开详情/.test(
            msg
          )
        ) {
          if (/今日已触发|今日猎聘已打开/.test(msg)) {
            notifyPaused(msg, { autoResume: false });
            await waitWhilePaused();
            dismissPauseDialog();
            break;
          }
          const risk = await recordRiskEvent(
            /无法关闭/.test(msg) ? "close-fail" : "platform-risk"
          );
          log(`已记录风控事件：今日 ${risk.riskEvents}/${DAILY_RISK_LOCK_COUNT}`);
          notifyPaused(
            risk.locked
              ? `今日风控已达 ${risk.riskEvents} 次，精筛已锁定至明天。请休息账号，勿通过重装扩展规避。`
              : /无法关闭/.test(msg)
                ? msg
                : "检测到账号行为异常/短信验证。请先在浏览器完成验证；完成后必须点「继续运行」。",
            { autoResume: false }
          );
          await waitWhilePaused();
          dismissPauseDialog();
          if (state.stopFlag || risk.locked) break;
          const coolSec = platformId === "liepin" ? 90 : 30;
          log(`安全验证后冷却 ${coolSec} 秒再继续当前条…`);
          setPill("冷却中", "pause");
          for (let s = coolSec; s > 0; s--) {
            if (state.stopFlag) break;
            $("progress").textContent = `风控冷却 ${s}s`;
            await sleep(1000);
          }
          state.sinceRest = 0;
          setPill("运行中", "busy");
          continue;
        }
        if (/验证|安全校验|验证码/.test(msg)) {
          notifyPaused(
            "检测到平台安全校验/验证码。请先在浏览器完成验证；页面恢复后将自动继续，也可点「继续运行」。",
            { autoResume: true }
          );
          await waitWhilePaused();
          dismissPauseDialog();
          continue;
        }
        if (isTransientPlatformError(msg)) {
          notifyPaused(
            `检测到网络/页面异常：${msg.slice(0, 80)}。请刷新招聘列表页或等待网络恢复；约每 10 秒自动检测，恢复后继续当前岗位。`,
            { autoResume: true }
          );
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
      await exportResultsWithTip(state.results, settings.exportMode, settings.exportFormat, {
        deepseekCalls: state.batchDeepseekCalls
      });
      setPill("空闲");
    } else {
      await finishBatch(settings, "本批完成，导出本批结果");
    }
  } catch (e) {
    log(`运行失败：${e.message || e}`);
    await checkpoint();
    if (state.results.length) {
      await exportResultsWithTip(state.results, settings.exportMode, settings.exportFormat, {
        deepseekCalls: state.batchDeepseekCalls
      });
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
  state.profile = profile;

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
  const score = await scoreJobFull(job, profile, settings);
  let analysis = "";
  let skipped = "";
  let llmLabel = "";
  const { provider, apiKey } = resolveLlmConfig(settings);
  const fitForAi = effectiveFitScore(score);
  const llmRequired =
    !!apiKey && !score.excluded && fitForAi >= (settings.deepseekThreshold ?? 60);
  if (score.excluded) skipped = `避雷：${score.avoidHits.join("、")}`;
  else if (fitForAi < settings.deepseekThreshold)
    skipped = `低于阈值 ${settings.deepseekThreshold}（契合原分 ${fitForAi}）`;
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
    llmRequired,
    hasLlmKey: !!apiKey,
    score,
    analysis,
    skippedDeepseek: skipped,
    favorited: false,
    llmLabel,
    durationMs,
    source: "manual",
    platform: "manual",
    profile
  });
  state.results.push(result);
  renderResults();
  await maybeAddToApplyList(result, settings);
  await renderApplyList();

  $("manualOut").textContent = [
    `岗位：${title}${company ? ` · ${company}` : ""}`,
    `建议：${result.recommendation}`,
    scoreDisplayLine(score),
    score.gateStatus === "fail" && score.gateFailed?.length
      ? `门禁失败：${score.gateFailed.join("；")}`
      : score.gateLabel || "",
    `生成时长：${formatDuration(durationMs)}`,
    score.excluded ? `已排除：${score.avoidHits.join("、")}` : "未排除",
    score.hardGaps?.length ? `硬门槛缺口：${score.hardGaps.join("；")}` : "",
    score.requirements?.must?.length
      ? `必备能力：${score.requirements.must.slice(0, 16).join("、")}`
      : "",
    score.requirements?.mustMiss?.length
      ? `必备未满足：${score.requirements.mustMiss.slice(0, 12).join("、")}`
      : "",
    score.requirements?.preferred?.length
      ? `优先项：${score.requirements.preferred.slice(0, 10).join("、")}`
      : "",
    score.attentionHits?.length ? `注意：${score.attentionHits.join("、")}` : "",
    formatPillarLine(score),
    skipped ? `模型：${skipped}` : llmLabel ? `模型：${llmLabel}` : "",
    analysis || ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function renderApplyList() {
  applyUi.list = (await getApplyList()).slice().sort(compareApplyListRows);
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
      const fit = row.fitTotal ?? row.effectiveScore;
      const match = row.total ?? 0;
      const recRaw =
        row.recommendation ||
        (row.reviewFlag ? REC.REVIEW : "") ||
        "";
      const recShort =
        recRaw === REC.SUGGEST || recRaw === "建议投递"
          ? "建议"
          : recRaw === REC.REVIEW || recRaw === "待复核"
            ? "待复核"
            : recRaw === REC.CAUTION || recRaw === "谨慎投递" || recRaw === "谨慎"
              ? "谨慎"
              : recRaw === REC.EXCLUDE || recRaw === "已排除"
                ? "排除"
                : recRaw
                  ? truncate(recRaw, 4)
                  : "-";
      // 建议 + 匹配度/契合原分合并一列（入库看契合≥阈值）
      const scoreText =
        fit != null && Number(fit) !== Number(match)
          ? `${match}/${fit}`
          : `${match}%`;
      const tip = [
        recRaw || "未分组",
        `展示匹配度 ${match}%`,
        fit != null ? `契合原分 ${fit}%（入库阈值看此项）` : "",
        "点击查看分析"
      ]
        .filter(Boolean)
        .join(" · ");
      const recClass =
        recShort === "建议"
          ? "rec-suggest"
          : recShort === "待复核"
            ? "rec-review"
            : recShort === "谨慎"
              ? "rec-caution"
              : recShort === "排除"
                ? "rec-exclude"
                : "";
      return `<tr data-id="${escapeHtml(row.id)}">
        <td class="col-check"><input type="checkbox" class="apply-check" value="${escapeHtml(row.id)}" /></td>
        <td class="col-title"><span class="apply-cell" data-act="open" title="${escapeHtml(row.title || "")}（点击打开链接）">${title}</span></td>
        <td class="col-company"><span class="apply-cell muted" title="${escapeHtml(row.company || "")}">${company}</span></td>
        <td class="col-rec-score"><span class="apply-cell ${recClass}" data-act="analysis" title="${escapeHtml(tip)}"><span class="rec-tag">${escapeHtml(recShort)}</span> ${escapeHtml(scoreText)}</span></td>
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
  const fit =
    row.fitTotal != null && row.fitTotal !== row.total ? ` · 契合原分 ${row.fitTotal}%` : "";
  $("analysisDialogTitle").textContent = `${row.title || "岗位"} · ${row.total ?? 0}%${fit}`;
  $("analysisDialogBody").textContent = [
    `建议：${row.recommendation || "-"}`,
    row.reviewFlag || row.recommendation === REC.REVIEW ? "防漏标记：待复核（请人工确认）" : "",
    row.gateLabel || (row.gateStatus === "fail" ? "硬门槛未过" : ""),
    row.gateFailed?.length ? `门禁失败：${row.gateFailed.join("；")}` : "",
    row.hardGaps?.length ? `硬门槛缺口：${row.hardGaps.join("；")}` : "",
    row.attentionHits?.length ? `注意：${row.attentionHits.join("、")}` : "",
    `打开状态：${row.applyStatus || "未打开"}`,
    row.createdAt ? `入列时间：${new Date(row.createdAt).toLocaleString("zh-CN")}` : "",
    "",
    row.analysis || "暂无模型分析"
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
      if (state.profileReport?.mode !== "ai") refreshRuleReportFromUI();
      await saveProfile(collectProfileFromUI());
      // 权重不经此按钮写入，仅保存其它运行相关设置
      const settings = collectSettingsFromUI(await getSettings());
      await saveSettings(settings);
      log("画像已保存（含侧写；权重请用「确认权重」单独生效）");
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
      log("契合四维权重已确认生效");
      toast("四维权重已生效（合计 100）", "ok");
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
    refreshRuleReportFromUI();
    toast("已提取标签并刷新规则侧写", "ok");
  });

  $("btnRuleReport")?.addEventListener("click", () => {
    refreshRuleReportFromUI();
    toast("规则侧写已刷新", "ok");
  });

  $("btnAiReport")?.addEventListener("click", async () => {
    try {
      const settings = collectSettingsFromUI(await getSettings());
      const { provider, apiKey } = resolveLlmConfig(settings);
      if (!apiKey) {
        toast(`请先在「模型设置」配置 ${provider.label} API Key`, "error");
        return;
      }
      toast(`正在用 ${provider.label} 生成 AI 侧写…`, "info");
      const years = readYearsExperience();
      const profile = {
        resumeText: $("resumeText").value.trim(),
        yearsExperience: years.ok ? years.value : Number($("yearsExperience")?.value) || 0,
        skills: splitTags($("skills").value),
        industries: splitTags($("industries").value),
        directions: splitTags($("directions").value),
        certificates: splitTags($("certificates").value),
        languages: splitTags($("languages").value)
      };
      const report = await buildAiProfileReport({ profile, settings, pack: getDefaultPack() });
      renderProfileReport(report);
      toast("AI 侧写已生成，请核对后保存画像", "ok", 3500);
    } catch (e) {
      toast(`AI 侧写失败：${e.message || e}`, "error", 4000);
    }
  });

  $("btnStart").addEventListener("click", () => runBatch({ resume: false }));
  $("btnContinue").addEventListener("click", () => runBatch({ resume: true }));
  $("btnResetList").addEventListener("click", async () => {
    if (state.running) return;
    await clearListSession();
    await clearRunState();
    state.results = [];
    state.sessionResults = [];
    state.nextIndex = 0;
    state.seenKeys = new Set();
    state.listFingerprint = "";
    state.order = 0;
    state.deepseekCalls = 0;
    state.batchDeepseekCalls = 0;
    renderResults();
    updateDeepseekStats();
    await refreshContinueButton();
    await refreshStartButton();
    log("已重置列表游标，下次将从第 1 条开始");
    toast("已从头开始", "ok");
  });
  $("btnPause").addEventListener("click", async () => {
    await checkpoint();
    notifyPaused("已手动暂停（断点已保存）。需要时点「继续运行」。", {
      autoResume: false,
      autoResumeHint: true
    });
  });
  const resumeRun = () => {
    state.paused = false;
    state.autoResumeAllowed = false;
    state.pauseReason = "";
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
      $("exportFormat")?.value || settings.exportFormat || "md",
      { deepseekCalls: state.batchDeepseekCalls }
    );
  });
  $("btnClearLog").addEventListener("click", () => {
    $("log").textContent = "";
  });
  $("btnManualAnalyze").addEventListener("click", () => manualAnalyze());

  $("btnApplyRefresh").addEventListener("click", () => renderApplyList());
  $("btnApplyExport")?.addEventListener("click", async () => {
    try {
      const list = await getApplyList();
      if (!list.length) {
        toast("投递列表为空", "error");
        return;
      }
      toast("正在导出 Excel…", "info");
      const { filename, count } = await downloadApplyListExcel(list);
      log(`投递列表已导出：${filename}（${count} 条；已冻结表头，按匹配度/契合度/入列时间倒序）`);
      toast(`已导出 ${count} 条：${filename}`, "ok", 3500);
    } catch (e) {
      toast(`导出失败：${e.message || e}`, "error");
    }
  });
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
