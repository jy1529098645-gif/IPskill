# 小红书内容诊断工具箱

一个纯静态网页,在浏览器里直接跑 13 个内容诊断 skill,帮你做选题、起标题、查 AI 味、找对标、优化开头。

基于 [dontbesilent2025/dbskill](https://github.com/dontbesilent2025/dbskill) 的 17 个 skill 精选打包,把跟内容诊断无关的 4 个 skill 隐藏。

> **永久公网地址**(GitHub Pages 托管,7×24 在线):
> 👉 **https://jy1529098645-gif.github.io/IPskill/**

---

## 1. 整体架构

```
浏览器
  ├─ index.html  →  UI 框架(Tailwind CDN + marked CDN)
  ├─ app.js      →  状态管理 + 渲染 + Anthropic API 调用
  └─ skills-data.js  →  17 个 SKILL.md + 10 个知识包 + 高频概念词典(打包产物)
                ↓
        直连 https://api.anthropic.com/v1/messages
        (用 anthropic-dangerous-direct-browser-access: true 头突破 CORS)
                ↓
              Anthropic 服务器(Claude 模型推理)
```

**没有后端**。所有 LLM 调用是浏览器 → Anthropic 直连,你的 API key、对话内容都不经过任何中间服务器。

## 2. 17 个 skill 内置完整度

| 资源 | 是否已嵌入 system prompt | 备注 |
|---|---|---|
| 17 个 SKILL.md | ✅ | 切到哪个 skill 就加载哪个 |
| 5 × 2 = 10 个 Skill 知识包 .md | ✅ | 只对 diagnosis/benchmark/content/action/deconstruct 这 5 个 skill 注入,因为只有它们的 SKILL.md 引用了知识包 |
| 高频概念词典.md (3KB) | ✅ | 全局注入,所有 skill 共用术语校准 |
| atoms.jsonl (4176 条原子) | ❌ 故意跳过 | 原子是知识包的源材料,已经被 5 个知识包提炼覆盖,再加是冗余,还会让 prompt 翻倍变贵 |

**结论:17 个 skill 的所有"开箱即用"能力都接进来了。**

## 3. 消息级操作(鼠标悬停消息出现)

| 按钮 | 哪里出现 | 干嘛 |
|---|---|---|
| 复制 | 所有消息 | 把消息文字复制到剪贴板 |
| 编辑 | 用户消息 | 重新编辑这条 + 删除之后的对话,改完点发送 |
| 🔄 重新生成 | 最后一条助手消息(永远可见) | 同样上下文让 LLM 换个回答 |
| 复制 | 代码块右上角 | 一键复制代码块内容,无需手动选 |

**对话标题改名**:左侧对话列表里**双击标题**就能改,Enter 保存,Esc 取消。

## 4. 界面每一块在干嘛

### 顶部 header(从左到右)

| 元素 | 干嘛 | 原理 |
|---|---|---|
| `☰` | 移动端切换侧栏显示/隐藏 | DOM class toggle |
| `dbskill` 标题 | 装饰 | — |
| **项目** 输入框 | 用来隔离不同生意的对话(比如 `AcademiCats`、`线下课`) | 项目名跟随新建的对话存进去,影响存档文件名,也用来过滤侧栏对话列表 |
| **模型** 下拉 | Sonnet 4.6(默认推荐)/ Opus 4.7(最强最贵)/ Haiku 4.5(最快最便宜) | 直接传给 `model` 字段 |
| 💾 **存档** | 把当前对话下载成一个 `.json` 文件 | 序列化当前对话的 messages、skill、project、createdAt 等元信息 |
| 📂 **恢复** | 上传一份 `.json` 存档,作为**新对话**加载到当前界面 | 反序列化 + 创建新 conversation 记录 |
| 📊 **报告** | 多选 `.json` 存档 → 自动切到 `dbs-report` skill → 把存档拼成 user message → 自动调用 LLM 合并 | 模拟原版的 dbs-report 工作流 |
| 🗑️ **删除对话** | 删除当前对话(不可撤销) | 从 state.conversations 里删掉,自动切到下一个 |
| ⚙️ **设置** | API key、max tokens、是否加载知识包、是否流式 | 全部存浏览器 localStorage |

### 左侧 sidebar

**＋ 新对话**(顶部黑色大按钮)
- 用当前选中的 skill 创建一个新对话,切到它,清空输入框

**对话历史** 区域
- 显示所有历史对话,按"最近活动"排序,最新在上
- 每行:[skill 图标] 标题 / 项目名 · 时间 · 消息条数
- 鼠标悬停出现 × 按钮 → 删除该对话
- 点击 → 切到该对话(自动同步 skill 选择)
- 右上"仅本项目"勾选框 → 只显示当前项目的对话

**Skill 工具箱(17)** 区域
- 分 5 组:主入口 / 诊断 / 状态 / 基建 / 聊天室
- 标题可点击 → 折叠/展开整个 skill 列表
- 点某个 skill:
  - 如果当前项目下已经有该 skill 的对话 → 加载最近一份
  - 否则 → 创建新对话

### 中间聊天区

**顶部 skill 头条**:`[图标] [skill 名称] · [对话标题]` 和 `项目: xxx`

**消息流**(用户右、助手左):
- 用户消息:深色气泡,纯文本(不解析 markdown,避免歧义)
- 助手消息:白色气泡,**marked.js 渲染 markdown**(代码块、表格、列表、引用全支持)
- 图片附件:缩略图(最大 260×260),点击新窗口放大
- PDF 附件:灰色 `📄 PDF 附件` 标签
- 鼠标悬停助手消息,左下出现"复制"按钮

**底部输入区**:
- 📎 上传按钮 + 拖拽 + 粘贴(三种方式上传,见下方"附件")
- 文本框:Enter 发送,Shift+Enter 换行,中文输入法 isComposing 状态会跳过
- 发送 / 停止按钮:流式输出过程中可按"停止"中断

### 设置面板(⚙️)

| 选项 | 默认 | 影响 |
|---|---|---|
| Anthropic API Key | 空 | 必填,没它无法对话 |
| 最大 token | 8192 | 单次回复上限,大问题调到 16384,简单问题 2048 省钱 |
| 加载完整知识包 | ✅ 开 | 关闭后 diagnosis 等 5 个重型 skill 只用 SKILL.md(便宜 70% 但效果差) |
| 流式输出 | ✅ 开 | 关掉变成等完整响应再一次性显示 |

## 4. 对话数据存在哪 / 多对话机制

### 存哪

**浏览器 localStorage 一个 key:`dbskill.v1`**,JSON 序列化整个 state 对象。结构:

```js
{
  apiKey: 'sk-ant-...',       // 你填的 key,只在本机
  project: 'AcademiCats',     // 当前项目名
  model: 'claude-sonnet-4-6',
  maxTokens: 8192,
  loadKnowledge: true,
  streaming: true,
  currentSkill: 'dbs-diagnosis',
  conversations: {            // ← 所有对话历史
    'c_abc123': {
      id: 'c_abc123',
      skill: 'dbs-diagnosis',
      project: 'AcademiCats',
      title: '我想做个小红书账号...',  // 自动从首条用户消息取前 30 字
      createdAt: '2026-05-11T...',
      updatedAt: '2026-05-11T...',
      messages: [{ role, content }, ...]
    },
    ...
  },
  activeId: 'c_abc123',       // 当前激活对话
  filterByProject: false,     // 侧栏是否只显示本项目对话
  skillSectionOpen: true,
}
```

**特点:**
- 完全本机,不上传任何服务器
- 关浏览器再开,数据还在
- 换浏览器/换电脑就没了 → 用 💾 存档把重要的对话导出为 .json,在新机器上 📂 恢复
- 容量上限 **~5MB**(各浏览器略不同)。文本对话很容易塞几百条,但**图片/PDF 是 base64 编进 messages 的**,几张高清图就会爆 → 爆了顶部会闪一个警告,这时一定要 💾 存档下载

### 多对话工作机制

**核心模型:每个对话是独立单元**,绑定一个 skill + 一个 project。切对话 = 切 skill。

**关键交互:**

| 动作 | 效果 |
|---|---|
| 点 `＋ 新对话` | 用当前 skill 建新对话,清空消息 |
| 点 sidebar 里某个 skill | 找该 skill 在当前项目下最近的对话 → 加载;没有 → 新建 |
| 点 sidebar 里某条对话 | 切到那条对话(自动同步 skill 和项目显示) |
| 改顶部 "项目" 输入框 | 影响新对话的归属;勾"仅本项目"后过滤侧栏列表 |
| 发送消息 | 推到当前对话,`updatedAt` 自动更新,自动重新排序到列表顶部 |
| 删除对话 (× 或 🗑️) | 不可撤销,从 state 移除 |

### 旧数据迁移

之前版本用 `state.sessions = { skillName: [messages] }` 单 session 模型。新版本启动时自动迁移:每个非空 skill session 转成一条 conversation 记录,标题从首条消息取。**升级后老对话不会丢**。

## 5. system prompt 是怎么拼的(skill 工作原理)

每次发请求时,前端动态拼一个 system prompt 传给 Claude API:

```
[SKILL.md 全文,去掉 frontmatter]

---
# 深度参考资料(仅当此 skill 有知识包)
## diagnosis_公理与诊断框架.md
... (228KB)
## diagnosis_问题消解案例库.md
... (87KB)

---
# 高频概念词典(全局术语校准,所有 skill 共用)
... (3KB)

---
# 当前会话上下文
- 当前项目: AcademiCats
- 当前 skill: dbs-diagnosis
- 你正在通过一个浏览器前端运行,无法访问本地文件系统...
```

整个 system prompt 包裹在一个带 `cache_control: { type: 'ephemeral' }` 的 block 里 → **启用 Anthropic prompt caching**,5 分钟 TTL,同一对话来回问只在首条付全价。

| skill 类型 | system prompt 大小 | 首条估算成本(Sonnet 4.6) |
|---|---|---|
| diagnosis / content / deconstruct(带大知识包) | 250-350KB ≈ 60-85k tokens | $0.18-0.25 |
| benchmark / action(带较小知识包) | 90-120KB ≈ 20-30k tokens | $0.06-0.10 |
| 其他 12 个(只有 SKILL.md + 词典) | 5-35KB ≈ 1-9k tokens | $0.003-0.03 |
| **后续每条**(命中 prompt cache) | 一样大但只 10% 价格 | 多数 $0.005-0.03 |

## 6. 上传文件给 skill 看

输入框左侧 📎,或**拖拽到输入区**,或**输入框内 Ctrl+V 粘贴**。

| 类型 | 上限 | 怎么处理 |
|---|---|---|
| 纯文本(.txt/.md/.json/.csv/.js/.py/.html/.yaml/.ps1...) | 2MB(超了会提示确认) | 直接拼到消息文字里,用 \`\`\` 包裹 |
| 图片(png/jpg/webp/gif) | 5MB / 张 | 走 Claude Vision,`image` content block,LLM 真能看 |
| PDF | 32MB / 个 | 走 Claude Documents,`document` content block,识文字+布局 |

不支持 docx/xlsx/pptx/视频/音频 — 浏览器原生读不了。要用先转 PDF / 纯文本。

## 7. 文件清单

```
H:\IPskills\dbskill-frontend\
├── index.html        # UI 框架(8.7KB)
├── app.js            # 全部前端逻辑(39KB)
├── skills-data.js    # 自动生成 — 17 SKILL.md + 10 知识包 + 词典(644KB)
├── build.mjs         # 打包脚本,`node build.mjs` 重生成 skills-data.js
└── README.md         # 这份文档
```

**升级 skill 内容**:`cd H:\IPskills\dbskill && git pull` 后,`cd ..\dbskill-frontend && node build.mjs`,刷新浏览器即可。

## 8. 公网分享(已部署)

**永久 URL:** https://jy1529098645-gif.github.io/IPskill/

托管在 **GitHub Pages** 免费档:
- 24/7 在线,不依赖本机电脑是否开机
- URL 永久不变
- 全球 CDN 加速
- 每次 `git push` 到 `main` 分支,Pages 会自动重新部署(约 1-2 分钟)

更新 skill 内容流程:

```powershell
cd H:\IPskills\dbskill && git pull          # 1. 拉最新的 dbskill 内容
cd ..\dbskill-frontend && node build.mjs    # 2. 重打包 skills-data.js
git add skills-data.js && git commit -m "Update skills" && git push   # 3. 推到 GitHub,Pages 自动重新发布
```

## 9. 安全注意

- API key 只在浏览器 localStorage,**绝对不要在公开仓库 commit 这个项目时连带提交**(目前 key 也没写在代码里)
- 别在你不信任的电脑/共享浏览器里填 key
- 公网 URL 是 BYOK 模型 — 别人访问时**填自己的 key**,不会动你的 key
- 文件上传的图片/PDF 会作为 base64 进入 Anthropic 请求,跟普通 API 调用一样的隐私级别,**不会上传到我或者 dontbesilent**

## 10. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 点发送报 401 | API key 没填 / 填错 / 账户没钱 |
| 报 CORS / 403 | 检查浏览器版本,Anthropic 用 `anthropic-dangerous-direct-browser-access: true` 突破 CORS,IE/旧 Edge 不支持 |
| 流式输出卡死 | 试关闭流式开关用非流式 |
| 顶部闪"存储已满" | 图片/PDF 太多,马上 💾 存档下载,然后删几条旧对话 |
| 模型 ID 报错 | 模型 ID 已升级到 4.6/4.7,如果哪天 Anthropic 改名,改 `index.html` 里 model select 的 value |
| 切 skill 后对话变了 | 这是设计 — 每对话绑定一个 skill,切 skill 会找/建该 skill 的对话 |

## 11. 改进想法(以后可做)

- 对话标题手动编辑
- 对话内搜索
- 导出全部对话为 zip
- 接 Anthropic embeddings 做 atoms.jsonl 的 RAG 检索
- GitHub Pages 永久部署(免依赖你本机)
- 暗色主题
- 多账户切换(切 API key)
