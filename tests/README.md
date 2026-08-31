# 多滚动区域回归测试

在 Edge 的 `edge://extensions` 中允许 SnapLong 访问文件 URL，或用任意静态文件服务器打开 `tests/fixtures/` 中的页面。每次测试前重新加载扩展。

| 页面 | 操作 | 预期结果 |
|---|---|---|
| `independent-panels.html` | 打开扩展并截取长图。 | 检测到 `#left-panel` 和 `#right-panel`；两者可同时选择，合成图保留两个独立面板，条目不应丢失或重复。 |
| `nested-panels.html` | 打开扩展。 | 自动候选只保留 `#outer-panel`，不同时列出嵌套的 `#inner-panel`。 |
| `overlapping-panels.html` | 打开扩展。 | 自动候选只保留面积更大的 `#base-panel`，不同时列出大面积覆盖它的 `#overlap-panel`。 |
| `dynamic-layout.html` | 点击“Move the right panel in 2 seconds”，立刻从扩展开始长截图。 | 面板移动后，截图应报出布局变化并恢复滚动位置；不应下载错位图片。 |
| `lazy-content.html` | 打开扩展并截取长图。 | 滚动到底部后新增的条目也应出现在最终截图中，不能在首批内容结束处截断。 |

建议在浅色和深色主题下各跑一次 `independent-panels.html`，并在 `dynamic-layout.html` 中将滚动延迟调到 1500 ms，确保布局变化发生在采集期间。

开启弹窗里的“自动复制到剪贴板”后，可在任意支持粘贴图片的应用中按 `Ctrl+V` 验证结果。选择 JPEG 或 PDF 时，下载文件保持所选格式，但剪贴板内容仍是 PNG 图片。

另外可在项目根目录执行以下检查：

- `node tests/verify-content-logic.mjs`：验证嵌套、重叠、并列及视口外候选筛选规则。
- `node tests/verify-clipboard-logic.mjs`：验证 PNG 剪贴板写入、拼接坐标和超时取消。
- `node tests/verify-service-worker-logic.mjs`：验证 offscreen 并发创建、租约释放和关闭顺序。
- `node tests/verify-extension-assets.mjs`：验证 Manifest 引用的弹窗、后台脚本、内容脚本和图标都存在。
- `node tests/verify-lazy-scroll-logic.mjs`：验证懒加载扩展页面高度后，截图计划会重新读取最终尺寸并恢复起始位置。
