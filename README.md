# dsh-plugin-obsidian

[![npm](https://img.shields.io/npm/v/dsh-plugin-obsidian)](https://www.npmjs.com/package/dsh-plugin-obsidian)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Yaemikoreal/dsh-plugin-obsidian)](https://github.com/Yaemikoreal/dsh-plugin-obsidian/releases)

把 **DeepSeek Harness（DSH）** 和 **Obsidian** 连起来：让 DSH 里的模型可以直接、快速地**查询**你的 Obsidian 笔记，**写入**（新建 / 覆盖 / 追加 / 按标题插入 / 合并 frontmatter），也能**整理**（移动 / 重命名并自动更新链接，删除默认进 `.trash/` 可恢复）。

- **零依赖**：只用 Node 内置模块，没有构建步骤，装进 profile 就能跑。
- **零配置**：自动从 Obsidian 自己的 `obsidian.json` 里发现仓库（vault），自动读取该仓库的 `.obsidian/` 设置（日记格式、模板等）。
- **离线可用**：直接读文件系统 + 内存索引，Obsidian 关着也能查、能写。
- **在线联动**：如果仓库装了社区插件 **Local REST API**，还能操作正在运行的 Obsidian：打开笔记、读取当前笔记、用 Obsidian 自己的实时搜索、打开日记、列出/执行命令、列标签。API Key 与端口自动从插件配置里读取，不需要手工填写。

---

## 1. 安装

### 方式一：插件市场（推荐）

打开 DSH 的 **设置 → 插件市场**，搜索 `obsidian`，点「安装」即可。

### 方式二：命令行安装

从 GitHub Release 安装预构建 tarball（推荐，秒装、不跑构建脚本）：

```powershell
dsh plugin --profile <你的profile> add https://github.com/Yaemikoreal/dsh-plugin-obsidian/releases/latest/download/dsh-plugin-obsidian.tgz
```

或直接从 GitHub 源码安装：

```powershell
dsh plugin --profile <你的profile> add https://github.com/Yaemikoreal/dsh-plugin-obsidian
```

卸载：

```powershell
dsh plugin --profile <你的profile> remove dsh-plugin-obsidian
```

### 方式三：本地开发（link:）

把本仓库克隆到本地，以 `link:` 方式装进 profile（等价于 GUI 里「设置 → 插件」的安装操作）：

```powershell
dsh plugin --profile <你的profile> add "E:\path\to\dsh-plugin-obsidian"
```

> **关于生效时机**：新增 bundle 行会被正在运行的 DSH 热加载（无需重启即可用上 7 个工具）。
> 但**修改插件源码后必须重启 DSH** 才会加载新代码——ESM 模块缓存会继续返回旧模块（在「设置 → 插件」里禁用/启用本插件也无法绕过它）。
> 如果想让源码改动自动生效，可以在 profile 的 patch 里把本插件目录加进 HMR 的监视根：
>
> ```yaml
> - id: hmr
>   name: '@deepseek-ai/dsh-hmr'
>   config:
>     root:
>       - 'E:\path\to\dsh-plugin-obsidian'
> ```

安装后 11 个工具直接出现在模型可调用列表里，可用 `obsidian_vaults` 确认状态。

### 插件列表里的中文名与中文描述

DSH 的插件页显示的是插件**自己声明**的标题与描述，取自包内的 `locale/<语言>.json`：

```json
{ "meta": { "title": "Obsidian 笔记", "description": "让 DeepSeek Harness 直接搜索、读取和写入 Obsidian 笔记……" } }
```

- 本插件提供 `locale/zh.json`（中文）与 `locale/en.json`（英文）：界面语言为中文时显示中文，英文时显示英文；两者都没有时才回退到 `package.json` 的 `name` / `description`。
- 卡片图标取自 `package.json` 的 `icon`：相对路径的 SVG/PNG/JPEG/WebP，≤256 KiB，且必须留在包目录内。本插件用 `assets/icon.svg`。
- 这些文件必须通过包的 `exports` 暴露（`./locale/en.json`、`./locale/zh.json`、`./package.json`），否则读不到。
- 改完标题/描述**不需要重启**：插件页每次打开都会重新读盘（页面已打开就重新打开一次）。

---

## 2. 工具一览

| 工具 | 作用 |
| --- | --- |
| `obsidian_vaults` | 列出 / 添加 / 切换仓库，查看索引与在线桥接状态 |
| `obsidian_search` | 全文、标签、路径、frontmatter、标题、正则搜索 |
| `obsidian_read` | 读取笔记（行窗口 + frontmatter + 标签 + 标题 + 链接 + 反向链接） |
| `obsidian_list` | 目录树 / 平铺列表 / 标签云 / 文件夹统计 |
| `obsidian_links` | 出链、反向链接、指向不存在笔记的链接 |
| `obsidian_tasks` | 全库收集 `- [ ]` / `- [x]` 任务（状态 / 文本 / 文件夹过滤，带行号可精确改写） |
| `obsidian_write` | 新建 / 覆盖 / 追加 / 前置 / 按标题插入，支持 frontmatter 合并、模板占位符、`@daily` 与 dry-run |
| `obsidian_move` | 移动 / 重命名笔记，自动更新引用它的 wikilink 与 markdown 链接（支持 dry-run） |
| `obsidian_delete` | 删除笔记：默认移入 `.trash/` 可恢复，`permanent: true` 彻底删除；报告悬空反向链接 |
| `obsidian_attach` | 把本地图片 / PDF 等复制进仓库附件目录，返回 `![[...]]` 嵌入链接，可顺手追加到笔记 |
| `obsidian_app` | 操作正在运行的 Obsidian（状态、打开、当前笔记、实时搜索、日记、命令、标签） |

### 查询

```
obsidian_search(query="部署", mode="all", context=1, limit=10)
obsidian_search(query="project", mode="tag")            # 按标签
obsidian_search(query="status:done", mode="frontmatter")
obsidian_search(query="Projects/*.md", mode="path")
obsidian_search(query="(?i)api[_ ]key", mode="regex")
obsidian_search(query="周报", source="app")             # 用 Obsidian 自己的实时搜索
```

`mode`：`all`（默认，全部词命中）/ `any` / `phrase` / `regex` / `tag` / `path` / `frontmatter` / `title`。
其他过滤参数：`folder`、`path`、`exclude`、`tags`、`tag`、`caseSensitive`、`maxMatchesPerFile`、`vault`。

**为什么快**：首次扫描建立「路径 → mtime/size」元数据索引（默认 3 秒 TTL，`indexTtlMs` 可调），已解析笔记按字节预算（默认 48MB）做 LRU 缓存；内容变化（mtime/size 变了）自动失效。重复查询通常几十毫秒。

### 读取

```
obsidian_read(note="Projects/Alpha")                  # 支持文件名 / 路径 / [[wikilink]] / 别名
obsidian_read(note="Home", offset=10, limit=30, backlinks=true)
```

### 写入

```
obsidian_write(note="Inbox/想法", content="# 想法\n\n正文\n")                 # create（默认）
obsidian_write(note="Inbox/想法", mode="append", content="追加一段")
obsidian_write(note="Inbox/想法", mode="prepend", content="> 摘要")
obsidian_write(note="Inbox/想法", mode="insert", heading="待办", content="- [ ] 新任务")
obsidian_write(note="Inbox/想法", mode="overwrite", content="# 全新内容\n")
obsidian_write(note="Inbox/想法", frontmatter={status: "done", owner: null})  # 只改 frontmatter（null = 删除该键）
obsidian_write(note="Inbox/想法", mode="append", content="预览", dryRun=true) # 只预览 diff，不落盘
obsidian_write(note="Inbox/想法", mode="append", content="写完后打开", open=true)
obsidian_write(note="@daily", mode="append", content="10:30 开始写周报")      # 离线日记：今天（或 @daily-2026-10-26）
obsidian_write(note="Meetings/评审会", template="会议记录")                    # 从模板创建（{{title}}/{{date}}/{{time}}）
```

- **`@daily`**：写入日记的快捷方式，路径由仓库自己的日记设置（`.obsidian/daily-notes.json`）计算，**Obsidian 关着也能用**；文件不存在就按日记设置创建。
- **`template`**：从模板文件夹（`.obsidian/templates.json` → folder）读取模板创建笔记，替换 `{{title}}`、`{{date}}`、`{{time}}` 与 `{{date:格式}}` / `{{time:格式}}`；模板自身的 frontmatter 会带过来；不能与 `content` 或非 create 的 `mode` 同时使用。

要点：

- **目标定位规则**：`note` 里含 `/`（或 `\`）时按**精确路径**处理，不存在就新建；不含分隔符的**裸名字**才会按文件名 / wikilink / 别名模糊匹配到已有笔记。这样 `blocker/child.md` 这类显式路径绝不会被悄悄改写到另一个同名笔记里。
- 省略 `mode` 且有 `content` → `create`；省略 `mode` 且无 `content` → 只更新已有笔记的 frontmatter。
- `mode="create"` 遇到已存在的笔记会报错，可用 `ifExists: append|overwrite|skip` 改变行为。
- `mode="insert"` 插入到指定标题所在**小节末尾**；标题不存在时 `headingFallback: end|error`（默认 `end`）。若上一行与插入内容同为列表项，会直接续行而不插入空行。
- `prepend` 会插到 frontmatter **之后**。
- `content` 自带 `---` frontmatter 块时会被识别并规范化，不会重复写两遍。

**写入安全性**：同目录临时文件 + `rename` 原子替换（失败会清理临时文件）；路径必须落在仓库内（拒绝 `..`、绝对路径、NUL）；拒绝 Windows 保留名（`CON`/`NUL`…）与以点或空格结尾的文件名；只允许 `writableExtensions`（默认 `.md/.markdown/.txt`）；`readOnly: true` 时拒绝一切写入；`dryRun` 只返回 diff；文件系统错误会转换成可自纠的提示（如「路径里有个文件不是文件夹」）。

### 整理笔记（移动 / 重命名 / 删除）

```
obsidian_move(note="Projects/Alpha", to="Archive/")                       # 移入 Archive，保留文件名
obsidian_move(note="Projects/Alpha", to="Archive/Alpha V2")               # 移动 + 重命名（缺扩展名自动补 .md）
obsidian_move(note="Projects/Alpha", to="Alpha Renamed", dryRun=true)     # 同文件夹重命名，先预览
obsidian_move(note="Projects/Alpha", to="Archive/", updateLinks=false)    # 只移动，不改任何链接
obsidian_delete(note="Inbox/旧想法")                                       # 默认移入 .trash/Inbox/旧想法.md
obsidian_delete(note="Inbox/旧想法", permanent=true, dryRun=true)          # 预览彻底删除与悬空链接
```

要点：

- **`to` 的三种写法**：以 `/` 结尾（或指向已存在的文件夹）→ 移入该文件夹并保留文件名；带扩展名 → 作为目标完整路径（文件夹不存在会自动创建）；其余情况（无分隔符的裸名字）→ 同文件夹重命名。
- **链接自动更新**（`updateLinks`，默认开）：引用该笔记的 wikilink / markdown 链接会被改写，被移动笔记自己的相对链接也会修正，行为对齐 Obsidian 自带的重命名。改写规则：**写死路径的链接**在路径失效后改写为新位置（优先最短可解析形式）；**裸名字链接**只要仍能解析到该笔记就保持原样（出现同名歧义时改写为带路径的消歧形式）；代码块与行内代码里长得一样的文本不会被误改。
- **删除默认可恢复**：默认移入仓库的 `.trash/`（保留原子目录避免重名，加数字后缀处理冲突）；`permanent: true` 才会真正删除文件。两种方式都会在结果里**报告将悬空的反向链接**，方便随后清理。
- 安全性与写入一致：路径必须落在仓库内、拒绝点目录（不能把笔记移进 `.trash/` 或 `.obsidian/` 绕过索引）、目标已存在时报错、`readOnly` 仓库拒绝整理、`dryRun` 只返回计划不改文件。

### 任务收集

```
obsidian_tasks()                                    # 全库未完成任务（默认 status "open"）
obsidian_tasks(status="all", folder="Projects")     # 指定文件夹 / 全部状态
obsidian_tasks(status="all", query="部署", limit=50)
```

每条任务带 `path`、`line`（1-based 行号）、`status`（`open` / `done` / `other`，`[/]` 这类自定义标记归入 `other` 且只在 `all` 里出现）和原文；代码块里的假任务不会误报。改任务状态：按 `path` + `line` 读到原文后改写该笔记即可。

### 附件

```
obsidian_attach(source="E:\\pics\\chart.png")                        # 复制进仓库附件目录，返回 ![[chart.png]]
obsidian_attach(source="...", note="@daily")                         # 复制并把嵌入链接追加进今天的日记
obsidian_attach(source="...", folder="Images/Deep", name="架构图")     # 自定义落点与文件名
```

落点遵守 Obsidian 自己的附件设置（`.obsidian/app.json` → `attachmentFolderPath`：`""`/`"/"` 仓库根、`"./"` 所链接笔记的文件夹、其余为固定文件夹），每次调用可用 `folder` 覆盖；重名自动加 `-1` 后缀。只接受本地文件（网络图片请先下载到本地）；允许的扩展名默认 `png/jpg/jpeg/gif/webp/svg`，可用配置 `attachmentExtensions` 调整。dry-run 预览落点。

### 在线联动（Local REST API）

```
obsidian_app(action="status")
obsidian_app(action="open", note="Projects/Alpha")
obsidian_app(action="active")                       # 当前正在编辑的笔记
obsidian_app(action="search", query="部署", contextLength=120)
obsidian_app(action="daily", date="2026-10-10")
obsidian_app(action="command", query="template")    # 列出命令
obsidian_app(action="command", command="editor:save-file")
obsidian_app(action="tags")
```

桥接不可用时会给出可执行的提示（例如「未安装 Local REST API 插件」），文件系统类工具不受影响。

---

## 3. 配置（可选）

不配置也能用：自动发现 Obsidian 注册表里最近打开的仓库。

需要指定仓库或调整行为时，在 profile 的 patch 文件（`%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`）里加：

```yaml
- id: obsidian
  name: dsh-plugin-obsidian
  config:
    vault: 'C:\Users\you\Documents\My Vault'                   # 固定活动仓库
    vaults:                                                    # 额外仓库
      - 'D:\Notes\Work'
    excludes:                                                  # 额外排除的 glob
      - 'templates/**'
    indexTtlMs: 3000
    maxCacheBytes: 50331648
    readOnly: false
    dailyFolder: Daily
    dailyFormat: YYYY-MM-DD
    attachmentFolder: attachments              # 附件落点覆盖（默认跟随 .obsidian/app.json）
    attachmentExtensions: ['.png', '.pdf']     # 附件允许的扩展名（默认 png/jpg/jpeg/gif/webp/svg）
    # rest:
    #   enabled: true
    #   baseURL: http://127.0.0.1:27123
    #   apiKey: '...'      # 一般不需要，自动从插件 data.json 读取
```

配置会在挂载时校验，写错会明确报错（未知键也会报错）。切换/新增仓库后会把选择持久化到 `%USERPROFILE%\.dsh\obsidian-plugin.json`。

> 已知限制：DSH 的插件设置页只会为 zod 定义的配置渲染表单，本插件为了零依赖用的是 Standard Schema，所以那里显示为 *unsupported*（不影响使用，配置写在上面的 YAML 里即可）。

---

## 4. 故障排查

| 现象 | 处理 |
| --- | --- |
| 提示找不到仓库 | 先在 Obsidian 里打开一次该仓库；或用 `obsidian_vaults(action="add", path="...")` |
| 搜索不到刚写的内容 | 索引默认 3 秒 TTL；`obsidian_vaults(action="status", refresh=true)` 可强制刷新 |
| `obsidian_app` 说桥接不可用 | 确认 Obsidian 正在运行，且「设置 → 第三方插件」启用了 **Local REST API** |
| 改了源码没生效 | 重启 DSH 桌面端（ESM 模块缓存） |
| 写入报 `not writable` | 该扩展名不在 `writableExtensions` 内，或仓库被设为 `readOnly` |

---

## 5. 开发与测试

```powershell
cd dsh-plugin-obsidian
node --test        # 71 个测试
```

测试覆盖：YAML/frontmatter 往返、标签/链接/标题解析、索引与缓存失效、8 种搜索模式、写入的 5 种模式与 `ifExists`、`@daily` 快捷方式、模板占位符渲染、移动的链接改写（裸名/路径/嵌入/代码块豁免/相对链接修正）、删除的回收站与冲突后缀、附件落点与重名后缀、任务收集与过滤、路径逃逸 / 保留文件名 / 只读拒绝、写入目标不被同名笔记劫持、工具参数校验、**用 DSH 自己的 JSON-Schema 校验器校验每个工具的 `parameters` 与 `output.schema` 及真实返回值**、UI 卡片呈现函数的纯函数性，以及针对本机真实 Obsidian 仓库的在线测试：2 个文件系统测试（Obsidian 关着也跑）和 3 个需要 Local REST API 的桥接测试（Obsidian 未运行或未装插件时自动跳过）。

目录结构：

```
lib/index.js     Cordis 插件入口：配置 schema、仓库发现、活动仓库与在线桥接的状态管理
lib/tools.js     11 个工具的 schema、执行体、render 与 UI 卡片
lib/vault.js     仓库索引、搜索、读取、写入、移动/删除、附件、任务、链接、日记
lib/markdown.js  frontmatter(YAML 子集)、标签、wikilink、标题解析
lib/rest.js      Obsidian Local REST API 客户端
lib/util.js      路径安全、glob、参数校验等工具函数
```

### 有意不做的事

- 删除默认走 `.trash/`（与 Obsidian 本地回收站一致）而不是直接删文件；彻底删除需要显式 `permanent: true`。
- 不修改 `.obsidian/` 下的配置，也不把笔记移入点目录。
- 不跟随仓库内指向外部的符号链接（路径检查基于字符串解析）。

---

## 6. 许可

[MIT](LICENSE)

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
