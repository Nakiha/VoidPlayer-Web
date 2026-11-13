# 图标资源与维护

正式图标的可编辑源文件为 [VoidPlayer.icon](VoidPlayer.icon)，可使用 Apple Icon Composer 打开。当前采用 G2 配色：乳白色玻璃播放键叠在蓝青色拼块上，尖端下方保留蓝紫色，右下角用薄荷绿点缀。

## 生成网页与安装图标

安装 Xcode 和 Playwright Chromium 后，在仓库根目录运行：

```sh
npm run icons:generate
```

该命令更新网页标签、主屏幕和安装图标。正式构建会按图标内容生成版本化地址；已安装的桌面 Chrome 应用再次联网打开后可发现变化。如果窗口菜单提示应用更新，确认新图标后会更新程序坞图标。

网页标签图标（SVG 与 ICO）使用透明背景，彩色拼块放大至紧贴方形画布；主屏幕和安装图标保留 Icon Composer 的底板与留白。
开发页面按 favicon 内容添加版本标记，避免刷新后继续沿用旧图标缓存。

## 前景与设计草稿

应用内需要透明背景的前景图标时，使用 [icon-foreground.svg](../public/icon-foreground.svg)，网页路径为 `/icon-foreground.svg`。它与网页图标由同一份工程导出，播放键覆盖在拼块上。

早期取景框设计及[动效样稿](studies/VoidPlayer-motion.svg)保存在 `studies/`。
