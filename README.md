# SnapLong 📸

一键滚动截取整个网页，支持 **PNG / JPEG / PDF** 导出。轻量、美观、开箱即用。

Edge 浏览器扩展（Manifest V3）。

## 版本

| 版本 | 说明 |
|------|------|
| **v1.3.0 标准版** | 多容器同时截屏、合成模式、页眉页脚保留 |
| v1.2.0 Lite 版 | 单容器截屏 + 上下文合成 + 保留页眉页脚 |
| v1.0.0 | 基础长截图 |

## 功能

| 功能 | 说明 |
|------|------|
| 📄 滚动长截图 | 自动滚动 + 20% 重叠像素匹配拼接 |
| 🖼️ 可视区域截图 | 一键截取当前屏幕 |
| 🗂️ 多容器同时截屏 | 页面多滚动区域同时截取，合成一张完整截图 |
| 🧩 合成模式 | 保留页眉/页脚/侧边栏等容器外内容 |
| 🎨 三种导出格式 | PNG / JPEG / PDF |
| 🌙 深色模式 | 自动跟随系统 / 手动切换 |
| ⌨️ 自定义快捷键 | 自由绑定触发方式 |
| 📂 自定义保存路径 | 文件夹 + 另存为对话框 |
| ⚡ 懒加载处理 | 截前自动预滚触发所有内容 |

## 安装

### 开发者模式

1. 下载 [最新 Release](https://github.com/Ludy258/SnapLong/releases) 中的 `SnapLong-extension.zip`
2. 解压到任意文件夹
3. 打开 Edge 浏览器 → `edge://extensions`
4. 开启 **"开发人员模式"**
5. 点击 **"加载解压缩的扩展"** → 选择解压后的文件夹

## 使用

1. 点击插件图标（或按 `Ctrl+Shift+S`）
2. 状态显示页面尺寸 → 即可截图
3. 多滚动区域页面：勾选要截的容器 → 选择主容器 → 点击截取
4. 选择格式 → 调整延迟 → 点击 **"截取长图"**
5. 文件保存到 `~/Downloads/SnapLong/`

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+S` | 打开弹窗 |
| `Alt+Shift+S` | 一键截长图（全部容器） |

可在 `edge://extensions/shortcuts` 自定义修改。

## 技术栈

- **Manifest V3** — 最新扩展标准
- **Service Worker** — 后台截图协调
- **Offscreen Document** — Canvas 拼接 + PDF 生成 + 多容器合成
- **纯 JavaScript** — 无三方框架，仅 ~100KB

## 反馈

- 提交 [Issue](https://github.com/Ludy258/SnapLong/issues)
- 邮箱：24xzhuo@stu.edu.cn

---

<p align="center">Made with ❤️</p>
