/**
 * 按当前标签页 URL 自动识别招聘平台（无需用户单选）
 */

export const PLATFORMS = {
  boss: {
    id: "boss",
    label: "Boss 直聘",
    contentScript: "platforms/boss/content.js",
    urlPatterns: ["*://www.zhipin.com/*", "*://www.bosszhipin.com/*"],
    hostTest: /zhipin\.com/i
  },
  liepin: {
    id: "liepin",
    label: "猎聘",
    contentScript: "platforms/liepin/content.js",
    urlPatterns: ["*://*.liepin.com/*", "*://www.liepin.com/*"],
    hostTest: /liepin\.com/i
  },
  zhilian: {
    id: "zhilian",
    label: "智联招聘",
    contentScript: "platforms/zhilian/content.js",
    urlPatterns: ["*://*.zhaopin.com/*", "*://www.zhaopin.com/*", "*://sou.zhaopin.com/*"],
    hostTest: /zhaopin\.com/i
  }
};

export function detectPlatformFromUrl(url = "") {
  const u = String(url || "");
  for (const p of Object.values(PLATFORMS)) {
    if (p.hostTest.test(u)) return p;
  }
  return null;
}

export function allPlatformUrlPatterns() {
  return Object.values(PLATFORMS).flatMap((p) => p.urlPatterns);
}
