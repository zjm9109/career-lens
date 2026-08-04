/**
 * 侧边栏主控：画像 / 设置 / 精筛 / 投递列表
 */
import {
  DEFAULT_AVOID_TAGS,
  DEFAULT_WEIGHTS,
  DEFAULT_PILLAR_WEIGHTS,
  APPLY_LIST_PAGE_SIZE,
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
  patchApplyListStatus
} from "../common/storage.js";
import { scoreJob, mergeSemanticIntoScore } from "../common/scoring.js";
import { scoreSemanticPillars } from "../common/semantic-score.js";
import { analyzeJobWithLlm, LLM_PROVIDERS, resolveLlmConfig } from "../common/llm.js";
import { PILLAR_LABELS } from "../common/pillars.js";
import {
  downloadResults,
  downloadApplyListExcel,
  sortResults,
  formatDuration
} from "../common/export.js";
import { parseResumeFile, suggestProfileFromText } from "../common/resume-parse.js";
import {
  compactAnalysis,
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
  stopFlag: false,
  /** 本批结果（侧栏展示 + 自动/手动导出） */
  results: [],
  /** 同一筛选列表上的累计结果（仅会话续跑用，不整包导出） */
  sessionResults: [],
  order: 0,
  profileReport: null,
  processedInBatch: 0,
  sinceRest: 0,
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
      throw new Error("猎聘账号行为异常/短信验证，请先在浏览器完成验证后再继续");
    }
  } catch (e) {
    if (/短信验证|行为异常|安全校验|验证码/.test(String(e.message || e))) throw e;
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

async function closeTabSafe(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* 用户已关 */
  }
}

/**
 * 单条结束后补间隔，降低连开详情触发风控的概率。
 * 猎聘对后台连开 /job/ 很敏感：目标约 8–14s/条；Boss 仍为短补间隔。
 */
async function paceAfterJob(t0, platformId = "") {
  const elapsed = Date.now() - t0;
  if (platformId === "liepin") {
    const minGap = randomBetween(8000, 14000);
    if (elapsed < minGap) await sleep(minGap - elapsed);
    return;
  }
  if (elapsed < 3000) {
    await sleep(randomBetween(2000, 5000));
  }
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

/** 规则分 +（有 Key 时）语义/向量四维 */
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
    }
  } catch (e) {
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
    batchSize: Number($("batchSize").value) || 10,
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
  await upsertApplyListItem(
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
    const blocker = await sendToPlatform({ type: "CL_BLOCKER" });
    if (blocker.blocked) throw new Error(blocker.reason || "安全校验");
    const vis = await sendToPlatform({ type: "CL_VISIBILITY" });
    if (!vis.visible) {
      state.paused = true;
      log("页面不可见，已暂停。回到列表页后点「继续」");
      notifyPaused("检测到招聘页不可见（可能切走了标签页），精筛已暂停。");
      await waitWhilePaused();
      dismissPauseDialog();
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
    if (!opened.ok && !opened.detail && !opened.url) {
      throw new Error(opened.reason || "打开详情失败");
    }

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
      // Boss 等：CL_OPEN_INDEX 内已轮询就绪；正文不足时再短轮询
      const needMore = !(d.description && (d.rawLength >= 60 || d.description.length >= 60));
      if (needMore) {
        const start = Date.now();
        while (Date.now() - start < 2500) {
          const scraped = await sendToPlatform({ type: "CL_SCRAPE_DETAIL" });
          d = { ...d, ...(scraped.detail || {}) };
          if ((d.rawLength || d.description?.length || 0) >= 60) break;
          await sleep(250);
        }
      }
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
        description: d.description || card.listText || "",
        listTitle: d.listTitle || card.title
      },
      card
    );

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
      }
    }

    // 收藏：仅「建议投递」路径；门禁失败 / 待复核 / 硬缺口不收藏
    const mustMissN = score.requirements?.mustMiss?.length || 0;
    const preRec = enrichResult({ job, score, analysis, profile }).recommendation;
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

    await closeTabSafe(detailTabId);
    detailTabId = null;

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
      source: "batch",
      profile
    });
    log(`#${index + 1} 建议：${result.recommendation} · 耗时 ${formatDuration(durationMs)}`);
    await maybeAddToApplyList(result, settings);
    // 条末补间隔（不计入上方耗时展示）；猎聘更长，防连开详情触发风控
    await paceAfterJob(t0, platformId);
    return result;
  } finally {
    await closeTabSafe(detailTabId);
  }
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
  state.profile = profile;

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

      // 猎聘风控更严：每 8 条休息；其它平台大批次每 30 条
      const restEvery = platformId === "liepin" ? 8 : 30;
      const restSec = platformId === "liepin" ? 45 : 30;
      if (state.sinceRest >= restEvery && (platformId === "liepin" || batchGoal >= 50)) {
        log(`已处理 ${restEvery} 条，强制休息 ${restSec} 秒（降风控）…`);
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
        if (/验证|安全校验|验证码|行为异常|短信验证/.test(msg)) {
          state.paused = true;
          notifyPaused(
            "检测到猎聘/平台安全校验（如「账号行为异常」短信验证）。请先在浏览器完成验证，再点「继续运行」或「续跑」。建议猎聘本批≤8 条、勿连开过多详情。"
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
  applyUi.list = (await getApplyList()).slice().sort((a, b) => {
    const sa = a.effectiveScore ?? a.fitTotal ?? a.total ?? 0;
    const sb = b.effectiveScore ?? b.fitTotal ?? b.total ?? 0;
    const td = sb - sa;
    if (td !== 0) return td;
    return (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0);
  });
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
      const scoreTip =
        fit != null && fit !== row.total
          ? `展示 ${row.total ?? 0}% · 契合原分 ${fit}%`
          : `${row.total ?? 0}%`;
      const recMark = row.reviewFlag || row.recommendation === REC.REVIEW ? " · 待复核" : "";
      return `<tr data-id="${escapeHtml(row.id)}">
        <td class="col-check"><input type="checkbox" class="apply-check" value="${escapeHtml(row.id)}" /></td>
        <td class="col-title"><span class="apply-cell" data-act="open" title="${escapeHtml(row.title || "")}（点击打开链接）">${title}</span></td>
        <td class="col-company"><span class="apply-cell muted" title="${escapeHtml(row.company || "")}">${company}</span></td>
        <td class="col-score"><span class="apply-cell" data-act="analysis" title="点击查看分析结果：${escapeHtml(scoreTip)}${escapeHtml(recMark)}">${row.total ?? 0}%${row.reviewFlag ? "*" : ""}</span></td>
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
      toast("正在导出 Excel（CSV）…", "info");
      const { filename, count } = await downloadApplyListExcel(list);
      log(`投递列表已导出：${filename}（${count} 条）`);
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
