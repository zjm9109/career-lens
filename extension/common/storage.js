import { DEFAULT_PROFILE, DEFAULT_SETTINGS, APPLY_LIST_MAX } from "./constants.js";

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

export async function getRunState() {
  const data = await chrome.storage.local.get(KEYS.runState);
  return data[KEYS.runState] || null;
}

export async function saveRunState(state) {
  await chrome.storage.local.set({ [KEYS.runState]: state });
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
  await chrome.storage.local.set({
    [KEYS.listSession]: {
      listCursor: session.listCursor || 0,
      seenKeys: (session.seenKeys || []).slice(-500),
      fingerprint: session.fingerprint || "",
      results: (session.results || []).slice(-200),
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
  await chrome.storage.local.set({ [KEYS.applyList]: list.slice(0, APPLY_LIST_MAX) });
}

export async function upsertApplyListItem(item, threshold) {
  if (!item) return { list: await getApplyList(), added: false };
  if (item.excluded) return { list: await getApplyList(), added: false };
  const total = item.total ?? 0;
  if (total < (threshold ?? 80)) return { list: await getApplyList(), added: false };

  const list = await getApplyList();
  const id = item.id;
  const idx = list.findIndex((x) => x.id === id);
  const row = {
    ...item,
    applyStatus: item.applyStatus || (idx >= 0 ? list[idx].applyStatus : "未打开"),
    updatedAt: Date.now()
  };
  if (idx >= 0) list[idx] = { ...list[idx], ...row };
  else list.unshift(row);

  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
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
