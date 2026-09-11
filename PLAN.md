# feishu-doc-grabber — 飞书文档本地抓取工具

> 目标：给一个我能查看的飞书文档链接，在本地导出为 PDF / HTML / Markdown。
> 原则：纯本地运行，只用自己的浏览器登录态，不经过任何第三方服务器。

## 约束与前提

- 无管理员权限，不能用企业自建应用 + Open API（export_tasks 路线搁置，以后有权限可秒切）
- 依赖日常使用的 Chrome 登录态（工具不做登录流程）
- 用法自用，抓取内容不分发（水印可溯源）

## 总体架构

```
AI 专属 Chrome（独立 profile: ~/.ai-chrome-profile，与日常 Chrome 可同时运行）
  └── --remote-debugging-port=9222
        └── puppeteer-core 连接（tools/ai-chrome.mjs 负责 start/status/open/stop/ensure）
              ├── A. 打开文档 → 自动滚动加载 → Page.printToPDF
              ├── B. 滚动完成后抽 DOM → 清洗 → HTML / Markdown
              └── C.（可选）Network 域录包 → 找 block JSON → 本地解析
```

浏览器策略（已定）:
- 不复用日常 Chrome profile，也不拷贝其登录态；AI 实例首次使用时手动登录一次飞书，登录态持久保存在独立 profile
- 原则: AI profile 里只登录愿意交给 AI 使用的账号（工作账号/低敏站点），不放银行、主邮箱等高敏账户
- 大多数站点允许多并发 session（登录态是 cookie，同机同 IP），飞书无压力；个别单 session 策略的 SSO 需留意

## Phase A：PDF 导出（先做，半天目标）

- [ ] `grab.mjs`：puppeteer-core 连接本机 Chrome（attach，不 launch）
- [ ] URL 解析：支持 `feishu.cn/docx/xxx`、`/wiki/xxx`（wiki 自动等跳转），larkoffice.com 域名同理
- [ ] 自动滚动：虚拟滚动容器滚到底部，等待所有懒加载块渲染完成（判断滚动高度稳定 + 骨架屏消失）
- [ ] `Page.printToPDF`（printBackground、A4），保存为 `<标题>.pdf`
- [ ] 批量模式：传入多个链接 / 一个 txt 清单，串行处理 + 失败重试
- [x] 验收部分通过：长文档能导出，但确认了技术性局限 —— **宽表格被视口宽度裁剪、悬浮层/水印污染输出**
- 已知局限：printToPDF 走屏幕渲染管线，viewport 外内容与 fixed 浮层无法根治 → 主力路线转 B/C，PDF 降级为快速预览用
- 文件名需去除零宽不可见字符（已在 safeName 处理）

已知风险：
- 打印时机太早会缺尾部内容 → 以"滚动高度连续 N 秒不变"为准
- 某些块（画板/iframe 嵌入）打印可能空白 → 记录并标注，Phase C 再解决

## Phase B：HTML / Markdown 导出（已实现，待真数据校准）

> 状态：`grab.mjs --format md|html` 可用，`lib/clean.mjs` 按结构规则写（data-block-type / 标签语义 / 类名关键词），
> 未识别块会打印签名供迭代；图片经浏览器上下文下载（自带登录态）到 assets/ 并改写引用

- [ ] 滚动完成后序列化正文 DOM
- [ ] 清洗规则：去水印层、去工具栏/浮层、块属性转 Markdown（标题层级、列表、表格、代码块、引用、图片 base64 内联或下载到 assets/）
- [ ] 输出 `.md` + 可选 `.docx`（html-docx 或交给 pandoc）
- [ ] 图片：抓取 `<img>`/背景图，本地保存并改写引用
- 验收：导出的 Markdown 在 Typora/Obsidian 打开结构正确，图片可显示

已知风险：
- 飞书编辑器 DOM 噪声大、class 名混淆，规则按结构（data-* / 标签语义）写而不是按 class
- 表格/多维表格嵌入块最难，第一版允许降级为截图

## Phase C：block 数据直取（✅ 已成为 md 导出的主路线）

> 实测结论（2025-09，用真实文档验证）:
> - 文档正文/块树 **SSR 在首屏 HTML 里**: `window.DATA.clientVars.data.block_map`（老版 docx 格式，与官方 export_tasks 同源），无需碰 WS/protobuf
> - sheet(电子表格) 块渲染为 canvas，DOM 抓不到；但 SSR 附带 `ssr-<blockId>-svg`：
>   内含单元格边框线段（横/竖 1px rect，含 transform 双轴偏移）—— 用边框覆盖判断重建网格，
>   union-find 找合并区域，carry-fill 使每行自包含；注意 SSR SVG 服务端存在分钟级波动，
>   已实现多变体重试 + 无 SVG 时表格截图兑底
> - 教训: docx/sheet 编辑器是跨进程 iframe（OOPIF），页面级 CDP 录不到其网络；且渲染层有虚拟化，DOM 只存视口内块 —— 所以后台 HTML 直取是正解
> - 待验证: 长文档 SSR 是否分页（`has_more`/`next_cursors` 字段已检测，分页拉取待实现）
> - 实现: `lib/ssr.mjs`，`grab.mjs --format md` 优先走此路线，失败回落 DOM 提取
> - 图片: image 块的 token+块 id 可直接构造 cover 下载接口（internal-api-drive-stream），带 cookie 在 Node 侧下载到 assets/ 并改写引用
> - 坎: wiki token 有大小写变体（I/l 手误），变体 token 会 404/空 SSR 且 get_node 也拒绝；
>   已实现易混淆字符（I/l/1/O/0）单字符替换候选探测自动纠正
> - 附件: file 块走 `download/all/<token>` 接口，带 cookie 下载到输出目录（已实测 zip 校验无损）
> - 评论: `commentid/all`（拿 id+锚点 blockID）→ `comment/batch`（需 need_reply=true 等参数 + X-CSRFToken 头
>   取自 `_csrf_token` cookie），按线程输出到 md 末尾「## 评论」章节；评论锚点文本从 block_map/DOM 解析
> - 新版 docx 没有旧版 block_map SSR（clientVars=undefined）——但 DOM 结构与旧版一致（data-block-id），
>   走 DOM 回落路线即可；前提是 token 正确（404 页会导致整页皆空，已加 404 快速失败）
> - DOM 路线表格: rowspan/colspan 展开 + carry-fill；飞书 DOM 在 rowspan 覆盖位还有空占位 td，
>   需跳过（否则真实内容被挤错列）；空行过滤、零宽字符清理、data:URI 图片跳过
> - DOM 路线图片: 页面内 fetch 有 CORS 限制，改 Node 侧带 cookie/referer 下载
> - 表格合并（定稿）: 纯 md 表格无法表达合并，两条路线均输出**带 rowspan/colspan 的内嵌 HTML 表格**
>   （Typora/Obsidian/GitHub 均可渲染）；sheet 走 SVG 边框几何 + union-find，DOM 走原生 rowspan/colspan 属性；
>   飞书 DOM 在 rowspan 覆盖位有空占位 td，需跳过避免列错位
> - 评论（定稿 v3，方案1）: 句子级划线 + 编号跳转。
>   API 的 `quote` 字段是被评论的原句；提取前用 TreeWalker 在锚点块内定位原句，
>   在其后插入 ⟦REFi⟧ 标记；生成后替换为 `<mark>原句</mark>` + 编号上标（id=cmt-ref-i），
>   文末「## 💬 评论」批注区（id=cmt-note-i，含回复线程 ↳ 与「↩ 回原文」跳转链接）。
>   原句定位失败（跨富文本节点等）时标记落在块尾。
>   参数坑：comment/batch 必须 need_reply/need_reaction=true，CSRF 头是 X-CSRFToken
>   （值取 _csrf_token cookie）；锚点 blockID 是 data-record-id（非 data-block-id）
> - 画板/不可解析 sheet: 后台创建隐藏 Chrome target，启用 focus emulation，按 SSR block id 精确定位并滚动元素后截图；
>   不再调用 `bringToFront`，不会抢占用户焦点。截图只能证明可视内容，所以完整性协议统一判为 `degraded`；截图缺失判为 `incomplete`。
>   坐标映射运行时 id 仍可能不同于 block_map id，需保留 DOM 顺序兜底；调试/运行完务必关闭隐藏页。

- [ ] CDP `Network.enable` 录制页面所有 XHR/fetch 响应
- [ ] 定位含文档 block 树的接口（响应里 grep 已知标题/正文片段即可确认）
- [ ] 本地解析 block JSON → Markdown（block 类型逐一映射，是主要工作量）
- 价值：结构最干净、不依赖渲染、速度快；对应那个商业插件 processor-factory 的核心
- 触发条件：A/B 的输出质量确实不够用，或需要批量转存大量文档时再做

## 目录规划

```
feishu-doc-grabber/
  PLAN.md            # 本文件
  grab.mjs           # Phase A 入口
  lib/scroll.mjs     # 自动滚动/等待策略
  lib/clean.mjs      # Phase B DOM 清洗与转换
  lib/blocks.mjs     # Phase C block 解析（可选）
  out/               # 导出结果
```

## 使用方式（当前）

```bash
# 浏览器由工具自动拉起（AI 专属实例），也可手动管理:
node tools/ai-chrome.mjs start|status|open <url>|stop

# 导出
node grab.mjs https://xxx.feishu.cn/wiki/xxxxx            # 默认 PDF
node grab.mjs <url> --format md                           # Phase B
node grab.mjs --list docs.txt --format pdf                # 批量
```

首次使用: `node tools/ai-chrome.mjs start` 后在弹出的窗口登录飞书（一次即可）。

隔离测试租户使用独立 profile 和端口，不会读取或修改日常/公司登录态：

```bash
AI_CHROME_PROFILE=~/.feishu-export-test-profile AI_CHROME_PORT=9223 node tools/ai-chrome.mjs status
AI_CHROME_PROFILE=~/.feishu-export-test-profile AI_CHROME_PORT=9223 node grab.mjs <test-url> --format md
```

## 目录

```
feishu-doc-grabber/
  PLAN.md
  grab.mjs               # Phase A 入口
  tools/ai-chrome.mjs    # AI 专属 Chrome 实例管理（start/status/open/stop/ensure）
  lib/scroll.mjs         # 自动滚动/等待策略
  lib/clean.mjs          # Phase B DOM 清洗与转换（待做）
  lib/blocks.mjs         # Phase C block 解析（可选）
  out/                   # 导出结果
```

## 备忘

- 若拿到管理员批准的自建应用：切官方 export_tasks 路线（docx/pdf 官方转换，质量最高），本工具的滚动/清洗逻辑作废
- 遵守公司规定：仅备份自己有权查看的内容；DLP 管控环境自行评估
