# UI 主题与交互约定

本文描述当前实现。历史迭代与验证记录保留在仓库根目录的 `design-qa.md`；其中引用的设计截图已清理。

## 代码边界

`silver-glass.css` 定义主题颜色、材质、字体和密度，`../style.css` 定义组件布局与交互状态。`main.ts` 导入两者；替换主题或覆盖同名变量即可调整外观。

`../ui/` 负责 DOM、输入和数据投影；`source-catalog.ts` 管理片源身份、访问能力和历史；播放、定位、排序、关闭轨道、偏移及标注由 UI 与 Agent 共用的 `ReviewSession` 执行。视频帧经 presenter 上屏，主题不对视频 canvas 加滤镜或染色。

## 材质、尺寸与间距

当前为亮色主题。顶栏使用 `--glass-fill`（82% 主题底色）；并排轨道标题和单行播放控制栏使用 `--viewport-chrome-fill`（76% 主题底色），面积限定在各自的 32px 行高内。分屏擦拭标题使用独立的 `--viewport-header-overlay`，当前为透明。`--glass-filter: none`，没有背景模糊、渐变衬底或文字投影。侧栏和子轨道使用实色面板。降低透明度或提高对比度时，glass/chrome 材质变量切换到实色；分屏标题仍使用独立变量，提高对比度还恢复控件边框。

默认通过空间、对齐、悬停和选中底色分组，不逐项描边或嵌套卡片。工作区边界使用 `--divider`，输入框与键盘焦点保留边界。图标采用 Phosphor 局部 SVG 导入，无远程字体；加号与刷新使用 Bold，其余保持 Regular。

| 用途 | 主题变量 | 当前默认 |
| --- | --- | --- |
| 字体与字号 | `--font-*`、`--text-*` | 系统 UI 字体、等宽时间数字 |
| 顶栏 / 标题与子轨道行 / 播放栏 | `--toolbar-height`、`--row-height`、`--transport-height` | 40px / 32px / 32px |
| 按钮命中区 / 图标 | `--button-size`、`--icon-size` | 28px / 18px |
| 紧凑行内边距与操作间隔 | `--tool-inset`、`--tool-gap` | 2px / 2px |
| 一般按钮组间隔与内边距 | `--control-gap`、`--control-padding-inline` | 4px / 8px |
| 图标按钮底色内收 | `--control-surface-inset` | 2px |
| 顶栏内边距 | `--toolbar-padding-inline/block` | 横向 8px，纵向按按钮居中 |
| 播放栏内边距 | `--transport-padding` | 纵向 2px，横向 8px |
| 面板内容内边距 | `--panel-padding-inline/block` | 8px / 4px |
| 面板标题纵向内边距 | `--panel-heading-inset` | 2px |
| 输入框内边距 | `--field-padding-inline` | 6px |
| 内容留白 / 内容间隔 / 分组间隔 | `--content-inset`、`--content-gap`、`--section-gap` | 12px / 6px / 8px |
| 标注列表间隔 | `--list-gap` | 4px |
| 时间轴列间隔 | `--timeline-column-gap` | 8px，窄屏 4px |
| 浮层内边距 / tooltip 纵向内边距 | `--popover-padding`、`--tooltip-padding-block` | 8px / 6px |
| 折叠标注列内边距 | `--rail-padding-inline` | 按列宽与按钮宽计算，当前 6px |

`--space-*` 是基础刻度，组件优先使用上表的用途变量。调整密度须满足 `按钮大小 + 2 × 行内边距 <= 行高` 与 `图标大小 + 2 × 底色内收 <= 按钮大小`。底色内收不缩小点击区域。普通与密集行的焦点偏移分别由 `--focus-offset`、`--focus-dense-offset` 控制，密集行向内描边以免被裁剪。

## 视图和播放控制

槽位由 `model.ts` 的 `SLOTS` 统一定义为 A/B/C/D，颜色为 `--slot-a/b/c/d`。`Viewport.arrangement` 控制横排或最多两列的田字布局；下排轨道标题位于底部，排序后随所在行移动。分屏擦拭显示当前排序的前两轨，其余轨道仍保留在会话和子轨道列表中。

轨道标题覆盖在画面上。并排标题边界使用 `--header-divider-width`；擦拭标题、裁切和分割线共用 `splitPixelGeometry` 的设备像素边界。`--split-line`、`--split-handle` 控制实色线条和把手。标题宽度不足 `--header-actions-breakpoint`（180px）时，原有操作按钮收进 popover，不复制操作逻辑。

播放栏覆盖在 viewport 底部，依次排列播放/逐帧、时间、弹性进度条、全屏；独立眼睛按钮在最右侧。田字下排标题占底部时，控制栏上移一个行高。侧栏、子轨道和标注工具条会压缩整个 viewport，视频与播放栏共同让位。

当前时间支持原位输入秒数、mm:ss.mmm、hh:mm:ss.mmm；Enter 或失焦提交，Escape 取消，编辑开始时暂停。`--time-input-chars` 按最长时间码保留位数，宽度包含 padding 和光标余量。viewport 小于 480px 隐藏总时长，小于 300px 收紧间距，小于 260px 隐藏时间区，保留播放、进度条、全屏与专注按钮。缩放入口通过 `--zoom-control-width` 固定为 92px。

主进度条预览目标时间；子轨道在 10 CSS px 内吸附到标注的精确微秒锚点，同距取较早者。预览不解码。时间指针由 `--timeline-pin-shape`、`--timeline-thumb-size`、`--timeline-pin-height` 定义，已播放区端点与指针共享内收后的进度位置。

重置视图恢复 1× 并居中；画面移出可见区时的居中提示保留当前倍率。像素网格每格固定为 320×320 个源像素，随 fit、缩放和平移对齐，不合并网格。颜色使用 `--viewport-grid-line/label`；尺寸标签仅显示实际宽×高，留白为 `--viewport-caption-inset`（8px）。标签和网格位于视频后方，只在背景露出时可见。网格绘制按动画帧合并，仅响应几何或主题变化，设备像素比上限为 2。

眼睛按钮切换专注模式，隐藏标题、播放栏、尺寸标签、标注覆盖和恢复提示；保留视频、背景网格、分屏拉杆及眼睛。隐藏的操作区设为 inert。空会话退出专注，打开标注恢复控件，几何和会话状态不受此开关影响。

## 面板、菜单与排序

新会话默认折叠检查、子轨道、片源三块工具区，开关位于右上角，窗口变窄时保留独立展开状态。默认宽度由 `--inspector-width`（200px）、`--sources-width`（240px）控制，子轨道高度为 `--dock-default-height`（180px）。侧栏用户宽度保存在本地偏好中。

`ui/panel-motion.ts` 管理展开与收起：`--panel-motion-duration`（220ms）、`--panel-motion-easing` 控制卡片与工作区让位；退出结束后才 hidden，退出期间 inert，重复切换取消旧任务。系统减少动态效果设置关闭过渡。

调整条采用 `--panel-resize-hit-width`（10px）命中区和 `--panel-resize-line-width`（2px）可见线，不占内容列宽。悬停、拖动或聚焦时显示细线，不显示 tooltip。宽度受 `--side-panel-min-width/max-width` 与 `--comparison-min-width` 约束。支持拖动、方向键、Home/End 和双击恢复。

越过最小尺寸后，固定尺寸面板通过平移退出，`--panel-dismiss-veil` 随距离加深，工作区同步补齐。超过 `--panel-collapse-distance`（32px）后松手收起；松手前拉回撤销收起，Escape 或失去捕获取消调整，再展开恢复手势前尺寸。侧栏、子轨道与标注列共用 `ui/resize-gesture.ts` 的输入生命周期。标注展开宽度受 `--marks-min-width`（160px）、`--marks-max-width`（400px）、`--marks-timeline-min-width`（240px）约束。

标题名称与子轨道名称共用点击和拖动区：轻点切换详情，移动 5px 开始排序并抑制点击；聚焦名称后 Alt+方向键也可排序。拖放使用 `--drag-preview-*`、`--drag-target-fill`、`--drag-insertion`，不重建解码器、不改变标注身份与时间。关闭轨道释放对应解码器，保留标注来源记录；关闭按钮悬停使用 `--action-danger/fill`。

顶部更多操作、缩放和像素模式复用 `ui/menu.ts` 与 `.popup-menu`，采用 auto popover 顶层、边缘限位及统一材质，支持方向键、Home/End、Escape、Tab 和焦点返回。操作菜单执行前关闭，选项保留 radio 语义。右侧“文件＋ / 添加视频”入口位于连接灯之前。

`ui/tooltips.ts` 统一操作提示，优先显式提示；仅无文字图标回退到可访问名称，不把文件名或字段值当提示。原生 title 迁移到 data-tooltip，菜单和调整条不重复显示通用提示。标注与时间轴使用专用预览。

## 片源与历史

启动页和右侧片源栏共用 SourceCatalog。添加优先填空槽，四槽已满时选择替换轨道；已载入条目保持可见并标记使用中。媒体库来源 ID 区分不同目录的文件，文件名、大小与修改时间用于验证历史版本，两者不能互相替代。列表显示媒体库根目录名称以辅助区分同名条目。

最近历史只保存元数据和明确的媒体库来源 ID，不保存文件内容。本地文件在浏览器失去访问权后需要重新选择，不能因为媒体库里有同名同大小文件就自动恢复访问。媒体库历史只在来源 ID 与元数据均匹配时重新打开，替换过的文件不会自动接管旧记录。

标题提供拷贝路径、定位/下载和关闭操作。浏览器 File 不提供绝对路径；本机媒体库可通过白名单 location 接口提供路径，启用本机定位后可打开 Finder/Explorer。可信网关模式不返回服务器绝对路径，远端文件操作提供下载。连接灯位于右上角面板开关之前。

## 时间偏移与标注

两条解码路径均已将各文件首帧归零，并保留原始 PTS。手动偏移使用 `sessionUs = normalizedMediaUs + offsetUs`，正值延后、负值提前，不重复应用容器起始 PTS。输入默认毫秒，也支持显式 s/ms 和时间码；变更时暂停并重新定位。轨道开始前保持首帧，共同播放终点是各轨偏移后终点的最小值。相对游标差与手动偏移分开展示。

子轨道列为名称、偏移、时间轴和关闭操作。标注面板在其左侧，默认折叠为 `--dock-rail-width`（40px）图标列；展开使用 `--dock-tools-width`（240px），可拖动调宽。悬浮或键盘聚焦标注显示时间、备注、作者及可用缩略图，展开列表复用同一内容。浮层使用 `--annotation-preview-width`、`--preview-fill` 和 `--popover-shadow`。

加号或画面矩形框选启动原位绘制；工具条位于视频区下沿，支持画笔、圈选、矩形、线条、文字、撤销与保存。可在多个可见轨道画图，共用备注，各份图形独立绑定媒体身份与帧锚点。切帧后草稿失效并禁用保存，回到原帧可继续。备注可选，至少需要文字或图形；兼容保留 severity，UI 不暴露该字段。

归一化图形和原始/片内帧时间存入 ReviewSession，并随评审 JSON 导出；标注记录创建时的 offsetUs/sessionPtsUs，导出还包含当前 alignment。当前偏移用于时间轴标记和跳转，返回对应媒体帧时显示图形覆盖。重新载入槽位清零偏移。`--annotation-ink` 管理绘图颜色；缩略图只作当前会话的本地预览，不导出或上传。
