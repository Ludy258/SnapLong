# 多滚动区域回归测试

在 Edge 的 `edge://extensions` 中允许 SnapLong 访问文件 URL，或用任意静态文件服务器打开 `tests/fixtures/` 中的页面。每次测试前重新加载扩展。

| 页面 | 操作 | 预期结果 |
|---|---|---|
| `independent-panels.html` | 打开扩展并截取长图。 | 检测到 `#left-panel` 和 `#right-panel`；两者可同时选择，合成图保留两个独立面板。 |
| `nested-panels.html` | 打开扩展。 | 自动候选只保留 `#outer-panel`，不同时列出嵌套的 `#inner-panel`。 |
| `overlapping-panels.html` | 打开扩展。 | 自动候选只保留面积更大的 `#base-panel`，不同时列出大面积覆盖它的 `#overlap-panel`。 |
| `dynamic-layout.html` | 点击“Move the right panel in 2 seconds”，立刻从扩展开始长截图。 | 面板移动后，截图应报出布局变化并恢复滚动位置；不应下载错位图片。 |

建议在浅色和深色主题下各跑一次 `independent-panels.html`，并在 `dynamic-layout.html` 中将滚动延迟调到 1500 ms，确保布局变化发生在采集期间。

另外可在项目根目录执行 `node tests/verify-content-logic.mjs`，验证嵌套、重叠、并列候选的筛选规则，以及计划位置序列和布局漂移阈值。
