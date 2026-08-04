import {
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  APPLY_LIST_MAX,
  USAGE_NOTICE_VERSION,
  DAILY_RISK_LOCK_COUNT,
  DAILY_LIEPIN_DETAIL_OPEN_MAX,
  normalizeWeights
} from "./constants.js";

const KEYS = {
  profile: "cl_profile",
  settings: "cl_settings",
  runState: "cl_run_state",
  applyList: "cl_apply_list",
  /** 同一筛选列表上的游标：接着往后筛，避免每次从第 1 条重跑 */
  listSession: "cl_list_session",
  /** 使用须知勾选 + 当日风控/开详情计数（软锁，清扩展数据会重置） */
  safety: "cl_safety"
};

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function emptyDayCounters() {
  return { riskEvents: 0, detailOpens: 0, liepinDetailOpens: 0 };
}

export async function getSafetyState() {
  const data = await chrome.storage.local.get(KEYS.safety);
  const raw = data[KEYS.safety] || {};
  const day = todayKey();
  const dayCounters =
    raw.day === day ? { ...emptyDayCounters(), ...(raw.dayCounters || {}) } : emptyDayCounters();
  return {
    noticeVersion: Number(raw.noticeVersion) || 0,
    noticeAcceptedAt: raw.noticeAcceptedAt || 0,
    day,
    dayCounters
  };
}

async function saveSafetyState(next) {
  await setLocalSafe({ [KEYS.safety]: next });
}

export async function isUsageNoticeAccepted() {
  const s = await getSafetyState();
  return s.noticeVersion >= USAGE_NOTICE_VERSION && !!s.noticeAcceptedAt;
}

export async function acceptUsageNotice() {
  const s = await getSafetyState();
  await saveSafetyState({
    ...s,
    noticeVersion: USAGE_NOTICE_VERSION,
    noticeAcceptedAt: Date.now()
  });
}

/**
 * 当日是否允许精筛。
 * @returns {{ ok: boolean, reason?: string, safety: object }}
 */
export async function checkDailySafetyGate(platformId = "") {
  const s = await getSafetyState();
  const { riskEvents, liepinDetailOpens } = s.dayCounters;
  if (riskEvents >= DAILY_RISK_LOCK_COUNT) {
    return {
      ok: false,
      reason: `今日已触发平台风控 ${riskEvents} 次（≥${DAILY_RISK_LOCK_COUNT}），精筛已暂停至明天。请勿通过重装规避；账号需休息。`,
      safety: s
    };
  }
  if (platformId === "liepin" && liepinDetailOpens >= DAILY_LIEPIN_DETAIL_OPEN_MAX) {
    return {
      ok: false,
      reason: `今日猎聘已打开详情 ${liepinDetailOpens} 次（上限 ${DAILY_LIEPIN_DETAIL_OPEN_MAX}），请明天再继续以降低封号风险。`,
      safety: s
    };
  }
  return { ok: true, safety: s };
}

/** 记录一次风控事件（短信/行为异常等） */
export async function recordRiskEvent(kind = "risk") {
  const s = await getSafetyState();
  const dayCounters = { ...s.dayCounters, riskEvents: (s.dayCounters.riskEvents || 0) + 1 };
  await saveSafetyState({ ...s, day: todayKey(), dayCounters });
  return {
    ...dayCounters,
    locked: dayCounters.riskEvents >= DAILY_RISK_LOCK_COUNT,
    kind
  };
}

/** 记录一次真正打开详情 */
export async function recordDetailOpen(platformId = "") {
  const s = await getSafetyState();
  const dayCounters = {
    ...s.dayCounters,
    detailOpens: (s.dayCounters.detailOpens || 0) + 1,
    liepinDetailOpens:
      platformId === "liepin"
        ? (s.dayCounters.liepinDetailOpens || 0) + 1
        : s.dayCounters.liepinDetailOpens || 0
  };
  await saveSafetyState({ ...s, day: todayKey(), dayCounters });
  return dayCounters;
}

export async function getProfile() {
  const data = await chrome.storage.local.get(KEYS.profile);
  return { ...DEFAULT_PROFILE, ...(data[KEYS.profile] || {}) };
}

export async function saveProfile(profile) {
  await chrome.storage.local.set({ [KEYS.profile]: profile });
}

function migrateSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.apiKeys = {
    ...DEFAULT_SETTINGS.apiKeys,
    ...(raw?.apiKeys || {})
  };
  // 旧版单 Key → deepseek
  if (!s.apiKeys.deepseek && s.deepseekApiKey) {
    s.apiKeys.deepseek = s.deepseekApiKey;
  }
  s.deepseekApiKey = s.apiKeys.deepseek || "";
  s.directionStrict = false;
  if (s.applyListThreshold == null || s.applyListThreshold === "") {
    s.applyListThreshold = s.favoriteThreshold ?? 80;
  }
  if (!s.llmProvider) s.llmProvider = "deepseek";
  if (s.semanticFit == null) s.semanticFit = true;
  s.weights = normalizeWeights(s.weights);
  return s;
}

export async function getSettings() {
  const data = await chrome.storage.local.get(KEYS.settings);
  return migrateSettings(data[KEYS.settings]);
}

export async function saveSettings(settings) {
  const s = migrateSettings(settings);
  await chrome.storage.local.set({ [KEYS.settings]: s });
}

/** 裁掉 JD 长文，避免断点/会话把 chrome.storage 写爆（默认约 10MB） */
export function compactResultForStorage(r) {
  if (!r || typeof r !== "object") return r;
  const job = r.job || {};
  const score = r.score || {};
  return {
    ...r,
    analysis: String(r.analysis || "").slice(0, 4000),
    job: {
      title: job.title || "",
      company: job.company || "",
      salary: job.salary || "",
      url: job.url || "",
      jobId: job.jobId || "",
      keywords: (job.keywords || []).slice(0, 20),
      // 续跑/展示够用；完整正文以当次内存与导出为准
      responsibilities: String(job.responsibilities || "").slice(0, 800),
      requirements: String(job.requirements || "").slice(0, 800),
      bonus: String(job.bonus || "").slice(0, 400),
      description: String(job.description || "").slice(0, 1200),
      listTitle: job.listTitle || job.title || ""
    },
    score: {
      ...score,
      // 断言证据链较长，存盘只留摘要
      gates: score.gates
        ? {
            status: score.gates.status,
            failed: (score.gates.failed || []).slice(0, 12),
            packId: score.gates.packId
          }
        : score.gates,
      requirements: score.requirements
        ? {
            must: (score.requirements.must || []).slice(0, 24),
            mustMiss: (score.requirements.mustMiss || []).slice(0, 16),
            preferred: (score.requirements.preferred || []).slice(0, 16),
            preferredMiss: (score.requirements.preferredMiss || []).slice(0, 12),
            bonus: (score.requirements.bonus || []).slice(0, 12),
            bonusMiss: (score.requirements.bonusMiss || []).slice(0, 8)
          }
        : score.requirements
    }
  };
}

async function setLocalSafe(obj) {
  try {
    await chrome.storage.local.set(obj);
    return true;
  } catch (e) {
    const msg = String(e?.message || e);
    if (!/quota|Quota|QUOTA/i.test(msg)) throw e;
    // 配额满：清断点再试一次；仍失败则丢掉会话长结果
    await chrome.storage.local.remove([KEYS.runState]);
    try {
      await chrome.storage.local.set(obj);
      return true;
    } catch {
      const slim = { ...obj };
      if (slim[KEYS.listSession]) {
        slim[KEYS.listSession] = {
          ...slim[KEYS.listSession],
          results: (slim[KEYS.listSession].results || []).slice(-30).map(compactResultForStorage)
        };
      }
      if (slim[KEYS.runState]) {
        slim[KEYS.runState] = {
          ...slim[KEYS.runState],
          results: (slim[KEYS.runState].results || []).slice(-30).map(compactResultForStorage),
          sessionResults: (slim[KEYS.runState].sessionResults || []).slice(-30).map(compactResultForStorage)
        };
        delete slim[KEYS.runState].batchResults;
      }
      await chrome.storage.local.set(slim);
      return false;
    }
  }
}

export async function getRunState() {
  const data = await chrome.storage.local.get(KEYS.runState);
  return data[KEYS.runState] || null;
}

export async function saveRunState(state) {
  const results = (state.results || []).slice(-80).map(compactResultForStorage);
  const sessionResults = (state.sessionResults || state.results || [])
    .slice(-120)
    .map(compactResultForStorage);
  await setLocalSafe({
    [KEYS.runState]: {
      version: state.version || 1,
      nextIndex: state.nextIndex || 0,
      target: state.target || 0,
      results,
      // 不再单独存 batchResults（与 results 重复）
      sessionResults,
      order: state.order || 0,
      processedInBatch: state.processedInBatch || 0,
      sinceRest: state.sinceRest || 0,
      deepseekCalls: state.deepseekCalls || 0,
      batchDeepseekCalls: state.batchDeepseekCalls || 0,
      listFingerprint: state.listFingerprint || "",
      seenKeys: (state.seenKeys || []).slice(-500),
      savedAt: Date.now()
    }
  });
}

export async function clearRunState() {
  await chrome.storage.local.remove(KEYS.runState);
}

export async function getListSession() {
  const data = await chrome.storage.local.get(KEYS.listSession);
  const s = data[KEYS.listSession] || null;
  if (!s) {
    return { listCursor: 0, seenKeys: [], fingerprint: "", results: [], order: 0, deepseekCalls: 0 };
  }
  return {
    listCursor: Number(s.listCursor) || 0,
    seenKeys: Array.isArray(s.seenKeys) ? s.seenKeys : [],
    fingerprint: s.fingerprint || "",
    results: Array.isArray(s.results) ? s.results : [],
    order: Number(s.order) || 0,
    deepseekCalls: Number(s.deepseekCalls) || 0
  };
}

export async function saveListSession(session) {
  await setLocalSafe({
    [KEYS.listSession]: {
      listCursor: session.listCursor || 0,
      seenKeys: (session.seenKeys || []).slice(-500),
      fingerprint: session.fingerprint || "",
      // 会话结果已压缩；条数再收紧，游标/seenKeys 才是续跑关键
      results: (session.results || []).slice(-80).map(compactResultForStorage),
      order: session.order || 0,
      deepseekCalls: session.deepseekCalls || 0,
      savedAt: Date.now()
    }
  });
}

export async function clearListSession() {
  await chrome.storage.local.remove(KEYS.listSession);
}

export async function getApplyList() {
  const data = await chrome.storage.local.get(KEYS.applyList);
  return Array.isArray(data[KEYS.applyList]) ? data[KEYS.applyList] : [];
}

function applyRowMatch(row) {
  return Number(row?.total) || 0;
}

function applyRowFit(row) {
  return Number(row?.fitTotal ?? row?.effectiveScore) || 0;
}

/**
 * 满员淘汰：优先分数最低（匹配度 → 契合原分），同分取入列时间最远（最旧）。
 * @returns {number} 应移除的下标
 */
export function pickApplyListEvictionIndex(list) {
  if (!list?.length) return -1;
  let worst = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i];
    const b = list[worst];
    const ma = applyRowMatch(a);
    const mb = applyRowMatch(b);
    if (ma !== mb) {
      if (ma < mb) worst = i;
      continue;
    }
    const fa = applyRowFit(a);
    const fb = applyRowFit(b);
    if (fa !== fb) {
      if (fa < fb) worst = i;
      continue;
    }
    if ((Number(a.createdAt) || 0) < (Number(b.createdAt) || 0)) worst = i;
  }
  return worst;
}

/** 超出上限时反复淘汰最低分+最旧入列，直至 ≤ APPLY_LIST_MAX */
function trimApplyListToMax(list) {
  const out = [...(list || [])];
  while (out.length > APPLY_LIST_MAX) {
    const i = pickApplyListEvictionIndex(out);
    if (i < 0) break;
    out.splice(i, 1);
  }
  return out;
}

function sortApplyListRows(list) {
  return [...(list || [])].sort((a, b) => {
    const ma = applyRowMatch(a);
    const mb = applyRowMatch(b);
    if (mb !== ma) return mb - ma;
    const fa = applyRowFit(a);
    const fb = applyRowFit(b);
    if (fb !== fa) return fb - fa;
    return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
  });
}

export async function saveApplyList(list) {
  const trimmed = trimApplyListToMax(list || []).map((item) => {
    if (!item?.job) return item;
    return compactResultForStorage(item);
  });
  await setLocalSafe({ [KEYS.applyList]: trimmed });
}

export async function upsertApplyListItem(item, threshold) {
  if (!item) return { list: await getApplyList(), added: false };
  if (item.excluded) return { list: await getApplyList(), added: false };
  // 用契合原分判断入库，避免门禁封顶导致高契合岗进不了投递列表
  const scoreForTh =
    item.effectiveScore ??
    (Number.isFinite(Number(item.fitTotal)) ? Number(item.fitTotal) : null) ??
    item.total ??
    0;
  if (scoreForTh < (threshold ?? 80)) return { list: await getApplyList(), added: false };

  const list = await getApplyList();
  const id = item.id;
  const idx = list.findIndex((x) => x.id === id);
  const now = Date.now();
  const prev = idx >= 0 ? list[idx] : null;
  const row = {
    ...item,
    applyStatus: item.applyStatus || (prev?.applyStatus || "未打开"),
    createdAt: prev?.createdAt || item.createdAt || now,
    updatedAt: now
  };
  let evicted = null;
  if (idx >= 0) {
    list[idx] = { ...prev, ...row, createdAt: prev.createdAt || row.createdAt };
  } else {
    // 第 101 条：先去掉分数最低且入列时间最远的一条，再插入
    if (list.length >= APPLY_LIST_MAX) {
      const evictAt = pickApplyListEvictionIndex(list);
      if (evictAt >= 0) evicted = list.splice(evictAt, 1)[0] || null;
    }
    list.unshift(row);
  }

  const trimmed = sortApplyListRows(trimApplyListToMax(list));
  await saveApplyList(trimmed);
  return { list: trimmed, added: true, evicted };
}

export async function removeApplyListIds(ids) {
  const set = new Set(ids || []);
  const list = (await getApplyList()).filter((x) => !set.has(x.id));
  await saveApplyList(list);
  return list;
}

export async function patchApplyListStatus(ids, applyStatus) {
  const set = new Set(ids || []);
  const list = (await getApplyList()).map((x) =>
    set.has(x.id) ? { ...x, applyStatus, updatedAt: Date.now() } : x
  );
  await saveApplyList(list);
  return list;
}

export {
  USAGE_NOTICE_VERSION,
  DAILY_RISK_LOCK_COUNT,
  DAILY_LIEPIN_DETAIL_OPEN_MAX
};
