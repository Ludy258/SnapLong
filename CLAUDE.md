# SnapLong

Edge 浏览器扩展（Manifest V3），一键滚动截取整个网页，支持 PNG / JPEG / PDF 导出。

## 项目结构

```
edge-extension/
├── manifest.json                 # 扩展清单 (MV3)
├── popup/
│   ├── popup.html                # 弹窗 UI（圆角卡片风格，含设置面板）
│   ├── popup.css                 # 弹窗样式（支持深色模式三档切换）
│   └── popup.js                  # 弹窗逻辑（格式/延迟/路径/主题/多容器选择）
├── content/
│   └── content.js                # 内容脚本（容器检测/滚动/lazy load/fixed元素/多容器plan生成）
├── background/
│   ├── service-worker.js         # 后台服务（多容器截图协调、快捷键、下载）
│   └── offscreen.js              # Offscreen Document（Canvas 拼接、多容器合成、PDF 生成）
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 核心功能

- **长截图**：自动滚动截取整个页面，20% 重叠区域像素匹配拼接
- **可视区域截图**：一键截取当前屏幕可见区域
- **多容器同时截屏**：页面多滚动区域同时截取，各自拼接后合成一张完整截图。用户可通过弹窗勾选/主容器单选控制
- **合成模式**：自定义滚动容器截屏时保留页眉/页脚/侧边栏等容器外内容，超出部分用底色填充
- **导出格式**：PNG / JPEG / PDF（PDF 手动构造，内嵌 JPEG）
- **保存路径**：`~/Downloads/SnapLong/` 可自定义子文件夹
- **每次询问**：可选每次都弹出"另存为"对话框
- **快捷键**：`Ctrl+Shift+S` 打开弹窗，`Alt+Shift+S` 一键截长图
- **三档主题**：自动（跟随系统）/ 浅色 / 深色

## 架构要点

- **MV3 Service Worker**：负责截图协调，无 DOM 访问权限
- **Offscreen Document**：负责 Canvas 拼接、多容器合成和 PDF 生成
- **数据流**：popup → SW 协调 → content script 生成 plan → SW 逐容器截图 → Offscreen 拼接/合成 → dataUrl → SW 下载
- **多容器流程**：`containerPlans[]` → SW 双循环（容器 × 位置）→ `containerStrips[]` → Offscreen 独立拼接 + 合成
- **合成模式**：上下文帧（含 fixed 元素）→ 中部贴原始上下文 → 容器 strip 覆盖 → 空白填底色
- **速率限制**：`captureVisibleTab()` 每次间隔 500ms
- **容器检测**：`detectScrollContainers()` 扫描 `overflow-y: auto/scroll`，过滤窄元素

## 已知限制

- Canvas 最大 32767px（Chrome 限制），超长页面会报错
- PDF 生成用简单构造（6 对象），不支持文字选择
- 多容器截图耗时 = 各容器帧数之和 × 500ms

## 快捷键

| 命令 | 默认 | 说明 |
|------|------|------|
| `_execute_action` | `Ctrl+Shift+S` | 打开弹窗 |
| `capture-long-screenshot` | `Alt+Shift+S` | 一键截长图 |

## 开发

```bash
# 加载未打包扩展
# 1. edge://extensions → 开发者模式
# 2. 加载解压缩的扩展 → 选择 edge-extension 文件夹

# 打包
# Compress-Archive -Path 'edge-extension/*' -DestinationPath 'SnapLong-extension.zip' -Force
```

## 联系方式

- 反馈：24xzhuo@stu.edu.cn
