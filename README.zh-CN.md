# feishu-doc-grabber

[English](README.md) · **简体中文**

面向飞书 / Lark 文档的命令行导出工具。在 macOS 上，`feishu-grab` 会直接复用你日常使用的 Google Chrome 登录态。它通过 Chrome 的 AppleScript 接口运行，无需安装浏览器扩展、复制配置目录、开启远程调试端口或重新登录。

## 安装

通过 [Homebrew](https://brew.sh/) 安装：

```bash
brew install Popcornnnnnnnn/tap/feishu-grab
feishu-grab
```

仅支持 macOS。Homebrew 会自动安装 Node.js、手册页、Shell 自动补全、`feishu-grab`、`feishu-grab-mcp` 与 `feishu-chrome`。

更新方法：

```bash
feishu-grab upgrade
# 或手动通过 Homebrew 更新：
brew update
brew upgrade feishu-grab
```

交互式终端运行每 24 小时最多检查一次 GitHub Releases，且不会阻塞 CLI 执行。设置 `FEISHU_GRAB_NO_UPDATE_CHECK=1` 可关闭更新提示。

若从本源码目录进行开发，请使用 Node.js 22.12 或更高版本：

```bash
npm install
npm link
```

在日常使用的 Chrome 中打开任意飞书 / Lark 文档。首次使用前请开启一次 **显示 → 开发者 → 允许 Apple 事件中的 JavaScript**。若 macOS 弹出询问，请在 **系统设置 → 隐私与安全性 → 自动化** 中允许你的终端控制 Google Chrome。这些权限仅用于让本地自动化在 Chrome 页面中运行 JavaScript，CLI 不会自动开启它们。Chrome 官方已[说明此设置](https://www.chromium.org/developers/applescript/)。

## 使用方法

最简单的方式完全不需要担心 Shell 引号转义：

```bash
feishu-grab                                   # 粘贴链接或分享文本；直接按回车将导出当前活动的 Chrome 标签页
feishu-grab --folder                          # 粘贴链接并保存到当前目录
feishu-grab --folder ~/Exports
feishu-grab 'https://example.feishu.cn/wiki/TOKEN' --folder
```

你还可以直接导出当前 Chrome 文档、运行交互式或管道批量导出、配置默认输出文件夹，以及零参数重试未完成的文档：

```bash
feishu-grab current --folder                  # 将当前活动的 Chrome 标签页导出到当前目录
feishu-grab batch                             # 粘贴多个链接或分享文本；输入空行开始导出
feishu-grab batch 'URL1' 'URL2' --folder
feishu-grab batch --folder < urls.txt
feishu-grab retry                             # 重试最近一次导出中失败或未完成的文档
feishu-grab retry ./exports/export-report.json
feishu-grab config                            # 查看默认输出目录
feishu-grab config --folder                   # 设为每次默认保存到当前工作目录
feishu-grab config --folder ~/Exports         # 设为固定输出目录
feishu-grab config --reset                    # 重置默认输出回 ~/Downloads
feishu-grab doctor                            # 检查 Chrome AppleScript 连接状态
```

若未全局安装，可使用 `node /path/to/feishu-doc-grabber/cli.mjs` 并传入相同参数。`npm run grab -- <url> --folder` 同样使用日常 Chrome 模式。

日常 Chrome 模式支持将 `/docx/`、文档型 `/wiki/` 与 `/docs/` 链接（包括含 URL 的飞书分享文本）导出为 Markdown。它会复用已打开的文档标签页，或在同站点已有 Chrome 窗口（否则是最前置 Chrome 窗口）中打开临时标签页。若有多个浏览器配置，请将目标已登录配置的窗口保持在前台。现有标签页会被完整保留，仅关闭临时导出标签页。导出全程须保持 Chrome 运行。`doctor` 仅检查自动化连接；实际导出时才会校验文档权限与服务端认证。

请求在 Chrome 内部带着正常登录态执行。日常模式绝不读取 Cookie、密码、配置数据库或 LocalStorage，也不会越权获取额外文档访问权限。浏览器 CORS 限制、受 CSRF 保护的读取接口、不支持的内容块以及媒体下载失败都会通过完整性校验如实报告；生成了文件并不自动代表导出完整。PDF、DOM HTML、网络抓取与渲染兜底请使用下方的 `--browser isolated`。

## 命令与参考

```bash
feishu-grab --help
feishu-grab help export
feishu-grab --version
feishu-grab export <url> --folder ./exports
feishu-grab batch --list urls.txt --folder ./exports
feishu-grab current --folder
feishu-grab retry
feishu-grab config --json
feishu-grab doctor --json
feishu-grab report ./exports/export-report.json --json
feishu-grab completion zsh
man feishu-grab
```

Homebrew 会安装手册页以及 bash/zsh/fish 自动补全脚本。`completion` 仅打印补全定义，不会修改你的 Shell 配置文件。
`--folder [dir]` 保存到 `dir`，若省略则保存到当前工作目录（智能前瞻会将 `--folder URL` 识别为当前目录）。
`--out`/`-o`、`--format`/`-f`、`--timeout`、`--browser`、`--list` 与 `--retry` 接受独立参数值；长选项也支持 `--option=value`。
未知选项、缺失参数值、无效链接或不兼容的浏览器模式会在访问浏览器前立即报错。
对任意子命令使用 `--help` 可查看其全部选项。直接传入 URL 以及 `--current` / `--doctor` 别名依然受支持。

`doctor --json` 报告自动化连接状态；已连接并不代表已通过具体文档权限校验。
`report --json` 会打印原始报告并根据其结果返回退出码。
详见[发布维护指南](docs/releasing.md)与[版本历史](CHANGELOG.md)。

## 搜索

使用同一份已登录会话搜索文档与知识库页面：

```bash
feishu-grab search '会议纪要' --limit 10
feishu-grab search '季度规划' --json
```

这是文档与知识库索引，而非飞书全局搜索：绝不会搜索或返回聊天消息。结果直接来自你的账号权限，因此与你在浏览器中可见范围完全一致，且每条链接都可直接传给 `feishu-grab` 导出。

搜索在 BrowserOS neo 运行时会优先使用它：请求在其中的飞书标签页内执行，完全不会干扰你日常使用的 Chrome。若未运行 BrowserOS，则会回退复用 Chrome 中已打开的飞书标签页，且绝不擅自打开新页面。首次运行会将你的租户记录在 `~/.feishu-grab.json` 中，后续搜索无需再传 `--site`。`--offset` 用于分页拉取；`--json` 返回供智能体使用的 `{ total, hasMore, items[] }`。

## MCP 服务器

`feishu-grab-mcp` 通过 stdio 提供 Model Context Protocol 接口，让任何 MCP 客户端都能直接搜索、读取和导出文档，无需再拼接 Shell 命令：

```bash
feishu-grab-mcp        # 通过 brew install 或 npm link 安装后使用
node /path/to/feishu-doc-grabber/mcp/server.mjs
```

它暴露了三个工具：

- `feishu_search` — `{ query, limit?, offset?, site?, json? }`，仅搜索文档与知识库。
- `feishu_read` — `{ url, format? }`，通过 BrowserOS neo 在后台读取文档、知识库页面、表格或附件（`.docx`、`.pdf`、纯文本）。
- `feishu_export` — `{ urls[], out?, timeout? }`，导出 Markdown 并附带完整性报告。

客户端按常规方式配置即可：

```json
{ "mcpServers": { "feishu-grab": { "command": "feishu-grab-mcp" } } }
```

`feishu-grab help search` 文档说明了与 CLI 一致的行为；MCP 服务器与 CLI 共用同一套传输层、白名单与租户记忆。

## 隔离浏览器选项（原有方案）

若需使用原有的 Google Chrome for Testing 工作流，请将该浏览器安装至 `/Applications/Google Chrome for Testing.app`，然后登录一次：

```bash
feishu-chrome login
feishu-grab <url> --browser isolated --out ./exports
feishu-grab <url> --browser isolated --format pdf --out ./exports
```

`--browser isolated` 会在导出 Markdown 时自动以无头模式启动已有的隔离配置。直接调用 `node grab.mjs` 仍保留隔离模式作为默认行为，以兼容 macOS 应用和既有集成；`feishu-grab` CLI 则默认使用日常 Chrome。

## Chrome 扩展预览版

使用 `npm run build:extension` 构建扩展。在 Chrome 中通过**加载已解压的扩展程序**加载生成的 `dist/Feishu Grabber Extension/` 目录，随后在浏览飞书 / Lark 文档时点击扩展图标。精简弹窗会识别当前文档，点击 **Export** 即可导出。非文档页面上图标会禁用。弹窗关闭后导出仍会继续，重新打开弹窗即可查看进度与结果。请保持 Chrome 与源文档页面处于打开状态。扩展会直接使用该 Chrome 配置中的已有登录态，并保存包含 Markdown、本地资源与完整性报告的 ZIP 包。弹窗设置还支持文件夹输出、下载子目录、ZIP 保存位置提示以及跟随系统/浅色/深色外观，且无需在电脑上安装桌面应用或 Node。详见[扩展配置与限制](extension/README.md)。

运行 `npm run test:extension` 可执行无头 Chrome 扩展集成测试套件。该测试使用模拟飞书响应与临时配置，不代表线上真实账号兼容性验证。

## macOS 应用

构建自包含的 Apple Silicon 应用：

```bash
./scripts/build-macos-app.sh
open "dist/Feishu Grabber.app"
```

新包构建并通过签名校验后，构建脚本会移除旧版 `dist/FeishuGrabber.app`，防止 macOS 聚焦搜索索引到两个重复名称。

应用支持输入一个或多个飞书 / Lark 链接，登录后确认已保存的登录态，展示每篇文档的完整性结果，打开本地结果页，并一键重试未完成导出的文档。`Log in to Feishu` 是唯一会主动打开 Chrome for Testing 的操作；正常导出均在无头隔离配置下执行。

每次批量导出还会生成本地结果页 `index.html`，展示每篇文档的状态与完整性详情。未达到 `complete` 的文档会写入 `retry-urls.txt`，可直接通过 `feishu-grab retry` 重新运行：

```bash
feishu-grab retry exports/export-report.json --out exports/retry
```

## 输出与完整性

每次运行都会写入 Markdown、已下载资源、`index.html`、`retry-urls.txt` 与 `export-report.json`。每篇文档都会获得一个明确判定：

- `complete`：所有检查维度均具备正向完整性证据。
- `degraded`：已生成输出文件，但至少有一个维度无法被证明完整。
- `incomplete`：源数据已明确证明部分内容或资源缺失。

退出码约定：`0` 表示全部完整，`1` 表示运行故障，`2` 表示存在降级或不完整输出，`64` 表示参数或报告 Schema 无效。具体规则请参阅 [导出完整性协议 v1](INTEGRITY.md)。

## 渲染回退需显式开启

隔离浏览器 Markdown 路径绝不会主动创建 Chrome for Testing 标签页。若 SSR/API 数据不可用，它会直接报出清晰错误并退出，而不会意外拉起浏览器窗口。

仅在可以接受 DOM 或截图兜底时，才显式传入 `--render-fallback`：

```bash
feishu-grab <url> --browser isolated --render-fallback
```

在 macOS 上，该选项可能会激活 Chrome for Testing。显式执行 `--format pdf`、`--format html` 与 `--format capture` 时同样需要渲染能力。`--allow-focus` 作为 `--render-fallback` 的兼容别名予以保留。

真实文档兼容性矩阵记录在 [飞书导出测试语料库](TEST-CORPUS.md)；实现笔记见 [PLAN.md](PLAN.md)。


<!-- workspace-maintenance:start -->
## 维护与问题入口

代码与必要文档沿用 [GitHub 仓库](https://github.com/Popcornnnnnnnn/feishu-doc-grabber)；需跟进的问题统一从 [Issues](https://github.com/Popcornnnnnnnn/feishu-doc-grabber/issues) 接续，先查重，再记录进展与完成条件。
项目功能与验收沿用已有记录。
<!-- workspace-maintenance:end -->
