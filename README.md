# SnapLong 📸

一键滚动截取整个网页，支持 **PNG / JPEG / PDF** 导出。轻量、美观、开箱即用。

Edge 浏览器扩展（Manifest V3）。

## 功能

| 功能 | 说明 |
|------|------|
| 📄 滚动长截图 | 自动滚动 + 像素级拼接 |
| 🖼️ 可视区域截图 | 一键截取当前屏幕 |
| 🎨 三种导出格式 | PNG / JPEG / PDF |
| 🌙 深色模式 | 自动跟随系统 / 手动切换 |
| ⌨️ 自定义快捷键 | 自由绑定触发方式 |
| 📂 自定义保存路径 | 文件夹 + 另存为对话框 |
| ⚡ 懒加载处理 | 截前自动预滚触发所有内容 |

## 安装

### 开发者模式（临时）

1. 下载并解压 [SnapLong-extension.zip](https://github.com/Ludy258/SnapLong/releases)
2. 打开 Edge 浏览器 → `edge://extensions`
3. 开启 **"开发人员模式"**（左上角）
4. 点击 **"加载解压缩的扩展"** → 选择解压后的文件夹

<!-- todo -->

## 使用

1. 点击插件图标（或按 `Ctrl+Shift+S`）
2. 状态显示页面尺寸 → 即可截图
3. 选择格式 → 调整延迟 → 点击 **"截取长图"**
4. 文件自动保存到 `~/Downloads/SnapLong/`

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+S` | 打开弹窗 |
| `Alt+Shift+S` | 一键截长图 |

可在 `edge://extensions/shortcuts` 自定义修改。

## 技术栈

- **Manifest V3** — 最新扩展标准
- **Service Worker** — 后台截图协调
- **Offscreen Document** — Canvas 拼接 + PDF 生成
- **纯 JavaScript** — 无三方框架，仅 20KB

## 反馈

- 提交 [Issue](https://github.com/Ludy258/SnapLong/issues)
- 邮箱：24xzhuo@stu.edu.cn

---

<p align="center">Made with ❤️</p>
