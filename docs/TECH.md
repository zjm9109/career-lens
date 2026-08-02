# career-lens 技术学习 / 微调手册

面向自己改代码、调分数、跟 Boss 改版。需求说明见 [SPEC.md](./SPEC.md)。

---

## 1. 仓库结构

```
career-lens/
├── README.md                 # 安装与简介
├── LICENSE
├── package.json              # 仅开发时拉 pdfjs；运行扩展不依赖 npm
├── node_modules/             # 可删；扩展使用已拷贝的 vendor
├── docs/
│   ├── SPEC.md               # 产品说明书
│   ├── TECH.md               # 本文件
│   └── *.pdf                 # 本地测试简历（含隐私，勿提交）
└── extension/                # ← Chrome「加载已解压扩展」选这个目录
    ├── manifest.json         # MV3 清单：权限、content_scripts、side_panel
    ├── background.js         # 点击图标打开侧边栏
    ├── icons/                # 扩展图标
    ├── vendor/pdfjs/         # 本地 pdf.js（解析中文 PDF，勿删）
    ├── common/               # 与平台无关的公共逻辑
    │   ├── constants.js      # 默认避雷词、默认权重、阈值默认值
    │   ├── storage.js        # 画像/设置/断点/投递列表
    │   ├── scoring.js        # ★ 规则打分（最常微调）
    │   ├── recommend.js      # 建议分组、硬门槛、DeepSeek 费用估算
    │   ├── deepseek.js       # DeepSeek 提示词与请求
    │   ├── export.js         # 分组导出 MD/Word
    │   ├── job-sections.js   # JD 四块结构化
    │   └── resume-parse.js   # PDF/DOCX/TXT 解析 + 标签预填词典
    ├── platforms/
    │   └── boss/
    │       └── content.js    # ★ Boss DOM 采集 / CL_HEALTH
    └── sidepanel/
        ├── index.html        # 运行/画像/设置/精确分析/投递列表
        ├── style.css
        └── app.js            # ★ 编排：批次、断点、投递列表、导出
```

后期加猎聘/智联：在 `platforms/` 下新建目录，复制 Boss 的消息协议，公共逻辑不动。

---

## 2. 运行时数据流

```
[Boss 页面 content.js]
        ↑ chrome.tabs.sendMessage (CL_LIST / CL_OPEN_INDEX / …)
[sidepanel/app.js]
        → scoring.scoreJob(profile, job, settings)
        → deepseek.analyzeWithDeepseek（未排除且分数≥阈值）
        → content CL_FAVORITE（未排除且分数≥收藏阈值）
        → export.resultsToMarkdown → chrome.downloads
```

画像与设置存在 `chrome.storage.local`：

| Key | 内容 |
|-----|------|
| `cl_profile` | 技能/行业/方向/证书/语言、避雷、注意、简历文本 |
| `cl_settings` | API Key、阈值、批次、导出模式、**权重** |

权重 UI 在「画像」页，和标签并列；持久化仍在 `cl_settings.weights`。

---

## 3. 常改文件速查

| 想改什么 | 改哪个文件 | 提示 |
|----------|------------|------|
| 默认避雷词 | `common/constants.js` → `DEFAULT_AVOID_TAGS` | |
| 默认权重 40/20/15… | `common/constants.js` → `DEFAULT_WEIGHTS` | |
| 技能覆盖率软/硬 | `common/scoring.js` → `softCoverage` / `scoreSkill` | 现用 sqrt 软化 |
| 行业/方向/证书算法 | `common/scoring.js` 各 `score*` | |
| 简历预填词典 | `common/resume-parse.js` → `suggestProfileFromText` 里 `*Dict` | |
| DeepSeek 输出格式 | `common/deepseek.js` → `SYSTEM` | |
| MD / Word 导出 | `common/export.js` | `exportFormat`: md / docx |
| 岗位四块结构化 | `common/job-sections.js` | 标签/职责/任职/加分；纠标题 |
| 点击间隔、批次休息 | `sidepanel/app.js` → `processOneJob` / `runBatch` | |
| Boss 列表/详情选不中 | `platforms/boss/content.js` 选择器 | 用 DevTools 看 class |
| 链接变成搜索页 / 摘要含广告销售 | `content.js` 的 `cleanJobText` / `jobUrlFromId` | SPA 侧栏不改 URL；须裁切页脚 |
| 薪资变成  乱码 | Boss 私有字体防爬 | 能解则解；否则带提示，非接口封锁 |
| PDF 乱码 | 确认用了 `vendor/pdfjs`；扫描件需 OCR（未做） | |

---

## 4. 打分公式（便于手算对照）

```
维度分 ∈ [0,100]
规则分 = Σ(维度分 × 权重%) ，权重自动归一

技能：硬要求命中数/要求数 ×100（默认，如 8/10→80）；「优先」技能不进分母；无硬要求→100
行业/证书/语言：任职要求分句无「优先」→ 硬要求，按命中比例（或 0/100）；仅「优先」→ 不扣分
方向：标题命中 100；任职硬方向按比例；仅正文 70；都无 0
总分：Σ(维度分 × 权重%)，权重在画像页配置并归一

避雷命中 → excluded=true，仍算规则分，不调 DeepSeek，不自动收藏
注意命中 → 只展示
DeepSeek：!excluded && total >= deepseekThreshold（默认 60）
收藏：!excluded && total >= favoriteThreshold（默认 80）且页面未收藏
```

---

## 4.1 如何增加评分规则（推荐改法）

所有规则分只改 **`extension/common/scoring.js`**，入口是 `scoreJob`。

### 例：任职要求「电力行业经验」且无「优先」→ 行业维必须为 0（若画像无电力）

已实现于 `scoreIndustry` + `classifyIndustryMentions`：

1. `extractRequirementsText(job)` 切开「任职要求」段  
2. 按句扫描 `KNOWN_INDUSTRIES`  
3. 句内有「优先/加分」→ soft；有「经验/背景」且无优先 → hard  
4. hard 未命中用户 `profile.industries` → **行业分 = 0**

### 你要加「新行业词」

改 `KNOWN_INDUSTRIES` 数组，例如增加 `"光伏"`。

### 你要加「新的一维分数」（如：年限硬门槛）

1. 新写 `function scoreYears(job, profile) { return { score, detail }; }`  
2. 在 `scoreJob` 里算出来并加权（同时在 `constants.js` 的 `DEFAULT_WEIGHTS` 加一项，画像 UI 加权重输入）  
3. 硬/软判断复用「分句 + 是否含优先」模式，避免和行业逻辑两套风格  

### 你要改「证书必须 / 优先」

仿行业：在 `scoreCertificate` 里对「PMP」等做分句 hard/soft（当前证书维仍偏覆盖率，可按同样模式收紧）。

### 自测（仓库根目录）

```bash
node --input-type=module -e "
import { scoreJob } from './extension/common/scoring.js';
import { DEFAULT_SETTINGS } from './extension/common/constants.js';
const profile = { skills:['PMP'], industries:['金融'], directions:['项目经理'], certificates:['PMP'], languages:[] };
const job = { title:'项目经理', keywords:[], description:'任职要求：3. 有电力行业背景，具备项目管理经验。' };
console.log(scoreJob(job, profile, DEFAULT_SETTINGS).dimensions.industry);
"
```

期望：`score: 0`，detail 含「硬性行业未满足」。

---

## 5. Boss 消息协议（content ↔ sidepanel）

| type | 作用 |
|------|------|
| `CL_PING` | 探测脚本是否注入 |
| `CL_VISIBILITY` | 页面是否可见（不可见则暂停） |
| `CL_BLOCKER` | 是否验证码文案 |
| `CL_LIST` | 返回列表卡片数组 |
| `CL_OPEN_INDEX` | 点击第 i 条并等详情 |
| `CL_SCRAPE_DETAIL` | 刮当前详情 |
| `CL_FAVORITE` | 未收藏则点收藏 |
| `CL_SCROLL` | 列表容器缓慢下滚 |

改平台时保持这套 type，只换实现。

---

## 6. 本地开发步骤

1. 改 `extension/` 下代码  
2. `chrome://extensions` → career-lens → **重新加载**  
3. Boss 页 **刷新**（content script 才会更新）  
4. 侧边栏若缓存旧 UI，关闭再点图标打开  

更新 pdf.js（可选）：

```bash
npm install pdfjs-dist@4.10.38
cp node_modules/pdfjs-dist/build/pdf.min.mjs extension/vendor/pdfjs/
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs extension/vendor/pdfjs/
```

---

## 7. 建议的微调顺序

1. 用「精确分析」粘贴 2～3 个真实 JD，看分项是否合理  
2. 调画像权重 / 标签，而不是先改代码  
3. 仍不准再改 `scoring.js`  
4. 列表刮不到再改 `content.js` 选择器  
