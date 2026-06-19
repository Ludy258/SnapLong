# SnapLong - Edge 浏览器插件

一键滚动截取整个网页，支持 PNG / JPEG / PDF 导出。支持深色模式、自定义快捷键。

## 安装（开发者模式）

1. 打开 Edge 浏览器，地址栏输入 `edge://extensions/`
2. 打开 **"开发人员模式"**（左上角开关）
3. 点击 **"加载解压缩的扩展"**
4. 选择 `edge-extension` 文件夹（或拖拽 zip 文件到页面）

## 使用

1. 点击插件图标打开弹窗（或按 `Ctrl+Shift+S`）
2. 状态显示页面尺寸表示可截图
3. 选择导出格式（PNG / JPEG / PDF）
4. 调整滚动延迟（默认 500ms，页面内容加载慢可调高）
5. 设置保存目录名称（默认 `SnapLong`）
6. 可选：开启"每次询问"弹出保存位置对话框
7. 点击 **"截取长图"** 按钮自动滚动截图
8. 也可点击 **"可视区域"** 只截当前屏幕

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+S` | 打开弹窗 |
| `Alt+Shift+S` | 一键截长图（跳过弹窗） |

快捷键可在 `edge://extensions/shortcuts` 自定义修改。

## 功能

- ✅ 滚动长截图（自动拼接）
- ✅ 可视区域截图
- ✅ PNG / JPEG / PDF 导出
- ✅ 自定义保存路径
- ✅ 保存时询问位置
- ✅ 自定义快捷键
- ✅ 深色模式（自动/浅色/深色三档）
- ✅ 懒加载处理（截前预滚到底部）
- ✅ Fixed/Sticky 元素自动隐藏

## 截图

![截图](../屏幕截图%202026-06-19%20132648.png)

## 文件结构

```
edge-extension/
├── manifest.json              # 扩展清单 (MV3)
├── popup/
│   ├── popup.html             # 弹窗 UI
│   ├── popup.css              # 弹窗样式
│   └── popup.js               # 弹窗逻辑
├── content/
│   └── content.js             # 内容脚本（页面检测/滚动/懒加载）
├── background/
│   ├── service-worker.js      # 后台服务（截图协调）
│   └── offscreen.js           # 拼接引擎（Canvas 拼接 + PDF 生成）
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 技术栈

- Manifest V3
- Canvas API（拼接）
- 纯 JavaScript（无框架）
- 手动构造 PDF（内嵌 JPEG）

## 反馈

24xzhuo@stu.edu.cn
