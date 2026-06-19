# PrintScreen 长截图

Edge 浏览器扩展（Manifest V3），一键滚动截取整个网页，支持 PNG / JPEG / PDF 导出。

## 项目结构

```
edge-extension/
├── manifest.json                 # 扩展清单 (MV3)
├── popup/
│   ├── popup.html                # 弹窗 UI（圆角卡片风格，含设置面板）
│   ├── popup.css                 # 弹窗样式（支持深色模式三档切换）
│   └── popup.js                  # 弹窗逻辑（格式/延迟/路径/主题设置）
├── content/
│   └── content.js                # 内容脚本（页面检测/滚动/懒加载/fixed元素处理）
├── background/
│   ├── service-worker.js         # 后台服务（截图协调、快捷键、下载）
│   └── offscreen.js              # Offscreen Document（Canvas 拼接、PDF 生成）
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 核心功能

- **长截图**：自动滚动截取整个页面，20% 重叠区域像素匹配拼接
- **可视区域截图**：一键截取当前屏幕可见区域
- **导出格式**：PNG / JPEG / PDF（PDF 手动构造，内嵌 JPEG）
- **保存路径**：`~/Downloads/PrintScreen/` 可自定义子文件夹
- **每次询问**：可选每次都弹出"另存为"对话框
- **快捷键**：`Ctrl+Shift+S` 打开弹窗，`Alt+Shift+S` 一键截长图（可在 `edge://extensions/shortcuts` 自定义）
- **三档主题**：自动（跟随系统）/ 浅色 / 深色

## 架构要点

- **MV3 Service Worker**：负责截图协调，无 DOM 访问权限
- **Offscreen Document**：负责 Canvas 拼接和 PDF 生成，通过 `chrome.runtime.sendMessage` 通讯
- **数据流**：SW 截图 → Offscreen 拼接 → dataUrl → SW 下载
- **速率限制**：`captureVisibleTab()` 每次间隔 500ms 避免限频
- **内容脚本**：检测页面尺寸、控制滚动位置、隐藏/恢复 fixed 元素

## 已知限制

- Canvas 最大 32767px（Chrome 限制），超长页面会报错
- PDF 生成用的是手动构造的简单 PDF（6 个对象），不支持文字选择

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
# Compress-Archive -Path 'edge-extension/*' -DestinationPath 'PrintScreen-extension.zip' -Force
```

## 联系方式

- 反馈：24xzhuo@stu.edu.cn
