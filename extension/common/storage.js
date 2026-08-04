import {
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  APPLY_LIST_MAX,
  normalizeWeights
} from "./constants.js";

const KEYS = {
  profile: "cl_profile",
  settings: "cl_settings",
  runState: "cl_run_state",
  applyList: "cl_apply_list",
  /** 同一筛选列表上的游标：接着往后筛，避免每次从第 1 条重跑 */
  listSession: "cl_list_session"
};

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

export async function saveApplyList(list) {
  const trimmed = (list || []).slice(0, APPLY_LIST_MAX).map((item) => {
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
  if (idx >= 0) list[idx] = { ...prev, ...row, createdAt: prev.createdAt || row.createdAt };
  else list.unshift(row);

  // 有效分（契合原分优先）降序，同分按入列时间新→旧
  list.sort((a, b) => {
    const sa = a.effectiveScore ?? a.fitTotal ?? a.total ?? 0;
    const sb = b.effectiveScore ?? b.fitTotal ?? b.total ?? 0;
    const td = sb - sa;
    if (td !== 0) return td;
    return (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0);
  });
  const trimmed = list.slice(0, APPLY_LIST_MAX);
  await saveApplyList(trimmed);
  return { list: trimmed, added: true };
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
