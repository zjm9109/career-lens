# career-lens 技术学习 / 微调手册

面向自己改代码、调分数、跟 Boss 改版。  
需求：[SPEC.md](./SPEC.md)（v0.3）· 本轮增量：[CHANGELOG.md](./CHANGELOG.md)

---

## 1. 仓库结构

```
career-lens/
├── README.md
├── LICENSE
├── package.json
├── images/                   # 安装说明截图（仓库根）
├── docs/
│   ├── SPEC.md               # 产品说明书 v0.3
│   ├── TECH.md               # 本文件
│   ├── CHANGELOG.md          # ★ 本轮增加内容与后续方向
│   └── *.pdf                 # 本地测试简历（gitignore，勿提交）
└── extension/                # ← Chrome「加载已解压扩展」选这个目录
    ├── manifest.json         # MV3（0.3.0，含 unlimitedStorage）
    ├── background.js
    ├── icons/
    ├── vendor/pdfjs/
    ├── common/
    │   ├── constants.js      # 默认避雷、权重、画像/设置默认
    │   ├── storage.js        # ★ 断点压缩 / 配额保护
    │   ├── pillars.js        # ★ 契合四维定义与权重迁移
    │   ├── semantic-score.js # ★ embedding / LLM 语义四维
    │   ├── scoring.js        # ★ 或选单元、PM 隐含、福利过滤、合并语义分
    │   ├── gates.js          # 硬门槛门禁（PASS/FAIL）
    │   ├── packs/            # 职业包（展示适合岗位 + 无 Key 域兜底）
    │   │   └── it-delivery-pm.js
    │   ├── profile-report.js # 规则侧写 + AI 侧写
    │   ├── recommend.js      # 建议分组、待复核
    │   ├── llm.js            # 多模型 Chat Completions
    │   ├── export.js
    │   ├── job-sections.js   # ★ 猎聘顶栏/公司简介裁切
    │   ├── resume-parse.js
    │   └── platform.js
    ├── platforms/
    │   ├── boss|liepin|zhilian/content.js  # 猎聘：分页、风控、职位介绍就绪
    └── sidepanel/
        ├── index.html
        ├── style.css
        └── app.js            # scoreJobFull、猎聘节奏、checkpoint
```

---

## 2. 运行时数据流（v0.3）

```
简历 → 标签 + 规则侧写（必）/ AI 侧写（可选）→ 保存画像
岗位 → scoreJobFull：
         1) scoreJob 规则四维（无 Key 兜底）+ 硬门槛
         2) 有 Key → semantic-score（向量或 LLM）合并四维；域语义低 → 门禁 FAIL
         3) getRecommendation：避雷 / 待复核 / 建议 / 谨慎
AI：按 effectiveFitScore(fitTotal) ≥ 分析阈值
收藏：仅「建议投递」且达收藏阈值
投递列表：effectiveFitScore ≥ 入库阈值；可导出 CSV
```

| Key | 内容 |
|-----|------|
| `cl_profile` | 标签、避雷、简历文本、`careerPackId`、`profileReport` |
| `cl_settings` | API Keys、阈值、批次、导出、权重 |

---

## 3. 常改文件速查

| 想改什么 | 改哪个文件 |
|----------|------------|
| 门禁规则（证书/语言/年限/域） | `common/gates.js` |
| 封顶分 35 | `gates.js` → `GATE_SCORE_CAP` |
| 职业包适合岗位 / 无 Key 域词 | `common/packs/it-delivery-pm.js` |
| 规则契合 + 合并语义 | `common/scoring.js` |
| 侧写文案与结构 | `common/profile-report.js` |
| 契合四维定义/权重 | `common/pillars.js` |
| 语义/向量打分 | `common/semantic-score.js` |
| 导出 MD/Word / 投递 CSV | `common/export.js` |
| 侧栏编排 | `sidepanel/app.js` |

---

## 4. 打分与门禁

```
硬门槛（规则）：证书 / 年限 / 工作语言
契合四维：角色 25 / 领域 30 / 能力 30 / 资质 15
  有 Key → semantic-score（OpenAI/通义 embedding 余弦；否则 LLM JSON）
  无 Key → 规则映射 + 职业包 domainMustHints 兜底
领域语义分 <35 → 域门禁 FAIL（替代写死「每个行业一个大 JSON」）
fitTotal = Σ(四维 × 权重)；门禁 FAIL → total=min(fit,35)
JD具体度偏低 → 缩放/封顶；稀疏 JD 不得「建议投递」

需求单元（scoring.js）：
  「至少一种 / A或B」→ mode:any，命中其一即覆盖
  能力分 = 已覆盖单元 / 全部单元
  PM 背景 → 评审会/归档/复盘等 routine 隐含命中
  福利 chips 不进 must
```

待复核：`REVIEW_FIT_HIGH=70`（`recommend.js`）。

### 自测门禁（仓库根目录）

```bash
node --input-type=module -e "
import { scoreJob } from './extension/common/scoring.js';
import { DEFAULT_SETTINGS } from './extension/common/constants.js';
const profile = {
  skills:['项目管理'], industries:['金融'], directions:['项目经理'],
  certificates:['PMP'], languages:[], yearsExperience: 8, resumeText:''
};
const job = {
  title:'热力项目经理', keywords:[],
  requirements:'任职要求：1. 持有一级机电建造师证书；2. 英语可作为工作语言。'
};
const s = scoreJob(job, profile, DEFAULT_SETTINGS);
console.log({ total:s.total, fitTotal:s.fitTotal, gate:s.gateStatus, failed:s.gateFailed });
"
```

期望：`gate: 'fail'`，`total ≤ 35`，失败项含证书与语言。

---

## 5. Boss / 猎聘 / 智联消息协议

| type | 作用 |
|------|------|
| `CL_PING` / `CL_VISIBILITY` / `CL_BLOCKER` | 探测与暂停 |
| `CL_LIST` / `CL_OPEN_INDEX` / `CL_SCRAPE_DETAIL` | 列表与详情 |
| `CL_FAVORITE` / `CL_SCROLL` | 收藏与滚动 |
| `CL_NEXT_PAGE` | 猎聘分页翻页（列表整页替换） |

### 本地存储配额

`chrome.storage.local` 默认约 10MB。断点若反复写入完整 JD 会触发 `Resource::kQuotaBytes quota exceeded`。  
已启用 `unlimitedStorage`，并对 `cl_run_state` / `cl_list_session` 做结果压缩与去重；仍满时可点「从头」或清除扩展数据。

### 猎聘风控注意

- 猎聘约 15–20 条/页，靠页码翻页，不是无限下拉。  
- 连开后台 `/job/` 详情过快易触发 `safe.liepin.com`「账号行为异常」短信验证。  
- 侧栏对猎聘：条间隔约 8–14s、每 8 条休息约 45s；详情页若进风控则立即暂停。  
- 建议本批≤8；触发后先完成短信验证再「继续/续跑」。

---

## 6. 本地开发步骤

1. 改 `extension/`  
2. `chrome://extensions` → **重新加载**（权限含 `unlimitedStorage` 时需确认）  
3. 招聘站页面 **刷新**  
4. 侧边栏关掉再开  

若日志出现 `Resource::kQuotaBytes quota exceeded`：已做压缩仍满时，点「从头」或扩展页清除本扩展数据。

---

## 待办（Roadmap）

完整说明见 [CHANGELOG.md](./CHANGELOG.md)。当前优先：

1. **评测集固化**（热力建造师、压裂英语、AI 漫剧、汽车悬架 PM、空岗套话、或选句、PM 隐含）  
2. **语义缓存 / 本地 embedding**，降成本与 Key 依赖  
3. **猎聘稳态**：可配间隔、翻页游标、风控后续跑体验  
4. **断言证据链 UI**：JD↔简历逐条对照  
5. **稀疏 JD / 中性维**再收紧；**UNKNOWN** 严/松可配  
6. 侧写版本号；职业包保持轻量（展示 + 无 Key 兜底）  
