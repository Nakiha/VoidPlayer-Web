# 验证说明

专注模式玻璃残留复用 shortcuts 双引擎用例：在正式构建后验证进入、闲置淡出时的底板透明且所有受支持的 backdrop filter 均为 none，
退出后恢复原材质。修复前 Chromium 的实际计算样式仍为 blur；调整前缀声明顺序后，压缩产物保留标准取消规则。
沿用现有片源、窗口与淡出等待，只增加计算样式观察，不增加媒体加载、播放或浏览器矩阵。
重发已公开的同版本时，可在对应标签手动运行完整发布流程并设置 `stage_draft=false`：保留全部原生与功能验证和产物汇总，
只跳过最后的未公开草稿创建。产物验收完成后再显式替换公开文件；默认标签发布仍创建草稿，流程不会自动覆盖已有公开版本。

2.0.0 发布修复：macOS 原生构建与运行矩阵改用仍受支持的 `macos-15` ARM64 环境。
静态资源既有发布用例在封存前端目录后再执行打包所用的压缩资源校验，覆盖二者的组合；
封存目录 `frontend-release.json` 由独立的完整前端校验负责，不计入它所封存的静态资源清单。
修复前该组合用例与远端 Linux 打包均报 `Missing static asset: frontend-release.json`；不降低其他资产的完整性检查。
HTTPS 重复播放用例补齐调用者自有媒体库的关闭，等待索引读取者和真实 Worker 退出；旧远端记录在播放断言通过后未退出。
复用既有发布、静态资源和 HTTPS 用例，不新增解码循环；本地组合检查只增加小型临时目录的校验。
空媒体库就绪回归加入既有 `library-incremental` 用例，使用临时 SQLite 和空目录，检查空库、首次加入根与移除全部根；
修复前独立断言为 `false !== true`，远端三平台包均在首次空库启动时报 `Startup timed out`。该检查不启动浏览器或解码器，成本为毫秒级。
独立包的无前端 HTTP 验收沿用原启动次数，改用新数据目录，避免已保留的前端发布使缺失资源的 404 负例得到 200；
前端保留行为仍由原发布用例覆盖，包内 HTTP 指南继续在真实无前端条件下检查。
同一包验收复用原 8 秒目录观察等待，首次读取嵌套媒体前等待后台逐目录发现完成，不再把服务就绪当作全库扫描完成，不新增扫描或重试启动。
上传日志验收按实际报告文件与 API 清单计数，避开同目录的排他锁，并在迁移及备份还原后比对原始报告字节。
旧 schema 1 夹具同时移除当时不存在的目录调度表，避免带入新版本的未来检查时间；包测试配置 1 秒目录复查周期，
用原有等待预算观察重连，保持生产默认复查周期不变。素材仍为原来的两个小占位文件，不新增媒体解码或启动轮次。
旧绑定等待允许渐进检查的 `partial` 或完整检查的 `offline`，同时必须出现 `ESTORAGEUNVERIFIED`、保留原索引并拒绝媒体读取；不将未验证存储视作可用。
分析浏览器夹具在取得固定样片清单前显式完成初始登记，随后仍启动原后台调度；远端 FLV 矩阵修复前因清单缺项访问 `undefined.id` 失败。
沿用原编解码、输入和浏览器矩阵，不增加解码循环；准备阶段只登记原有样片，避免将片源发现时序混入分析行为验收。
完整浏览器发布回归沿用原用例并修正独立预期：4096 纹理采样用声明的浮点拟合尺寸计算真值，避开 DOM 的 1/64 像素舍入，
仍保持原 2 级色值误差；元数据等目标轨道标题原子切换后再读取，键盘操作等对话框及菜单退出完成。
悬浮样式复用自建的同根文件与目录，不依赖 QA 稀疏样片带有子目录；标题缩略按实测字体几何验证先隐藏时间再缩略名称，
时间线沿用同一次 hover，将现有名称约束到可验证的缩略宽度后核对完整路径提示。修复前两引擎远端及本地像素、元数据、提示用例失败。
不新增浏览器、素材或播放循环；增量仅为已有 UI 状态等待、几何测量和同目录导航，默认不扩大单例时限。
菜单用例的所有标注入口统一等待真实对话框/菜单退出、加载空闲和工具条可见，覆盖高对比显示菜单关闭后的同一键盘入口；
远端 WebKit 先前在该入口仍关闭时点击隐藏颜色按钮而超时，不增加按键重试或延长时限。
HLG 容器时间基预期直接读取当前样片的原始 `mdhd`/`hdlr` 字段，不导入应用解析器或增加 ffprobe 依赖；
同步原片含音轨，CI 合成片只有视频且时间基不同，均必须与实际文件完全一致。沿用同一次 HLG 加载，仅增加一次文件读取和少量 box 遍历。
证书引导的中英文富文本说明独立于固定 shell 的节点索引，修复英文尾随标点使后续动态文案停止翻译的问题；
日志下载/上传按钮在窄屏允许换行，复用完整 `ci-i18n` 的原双引擎、四宽度和下载失败恢复检查。修复前两项均在本地与远端失败，不新增套件或视口。
按钮换行仅作用于 640px 以内的视口，普通宽度保留原单行高度；既有 settings 用例继续精确验证描述框与下载按钮等高及 16/8/16 间距。
容器、FLV 与 Range 回归改用公开 `set_reference_decode` 接口选择当前页面的软件解码，不再写已废弃的持久 decoder 偏好；
缺失源回归核对当前的文件名、移除原因及结构化日志。Range 夹具在启动前登记原有三个根，关闭时等待自有媒体库释放。
日志说明复用可访问焦点检查多行提示及点击关闭，避开 Chromium 自动滚动与 hover 同帧触发的提示取消；通用悬浮提示仍由 UI 回归覆盖。
八轨布局等待有限 UI 动画结束，不要求后台索引的无限进度动画停止，并记录既有阶段与失败现场。
前端更新用例等公开的面板和媒体库状态恢复后再比对完整文档，避免把首帧就绪当成所有异步 UI 还原已完成。
关闭最后一个旧版 PWA 文档后，通过浏览器生命周期事件等待待用 Worker 自然激活，再重开播放器；
不调用 `skipWaiting`，不增加重试或媒体加载。修复前立即重开会偶发继续受 A 控制，修复后仍核对首次新导航使用 C。
这些调整不新增素材、浏览器矩阵、解码循环或重试。八轨布局用例的 UI 总时限单独改为 120 秒：
Linux WebKit 软件绘制下，原 60 秒现场在几何验收 39.5 秒、真实面板动画完成 44.1 秒后继续通过视口与专注模式检查，
总时限在标注入口处耗尽；同一场景无页面错误且所有轨道已有真实帧。保留全部布局、采样、点击和关闭断言，其他单例时限及 bench 指标不变。
这是功能用例的退出上限，不将跨机器绘制耗时用作性能门禁；正常通过的实际工作量与素材保持一致。
同一 WebKit UI 脚本包含 44 个顺序场景，统一清单的进程上限相应为 10 分钟，覆盖八轨检查后的剩余场景；其他引擎和套件预算不变。
标注持久化用例在丢失回执后的刷新处等待工作区链接完整打开，并独立确认共享 scope 后才进入绘图；
原失败现场显示首帧已就绪但连接仍在切换，提前编辑触发「请先结束标注并等待本机草稿保存完成」，因此新图形仅在本地。
沿用原回执丢失、绘图与服务器 JPEG 验收，不新增媒体、浏览器、重试或等待预算。
缺失片源的标注历史扩充既有 session 同步用例：关闭片源后保留已有标注、不加入无关未载入标注，明确删除仍生效；
修复前已有历史变成空数组，修复后同一断言通过。只增加内存会话操作，不需要浏览器或 core。

PWA 复用 `npm run test:startup:browser`。Chromium 和 WebKit 都在正式服务停止后冷启动英文播放器，检查跨源隔离，用已有的 546 KiB FFV1 样片验证 WASM 解码和逐帧前进。服务恢复后核对 API 和 206 Range 响应。
普通标签页首次打开不创建离线缓存。WebKit 检查 Mac Safari 首次访问提示及刷新后的去重，点击「安装」弹出警告提示，重复点击只保留一条，设置行的文字和高度保持一致。模拟的独立窗口验证首次下载失败和重新打开后的重试。Chromium 检查原生安装提示的调用、取消和安装事件，分别注入失败和成功的更新，核对旧缓存、当前评审位置和其他应用缓存。
同一用例按 PNG 内容核对安装清单的图标版本，并在停服后读取安装图标和 HTML 声明的三个带版本的图标。Chromium 复用既有升级步骤：新构建等待激活时再开一个窗口，确认它仍使用旧版 HTML 和启动脚本；临时移除旧容器模块并确认站点返回 404，已打开的窗口仍能从当前离线版本导入该模块。旧窗口关闭后新窗口切换到新版 HTML。
文件关联复用同一离线 Chromium 用例。读取浏览器取得的安装清单，在声明的文件入口注入系统交付回调，用真实文件句柄打开 FFV1，再把 gzip 工作区和同一片源一起交付并核对恢复的位置。新增一次同片源恢复，系统默认程序不参与测试。
各引擎增加一次临时构建副本及两次短服务启动。临时 MCP 页面沿用现有用例，检查其页面和服务端均禁用 PWA。

运行 `node scripts/run-tests.mjs browser --case frontend-publication` 可复查前端发布。用例使用准备好的 A 和两个临时生产构建 B、C。普通 Chromium 标签页与独立 Chromium PWA 分别先打开 H.264、定位并添加矩形标注，再连续发布 B、C。旧窗口首次加入 FFV1 时核对真实的 A 版延迟模块与 Worker、第二轨解码帧，以及第一轨帧、播放位置和完整标注。B、C 使用有效的 WASM 自定义段改变测试核心字节，验证旧版本 URL 可从服务端取回 A 的内容。复用两个已有样片；额外成本为两次 Vite 构建与两个临时浏览器上下文。同一用例还检查更新 toast、无法重开本地片源时留在原窗口，以及点击刷新后恢复播放位置、矢量标注、布局、媒体库导航。独立 PWA 在另一个旧版窗口仍打开时验证新版延迟资源可离线读取。静态资源契约另覆盖失败发布、重试、回退、重启和版本清理。

媒体库下屏按钮和轨道徽章复用同名片源浏览器用例。目录和最近打开各切换一次紧凑布局，测量徽章与缩略图的 4px 间距、按钮尺寸与行边界，沿用原素材和下屏操作。

轨道标题时间/PTS 帧号切换复用普通 analysis 的双轨播放用例：同一次播放同时观察分析栏和标题按钮，
等待新排名时必须保留有效帧号、保持宽度，暂停后以包样本中严格小于上屏 PTS 的数量独立核对两轨排名，
并覆盖点击任意轨道同步切回全部时间、回车同步切回全部帧号，以及重载轨道沿用当前格式，两种格式的文字/底色一致。
原素材、服务、播放循环与时限不变，
仅增加按钮交互与 DOM 采样。

CI 修复复用原启动、FLV continuation、媒体 HTTP 和双引擎 diagrams 用例，不新增套件或解码循环。
启动测试同时保留两个端口预订，避免内核立即复用刚释放的端口；保留真实启动、代理和退出检查。
FLV 播放所需的两个 32×32 关键帧及原生 FFmpeg 像素校验值独立存为 `flv-startup-sample.json`，
不再依赖已删除的评分夹具。HTTP 原有 405 断言保留，并补充媒体/兼容库入口的 Allow 响应检查，增量为一次轻量请求。
diagrams 将旧时间格式断言迁至“时间 #帧号 PTS”，等待索引帧序实际返回，保留每轨命中时间和 AU 隔离检查。
修复前的远端失败及本地 `.run/ci-fix-before.log` 记录了缺失夹具和 404/405 差异；不放宽时限或增加重试。

扫描反馈沿用 admin 浏览器用例：移除全量入口、状态列与独立进度段落，每行扫描图标位于移除图标左侧。
拦截单目录 POST 的确认，验证点击即旋转、确认后直到真实结束仍旋转、重复点击不重发、排队状态不冒用另一根的进度；真实悬浮显示状态/当前位置，
停止/失败/离线及新目录待保存也由同一个 tooltip 呈现。后台已有目录差异用例增加未初始化双库的明确单根检查与在途去重，另一库必须完全未扫描；
HTTP 用例核对 rootId 派发与未知/非法根拒绝，旧全量派发不能满足该预期。真实保存、草稿保护和窄屏布局继续覆盖，不新增视频解码。
library-incremental 复用原四文件目录，执行单文件子树扫描后总量仍为四，再验证删除后的缓存失效；旧 job.files 口径会错误显示一。
全局消息沿用播放器 toast，在原 503/恢复场景验证顶层浮动、重复错误去重、关闭及恢复清除、内容位置不变；缓存冲突和实时语言切换同步迁移。
复用已有服务、页面和文件，不增加媒体或解码；额外快照与一次小目录遍历只增加状态交互成本。

片源上下屏沿用既有同名双库场景：已打开项悬浮关闭、菜单上下屏必须只影响匹配源，主区域重复点击不重复添加；主按钮和关闭按钮为并列控件。
原文件菜单场景增加外部点击只关闭不触发下层、500ms 长按/滑动取消/松手点击抑制，并覆盖路径按钮长按；复用原素材，约增加 1.65 秒等待。
近期日期沿用 i18n 单测，以固定时钟验证今年省略年、跨年保留年、两者均保留时分秒。库集合恢复胶卷，单库使用 regular 硬盘组图标，
分组箭头与返回按钮同尺寸；挂载与文件共用按实际行序设置的斑马色、缩略图/图标底色，不新增边框或媒体矩阵。

媒体库/最近打开的 summary 复用普通按钮的按下与释放材质。既有 press 用例以亮/暗主题真实 mouse down 验证按下背景不同于 hover，
并检查共享 240ms 过渡；复用当前空列表，不增加媒体，每引擎增加约 2 秒交互等待。

媒体库旧历史清理替换已有失效引用交互场景：确认 404、missing 或已就绪的新版本时持久删除旧记录，不再渲染检查/重选入口或弹重新关联提示。
503、离线根目录和仍在写入的文件保留历史；界面不显示未确认的条目，恢复连接后自动重现。既有 SourceCatalog/引用单测核对版本、隔离和恢复，
基础浏览器复用原 smoke 样片，验证同 ID 新旧版本去重、永久清理、503 重试和不自动打开媒体；以服务端观察替代旧行点击，不增加解码循环。
工作区导入仍保留版本核验与跳过失败源，仅移除“重新选择并检查标注”式引导。

缩略图破图绘制沿用既有全新浏览器配置场景：拦截一次缩略图返回损坏 JPEG，核对 error 当场及本地回退期间图片隐藏，
保留原图槽尺寸与文件名位置。就绪断言要求解码完成且实际可见；不增加视频载入，只增加一次小图片故障请求。

缩略图折叠连续性沿用既有缓存浏览器用例：监听真实图片 src 属性，快速折叠、长时间折叠（2.5 秒）和双/三击都不得清空或重写已载入图片，
隐藏时保留已解码图片，离开该目录/移除行后清空地址并释放引用。修复前快速折叠会产生 src 清空/重设，记录在本机 `.run/recent-fold-reload-before.log`。
每引擎增加约 2.65 秒等待，不增加媒体/解码循环；这是用户明确接受更多内存以消除折叠重载的行为约束。

最近列表折叠扩充既有缩略图浏览器用例：复用已生成的首帧，折叠再展开核对原节点和图片恢复（后续连续性规则要求折叠保留地址，仅移除行时释放）；
真实双击/三击标题检查没有浏览器文字选区。修复前 Chromium 恢复等待超时，图片节点仍连接但布局框为零（固定缩略图盒仍为 40×40），
记录位于本机 `.run/recent-fold-before-chromium-detail.log`；WebKit 同场景原先通过。复用原样片和缓存，不新增解码或媒体循环。

文件名 tooltip 沿用基础浏览器已有路径场景：完整名称不提示，真实截断后显示完整路径，恢复宽度后自动隐藏，
同时覆盖 viewport、轨道栏、时间线及片源行/元数据悬浮。复用原片源，仅增加两次约 500ms 的否定观察，不新增套件或媒体。

挂载容量与整行添加扩充既有媒体库用例：`library-storage` 注入已知块数，独立核对普通用户可用空间（bavail）/总空间和离线清空；
既有 library-index 的阻塞 IO 场景继续要求浏览仅返回缓存。浏览器沿用原片源加载、容量满、取消/替换、右键和重复载入场景，
将旧加号入口迁到整行按钮，轨道移除迁到 viewport 关闭，取消迁到底部状态区；文件行与工具间距检查 4px、无内嵌动作按钮。
原亮暗 hover/press 对照改为整行，验证按下反馈；保存工作区、引用失效与本地重选仍保留。复用原样片/套件，不增加解码循环。

媒体库挂载式重构替换既有范围下拉/搜索覆盖层职责：根页的挂载库与最近记录折叠分组、同层浏览和目录路径一一对应，
单输入框同时覆盖 scoped search、协议导航、中文输入确认、清空和工作区恢复，路径菜单覆盖鼠标右击与 Shift+F10 的精确拷贝、外部点击关闭及与文件菜单的互斥。
原有目录分页、旧结果原子保留、离线恢复、版本引用和启动历史继续由 `check-library-browser` 验证；旧 all/recent 快照显式迁移根页。
基础浏览器原有焦点/材质覆盖转移到路径按钮与统一输入框；同名双库载入改为真实切换挂载目录，载入中仍可浏览另一库并取消或替换。
`shortcuts`、`theme`、i18n、缩略图、保存工作区与独立包浏览器用例同步更新入口，不保留隐藏的旧控件。
复用现有样片和浏览器清单，不新增媒体/解码矩阵；导航与右键操作替代旧下拉/展开操作，仍保留真实滚动、悬停和回归断言。

Finder 风格媒体库路径栏扩充既有 `check-library-browser` 目录场景：核对根目录/子目录、footer 顶部定位、无新增边框、
长路径叶节点可见、Enter 返回上级和深链接恢复，且浏览不打开视频。复用原有项目归档与 `folder-0`，每引擎增加一次
进入空目录和一次返回请求，不新增媒体、播放循环或套件。原有分页、搜索、离线、历史版本和工作区恢复检查保留。

普通按钮保留焦点时的左右逐帧扩充已有 `shortcuts` 用例：片源、标注和设置按钮分别前进/后退一帧，
要求位置真实变化、焦点保留、按钮不被激活且不误增键盘焦点提示。菜单、设置对话框和搜索输入的方向键不得逐帧，
保留原有 Tab/菜单焦点提示检查。复用单个 AV1 样片，每引擎增加六次单帧操作及无解码的控件检查；
不新增素材或播放循环。修复前片源按钮聚焦后 ArrowRight 等待位置变化超时，证据为本机 `.run/button-arrow-before.log`。

逐帧标注按钮闪烁扩充已有 `stepping` 浏览器场景：复用 AV1 + FFV1 的两次左右键逐帧，观察解码期间按钮的
真实属性与样式，要求原生启用、透明度和 hover 颜色保持稳定，忙碌操作仍通过 aria-disabled 和点击拦截拒绝。
空会话保持原生禁用；不增加样片、解码循环或播放等待，仅增加约 300ms hover 稳定窗口与属性观察。
新增亮度断言在修改前失败，记录位于本机 `.run/annotation-step-before.log`。

专注退出按钮渐隐扩充已有 `shortcuts` 浏览器用例：真实计时核对两秒宽限、静止渐隐、按钮内移动重置计时、
移出后渐隐、透明命中区唤回、键盘焦点保持可见及 F 退出；同时检查 tooltip 不残留、画面几何与播放状态不变。
每引擎增加约九秒等待，不增加媒体加载或播放循环。新增静止渐隐断言在修改前超时，记录为本机 `.run/focus-idle-before.log`。

底部播放栏沿用既有八轨浏览器场景，增加播放栏始终贴住 viewport 底部、底行标题位于播放栏上方的几何断言，
并保留画面和尺寸标签避让检查。复用原来的 5–8 轨、宽/高视口矩阵，不增加视口、媒体或播放循环；
新增断言在修改前因播放栏被底行标题顶高 32px 失败，记录位于本机 `.run/grid-transport-before.log`。

多组田字布局扩充既有 `viewport` 单元与基础浏览器的八轨场景。纯逻辑验证 1–4 轨兼容、5–8 轨两向分组、
源宽高比、统一像素/独立 fit 差异和方向切换余量；浏览器复用已加载八片，通过隐藏尾轨覆盖 5–8 轨的宽/高视口，
独立核对分组位置、每组上下标题、画面与尺寸标签避让和最底行播放栏。每引擎增加八次轻量视口调整、两张截图，
不新增媒体加载、套件或播放循环。五轨场景在修复后通过；在相同场景注入旧的“第二行起全在底部”规则，
确认 E 标题位置断言失败；等价故障记录位于本机 `.run/grid-header-before.log`。

轨道 header 时间显示扩充既有 `menu` 浏览器用例：短标题在中等窗口宽度保留时间，空间不足先隐藏时间，
隐藏时间后仍不足才省略标题；核对控件不重叠、固定视口改长/恢复标题及四轨恢复宽度后的重新显示。
原规则在 900px 窗口过早隐藏时间；优先保留时间的中间实现则在 280px 提前省略标题。
沿用已有媒体与浏览器层，仅增加两次视口调整、标题切换和布局读取，不新增素材、套件或解码循环。

工作区请求去重扩充已有 `saved-workspaces-ui` 和双引擎 saved-workspaces 浏览器用例：Enter 清除延迟搜索且不提交输入法确认，面板/打开各只确认一次身份，能力不可用不读列表，cookie 身份变化仍围栏旧打开。独立预期为每个用户搜索只请求一次；浏览器仅增加一个搜索和约 260ms 观察窗口。页面桥既有 existing-page 用例增加一个无媒体普通标签的关闭检查，并核对已配对页面仍真实 retire；不改变授权或 Worker 生命周期。

`annotation-sync` 用真实 IndexedDB 适配与可控时钟验证 3/6/12/15 秒退避、15 秒封顶、编辑/可见性/焦点/身份/重连恢复及活动事件读取失败不阻塞状态同步。已有 sharing 浏览器用例每引擎增加 32 秒空闲观察和一次本地编辑：空闲事件与状态读取各不超过四次，编辑须在 2.5 秒内发起写入；既有远端标注、冲突、重启与删除覆盖保留。不增加媒体矩阵或性能门禁；请求数量和本机耗时不代表跨机器吞吐。

IP 访问日志扩充既有 `admin` / `http2` 用例：真实 socket 与生产网关覆盖 HTTP、HTTPS/1、HTTP/2，伪造两种转发头仍须记录真实 peer；独立核对映射 IPv4、IPv6、未知地址、请求 ID、去查询路径、最近快照及 finish/close 仅记录一次。新增断言在修复前因缺少 IP 字段失败；管理页既有请求观察场景同时核对 IP 渲染。HTTP/2 取消用例等待真实 close，允许 Bun 在显式取消后报告 `NGHTTP2_CANCEL`，其他错误仍失败，原有 IO 释放与同会话继续读取断言保留；旧 HEAD 同样复现的等待误判证据在本机日志内。没有新增媒体、浏览器循环或套件，增量仅数个轻量 HTTP 请求。

真实 WASM 服务回归在既有摘要页恢复/缓存缺口场景内增加冷包交付检查；既有 diagrams 浏览器场景增加冷摘要零逐帧 HTTP 下载断言，并保留热缓存零解码和 300 个不同 AU 的原 reader 证据。没有增加输入循环、媒体素材或性能通过阈值；原有生命周期、取消和缓存校验仍执行。前后请求频率按相同操作窗口做本机诊断，不把请求减少直接称为跨机器性能达标。

管理页浏览器回归末尾恢复此前暂停的 clock 并置前管理页：6.5 秒验证原 actor 的实际条件响应，再隐藏观察面板 4 秒验证停止观察及零概览读取。读取服务端 finish 状态和真实条件头，避免 WebKit 把重验证响应在浏览器协议中显示为 200；仍验证缓存视图保持渲染。每引擎约增加 11 秒，不新增媒体/算法循环；独立预期来自 HTTP 304 和可见性行为，不能只检查页面文本或源码定时器。

套件与稳定 case ID 以 `scripts/testing/manifest.json` 为准，统一入口为 `scripts/run-tests.mjs`。`package.json` 保留原有单项命令。不要把某次历史测试数量或构建成功当作当前兼容性结论。

日常 PR/main 验证在 `.github/workflows/checks.yml`；完整兼容性与独立发布在 `.github/workflows/release-preview.yml`。两者共用 `prepare-cores.yml`，core 缓存命中后仍核验固定来源及 ABI。

`test/unit/http2.test.ts` 在 Node 与固定 Bun 运行时验证生产 TLS 网关的 ALPN、HTTP/1.1 回退、`:authority`/Host 冲突、真实 peer 归属、同源身份写入、Range/HEAD、无 Content-Length 的 DATA 正文、媒体/NDJSON 单流取消，以及 session 排空和强制关闭。浏览器 HTTP 入口回归另检查 HTTPS 实际协商 HTTP/2 和身份写入；性能仅在本机同条件比较。

| 触发 | 必跑内容 | 边界 |
| --- | --- | --- |
| PR、main 推送 | `source` 与 `ci-node-media` 构成完整 Node 用例并集（当前数量由清单枚举）；`ci-pr-browser` 覆盖 Chromium/WebKit 核心流程 | 源码、共享样片准备、两个 core、三个隔离的媒体 Node 分片、两个浏览器、最终汇总；不打三平台包，不运行性能测试 |
| 显式运行 Full verification、版本标签 | 全浏览器矩阵、完整缓存流程、HEVC 全帧验证、三平台 × Node/Bun、三平台原生包与发布集校验 | 全部成功才能产出 verified release set；只有版本标签生成未公开的 Release 草稿 |

日常浏览器选择在统一 manifest 的 `ci-pr-browser` 声明，包含身份/Agent 标注、连接引导和分析 UI。完整播放、缓存和容器矩阵仍在显式全量验证中。

需要完整兼容性结论或准备发版时，显式运行全量验证；变更核心 ABI、解码/呈现、时钟、持久化协议或发布流程时，至少运行受影响的专项验证，并明确尚未覆盖的平台。普通修改不再自动启动全量发布流水线。完整用例和原超时继续保留，不能靠删除失败、增加重试或扩大阈值使汇总变绿。`Required verification` 在任何前置失败、取消或跳过时失败；未完成状态不算通过。

媒体 Node 的完整集合仍为 `ci-node-media`；日常执行分成清单中的三组：
`ci-node-media-analysis`（分析 core/码流）、`ci-node-media-containers`
（TS/JS 容器与包身份）、`ci-node-media-playback`（播放与评审）。
每个原用例必须恰好属于一组，三组在 Linux/macOS/Windows 上的选择并集必须
等于完整分区；命令、required、fixture 与整例时限复用原登记，不按 hash、
改动路径或测得速度跳过用例。当前分组为 8/8/44 项。

GitHub 的三个 matrix job 有各自的检出、素材、core、服务、Worker 和报告，
不在同一工作目录并发修改素材。共用固定准备 action 与缓存，`fail-fast: false`
保证一组失败时其余组仍给出结果；最终 `unit` matrix 和 Required verification
均须成功。单个分片 job 的总预算30分钟，原单例 watchdog不变。全量发布仍可
直接执行完整分区。单机复现请逐组执行，不能在同一 checkout 盲目并发：

```sh
node scripts/run-tests.mjs ci-node-media-analysis
node scripts/run-tests.mjs ci-node-media-containers
node scripts/run-tests.mjs ci-node-media-playback
```

码流分析的 `ci-analysis-browser` 保留完整本地套件。全量验证将 MP4、legacy FLV、enhanced FLV、fMP4、TS、JS 容器六个矩阵分片分别放在 Chromium/WebKit 的独立并行 job 中，使用对应 `ci-analysis-matrix-*` 选择器；每个 job 只跑一个矩阵 case，覆盖格由清单与矩阵文件枚举。流式图表、增量索引、几何、布局由 `analysis-browser` job 的 `ci-analysis-ui` 必跑，使用逐例生成的小素材，不下载 QA 样片。普通只读分析面板两引擎用例归入已有样片环境的 `uncovered` job。真实分析 Node 用例由 `unit` job 的 `ci-node-media` 必跑，不在每种浏览器重复执行。`release-set` 同时依赖 `analysis-browser` 与整个 `analysis-matrix`，任一分片失败、取消或跳过都不能产出验证通过的发布集。

各矩阵、流式图表与增量索引 case 仍拥有独立服务、浏览器、临时目录和 600 秒整例 watchdog。原有逐操作超时、整片 ready/EOF/帧数、取消与身份断言保持不变；云端不采集性能基准。本机性能命令及阈值保留。直接调用 `node scripts/testing/browser/media/bitstream-analysis.mjs <engine>` 会依次运行 matrix、diagrams、index 三组；每组独占服务、浏览器、临时素材及报告，一组失败仍完成其他独立组，最终非零退出。

统一 runner 会按清单准备明确标记 `prepareOnDemand` 的本地衍生 fixture，目前仅 `analysis-flv`：任一所需输出缺失时，先验证三个固定 MP4 输入，再调用 `node scripts/make-analysis-flv-fixtures.ts`，重新检查六种基础 FLV 与 H.264 损坏/重复配置变体。每次套件内只准备一次，生成器拥有独立 300 秒超时、取消与子进程清理；失败记录在套件目录的 `fixtures/analysis-flv/`，依赖它的 case 失败，其他独立 case 继续。`unit`、`media` 和浏览器入口共用此前置流程；core、基础视频和 FATE 等外部资源仍须事先显式同步，不会自动下载。

## 验证层级、职责与 CI 分工

新增用例先明确一个可解释的行为、必要环境和独立的预期依据，再选择层级。纯计算放 Node 逻辑；取消、迟到结果和资源释放放可控异步模块测试；真实解码/像素身份放媒体集成；焦点和手势放浏览器交互；完整应用流程只覆盖实际接线。一个行为可以有多条相互支持的断言，不需要机械拆成每个断言一个 case。禁止为了减少维护成本而删除矩阵、扩大容差、增加重试或用同一实现生成预期来掩盖错误。

新增或扩充测试与实现同 PR 审查四件事：保护的行为及现有覆盖缺口、独立预期、必要环境、增加的运行成本。修 bug 应给出修复前失败和修复后通过的证据；无法直接回放旧版本时说明原因及替代故障注入。默认扩充已有职责用例；新增文件应有独立职责，优先复用现有夹具。浏览器入口内部增加循环、素材、输入组合或重复初始化，也属于成本变更。

纯逻辑回归保持无媒体/core/服务依赖。浏览器证明 DOM、手势、焦点、真实呈现与接线；已有纯函数的数值穷举由 Node 负责。真实帧身份、300 AU 完整消费、跨浏览器零解码缓存复用、取消和完整排空保留真实媒体证明。迁移或合并时逐组记录旧行为与新责任的对应，确认替代证明后再审查历史基线；文件数、断言数和入口总数不作为覆盖充分性的依据。

本地开发先运行 `test:fast`、受影响领域或精确 `--case`；PR/main 仍运行完整 Node 并集及两引擎核心浏览器流程。完整兼容性矩阵由现有手动/标签流水线承担，发布还需固定产物的三平台程序包及发布集验收。每次验证说明实际范围；选中子集的绿色不能冒充完整验收。

成本目标按逻辑、媒体、浏览器职责和同条件基线评审，不照搬统一的秒数上限。日常浏览器选择保护必需行为、引擎和环境，而不冻结入口总数。运行时间用于定位重复准备和慢场景，不设置云端性能门禁，不参与选例、超时或通过判定。

本地 `unit` 是完整入口。CI 的 `source` 与 `ci-node-media` 在 Linux Node 执行中必须互斥，且并集严格等于 `unit`；新增用例缺少归属或被两边重复选择都会使清单验证失败。独立的 `analysis-logic` job 已移除，其用例仍属于 `source` 并受门禁保护，原 `ci-analysis-logic` 仅保留为本地领域筛选。原生 Node/Bun 或不同平台的重复有独立兼容性目的，继续保留。发布汇总同时依赖源码和媒体分片，任一失败、取消或跳过均不能生成验证通过的发布集。

完全由 `source` 用例组成、且无媒体/core/构建/外部工具依赖的独立选择使用两个有界执行 worker；每项仍拥有独立进程、临时目录、日志与原 watchdog。结果按清单顺序发布，全部完成前不能通过；取消回收所有活动子进程，排队项只记录取消。媒体、浏览器及有依赖顺序的 npm 阶段保持串行。`--plan` 与实际结果均声明并发度；并发时终端只展开失败日志，完整逐项日志仍上传。

`--plan` 输出本次选择的层级、责任、实际执行模块、引擎/输入、素材、工具和预算，不启动服务、不构建、不运行测试。每次实际执行也在报告目录写入 `plan.json`。已有用例的层级可按其所属目录给出初始分类；尚未人工梳理的责任保持 `reviewNeeded: true`，不把分类自动视为已经覆盖某项产品能力。analysis 先作为明确责任的试点：

| 行为组 | 责任 / 预期依据 | 必要环境 |
| --- | --- | --- |
| navigation | 区间编辑、缩放锚点、seek 分离、参考层级 | 生成的 H.264 / HEVC 小素材 + 两个 core |
| layout / overlay | 首帧布局、滚动、焦点及覆盖层隔离 | 生成的双轨小素材 + 两个 core |
| matrix | 已有完整编码 × 输入 × 解码策略、像素与缓存/Range 断言 | 对应固定 QA 样片 + 两个 core |
| diagrams | 可见 GOP、并发准入、图表交互、多轨身份和能力限制 | 按需生成 stream / incremental / queue / depth 素材 |
| index | 部分 FLV 索引的暂停、继续、取消及非 EOF 契约 | 生成的增量 FLV + 可控服务端 gate |
| geometry | 旋转、裁剪、SAR 与 RGBA 回退的实际帧身份 | 原有生成器 + 两个 core |
| 普通 analysis 页面 | 只读容器查询、双轨配对、DTS、播放共存 | 复用 `uncovered` 的 QA 样片环境 |

行为组在 `scripts/testing/analysis/plan.mjs` 声明职责、阶段和生成素材 profile；场景函数位于 `scenarios/`，无导入即执行的副作用，通过显式 context 使用当前 case 的服务与控件。`fixture.mjs` 只拥有生命周期和故障 gate，`controls.mjs` 只操作公共 UI/Session facade；预期和断言留在场景内。每例生成素材位于其临时目录，成功/失败均由夹具删除。领域阶段用 `stage()` 命名，保留 case 的整体 watchdog；内部等待继续使用原逐操作期限，命名阶段不会偷偷增加 30 秒限制或延长整例预算。

分析浏览器的输入职责与通用 UI 职责分别验证：

| 行为 | 执行责任 |
| --- | --- |
| 双轨 overlay 的输入、真实 picture 身份、opt-in、缓存激活、显示/hover 零新增分析、关闭工具条后的帧更新 | `layout` 在本地文件与媒体库分别运行，两种引擎保留 |
| 轨道/图表显隐及长按、窄/宽视口 × 最小/最大高度 × 单图/组合图的首帧与滚动 | `layout` 使用已验证的媒体库双轨运行一次完整 UI 矩阵；三种背景 × 两种主题的材质验证保留 |
| 300 AU 完整消费、共享视口与偏移、工作区输入恢复 | `charts` 在本地文件与媒体库分别运行；跨浏览器恢复仍核对 300 个不同 AU、零解码和零逐帧下载 |
| 指针/键盘、PTS/DTS、主题像素、卡片与纵向滚动 | `charts` 使用媒体库运行一次完整交互矩阵，两种引擎保留 |
| 几何和时间投影的数值边界 | 既有 `analysis-geometry`、`analysis-canvas`、`analysis-projection`、`analysis-selection` Node 用例；浏览器继续证明实际 DOM、像素和接线 |

合并的是通用 UI 与输入来源的重复交叉执行，不缩减编码、容器、深度或解码策略矩阵。输入特有断言仍在各输入内执行；后续新增 UI 行为就近加入一次通用交互，不重新复制整段输入循环。

analysis 行为组和普通 analysis 页面均先把已构建的静态资源复制到自己的临时目录；服务端、浏览器 Worker 与矩阵的 build-info 校验读取同一快照。复制前后及副本的字节摘要必须一致，复制期间遭遇重建则在启动浏览器前明确失败；之后其他本地套件重建 `dist` 不会删除当前页面将要加载的分块或替换 core 身份。快照随 case 清理。其他尚未迁移的专用脚本仍应避免在运行中重建其共享 `dist`。

benchmark 的诊断流程位于 `scripts/testing/playback-diagnostics.mjs`；故障注入测试直接调用该函数验证诊断失败、落盘和原始异常保留，不再按源文件缩进和字符串边界截取代码。新增测试应优先操作公开函数/协议和可观察结果；源码扫描只用于明确的架构边界。

跨浏览器缓存恢复的 GOP 证据来自应用实际读取的同一响应流：只旁观原 reader 返回的字节和 EOF，不 clone 响应、不增加读取、不重新请求接口。Linux Chromium 的 DevTools 会把已被应用完整消费的部分响应标成 `net::ERR_ABORTED`，所以 `requestfinished` 不能作为已交付 picture 的唯一依据。HTTP 事件单独保留作诊断；应用读取的 HTTP/JSON 错误、未完成状态仍使测试失败，真正的中途取消必须有 AbortSignal 证据且不计覆盖。终态必须恰好消费 300 个不同 AU、全部来自批量缓存包，并保持零解码、零逐帧下载和完整缓存命中计数。新浏览器页的失败场景单独保存截图、实际读取与网络证据。

迁移时原 501 条浏览器行为断言中，497 条移入场景及诊断函数，4 条汇总检查留在入口；此数量只记录本次迁移核对，不作为未来冻结文件布局或断言数量的门禁。长期保护使用稳定 case ID、矩阵轴、required 属性、职责、实际执行及故障注入证据。历史覆盖下限仍保留，已有命令与预算没有缩水；未来迁移应审查行为映射，不能只修改计数让检查通过。

```sh
node scripts/run-tests.mjs ci-analysis-ui --plan
node scripts/run-tests.mjs unit --plan --platform linux
node scripts/run-tests.mjs ci-node-media
```

## 统一套件与单项筛选

| 入口 | 范围与准备 | CI 对应 |
| --- | --- | --- |
| `npm run test:fast` | 明确登记的轻量 Node 逻辑与测试基础设施契约；不需要媒体、core 或浏览器 | 本地快速反馈；CI 的 source / ci-node-media 构成完整 Node 检查 |
| `npm run test:source` | 所有不依赖媒体、core、浏览器、外部工具或构建的 Node 逻辑测试；新增适用用例必须登记 | 日常与全量的 `source-logic`，不等待解码器构建 |
| `npm run test:contract` | 清单、覆盖下限、独立结果、生命周期、发布依赖等契约 | 日常 source；全量 release identity 在安装依赖前也检查清单 |
| `npm run test:suite -- unit` | 全部 Node 测试，包括真实 WASM 与媒体断言；准备完整媒体环境 | CI 为 `source-logic: source` 与 `unit: ci-node-media` 的互斥并集 |
| `npm run test:browser:all` | 自动化浏览器检查及内部矩阵；Chromium/WebKit、媒体/core/FFmpeg，默认构建一次 | 全量流水线的 `ci-audio`、`ci-playback`、`ci-cache`、`ci-flv`、`ci-fate`、`ci-analysis-ui`、`ci-analysis-matrix-*`、`uncovered`、`flv-startup` 与 HEVC 四格矩阵 |
| `npm run test:media` | 真实媒体 Node / 浏览器检查；包括特殊的可信 HTTPS 功能用例 | playback / hevc-browser job；可信 HTTPS 仅在一次性 CI 主机执行 |
| `npm run test:suite -- release` | 固定 core 来源、原生归档、归档浏览器及三平台汇总；需先生成对应产物 | decoder / native-release / release-set；打包及草稿操作仍由 workflow 管理 |
| `npm run test:perf` | 索引构建、争用和可信 HTTPS 播放性能；所有结果显式 informational | 不在 GitHub CI 执行；在明确的本机环境单独验收 |

`browser` 是自动化浏览器套件。需要 Windows 可见桌面的 Chrome/Edge 色彩与 WebGPU 检查属于清单中的 `manual-regression`，仍使用原有专用命令；外部服务、用户指定媒体的诊断/实验/基准属于显式工具分类，不会自动变成发布门禁。清单记录限制和理由，不能把 `npm test` 当作 fast，也不能把旧 `test:browser` 当作完整浏览器套件。

FLV 浏览器回归固定 640×480 视口，两种引擎均解码原始尺寸的输入。Chromium 的隔离 headless 进程显式启用 SwiftShader WebGL，避免 GPU 黑名单把整帧 YUV 转换送进逐像素 CPU 兜底；这不代表物理 GPU 或大视口性能验收。普通本地命令仍按原有全部性能阈值必过。GitHub CI 不执行性能基准：FLV、Range、参考解码、HDR、分析矩阵与 HTTPS 功能流程验证实际呈现帧的推进、身份和暂停稳定性；HTTPS 继续做三轮双轨播放、队列容量和资源释放检查。`VOIDPLAYER_FUNCTIONAL_ONLY=1` 可在本机复现该功能路径，普通本地命令仍保留原基准阈值。历史云端性能报告只保留为历史证据，不作为当前验收结论。

HEVC 时间线检查保留每个输入两轮各 600 帧、每帧源尺寸截图、帧身份和 seek/逐帧/尾帧断言。Linux Chromium 每次全尺寸截图实测可耗时约 0.6–1.4 秒，因此 Chromium 单项总预算为 30 分钟，CI job 留出 35 分钟；这不是实时播放性能阈值。每 100 帧以及打开、seek、重开边界记录进度和呈现/截图/读回耗时；页面连续 180 秒没有进度则立即失败并输出最后阶段，关闭页面与浏览器。播放基准的帧率、延迟与停顿阈值不变。

Node/WASM 单元由独立 `source-logic` / `unit` job 分工；全量流水线的串行 `playback` job 包含音频、播放、片源 UI、标注/缓存、FLV、FATE 和可信 HTTPS 检查。Linux 实测前序检查全部通过后，HTTPS 可在第 35 分钟才开始；该 job 总预算为 45 分钟，为后续检查和报告上传留出余量。统一清单中的各用例时限、FATE 步骤时限和必需断言均保持不变；不能将总预算取消解释为已完成 HTTPS 验证。

analysis matrix、FLV startup 和 HDR 功能套件通过 `scripts/testing/playback-presentation.mjs` 等待真实 Session 呈现事件：commit 与实际帧时间必须严格前进，源/generation、已提交帧和可用的精确 picture 身份必须匹配。20 秒无严格进展、60 秒总期限及独立 65 秒宿主 watchdog 限制宿主等待（浏览器清理由调用方 finally 负责）；重复帧与元数据心跳不能续期。暂停后保留原 100ms 稳定性观察，并拒绝迟到呈现。playing 时长从实际进入播放起计算，中途暂停再恢复也失败。只读窗口订阅直接复用 Session 状态与呈现事件，不复制帧资源或改变渲染/解码算法。

本机运行仍保留原 1/1.5/2/4 秒 benchmark 窗口和阈值；GitHub CI 不采集这些样本，也不生成性能判定。功能用例仍拒绝错误、错源/错帧、异常中断和暂停残留。FLV 分辨率/open-GOP 的实际帧仍须推进超过既有 100ms 媒体下限，再核对帧所属尺寸和显式后段 seek；缓存 workload 仍做 20 次播放并验证缓存与几何行为。功能等待超时用于发现卡死，不是吞吐或帧率指标。

```sh
npm run test:manifest
npm run test:suite -- browser --list
npm run test:suite -- browser --engine webkit --list
npm run test:suite -- --case browser-menu-webkit,browser-settings-chromium
npm run test:suite -- browser --case hevc-timeline-webkit-remote
npm run test:suite -- ci-native-console --platform win32 --list
```

`--case` 使用精确 ID，可逗号分隔；与套件、引擎、输入筛选取交集。带内部多引擎/输入循环的脚本作为一个 case 整体执行，筛选不会改写它的内部覆盖。`--platform` 仅用于枚举，不允许在另一平台伪执行。`--list` 输出适用 case、命令、引擎、输入、平台、夹具、外部工具、超时、产物目录、required 属性及不适用理由；空选择不算通过。参数拼写错误直接失败。缺少夹具、工具、浏览器或原生包是失败，不是自动跳过。

清单中 `fixtures.*.prepare` 给出准备命令；suite 不隐式下载或更换参考结果，仅为明确标记 `prepareOnDemand` 的本地衍生 fixture 生成缺失输出。CI 每个 job 只准备一次可复用媒体/core，并继续负责下载、系统依赖、浏览器和平台矩阵。内部断言专用的可写夹具仍由各 case 自行生成。

### 解码 Worker 的消息契约

`src/media/workers/worker-protocol.ts` 定义 FFmpeg 与 packet Worker 的命令、请求、响应和渐进索引事件。
`WorkerRpc` 位于 `src/media/workers/worker-rpc.ts`；FFmpeg 的旧导出保留兼容。调用者只传命令和对应参数，
响应从命令推导；Worker 用 `workerReply` 按请求命令检查回包。索引输入单独按 action 区分，
不占用新的 RPC 或改变 ready/batch/complete/error 的确认顺序。

`node-worker-rpc` 登记在 fast、unit、contract 和 ci-playback。它运行编译期负例
（未知命令、缺字段、错误字段、任意结果类型及错误回包）与 Browser Worker 接口、真实
Node worker_threads 的 transport 测试。负例位于 `test/helpers/worker-protocol-types.ts`，
随 `tsc --noEmit` 和 build 编译；删除类型约束会导致未使用的 `@ts-expect-error` 报错。
真实媒体仍由现有 FFmpeg、FLV 和 MP4 用例验证，播放性能阈值保持不变。

消息格式仍为 `{ id, type, ...payload }` 和 `{ id, ok, data/error }`；结果依靠请求 ID
对应 pending 请求，类型约束针对同版本内的 Worker，不在每帧路径增加序列化或结构校验。
帧描述与缓冲范围继续由媒体适配器验证，取消后迟到的 VideoFrame 由 transport 关闭。

### 构建、隔离与报告

普通套件运行会为需要构建的 case 构建一次。多个 CI 步骤复用同一个源码/配置的构建时使用：

```sh
node scripts/run-tests.mjs --prepare
node scripts/run-tests.mjs ci-audio --prepared
node scripts/run-tests.mjs ci-playback --prepared
node scripts/run-tests.mjs uncovered --prepared
```

`--prepared` 必须有当前 job 显式生成的凭据，校验源码（包括未提交改动）、配置、Node/平台、实际 core 字节和 dist 输出；过期或损坏时失败。普通运行不自动读取旧凭据。不同平台/job 不共享构建凭据。构建日志在报告下的 `build/`，显示本次构建或验证后的复用。

新入口的选择清单在 `.run/test-suites/<suite>/selection.json`，逐项日志和聚合结果在同目录的 `<case>.log`、`results.json`；单例筛选默认目录为 `selected`，可用 `--directory` 另选目录。旧 runner 仍支持 `node scripts/run-browser-regressions.mjs uncovered` / `flv-startup`，保留 `.run/browser-regressions/<suite>/` 的报告路径与 case 名。

`results.json` 记录总时间、构建时间、并发度和每项前置准备/执行时间；`summary.md` 列出最慢项，由顶层 CLI 追加到 GitHub job 摘要，子用例和故障注入不能污染 job 摘要。公共浏览器夹具在成功、失败及取消后写入 `timings-<case>-<engine>.json`，保留行为阶段和清理耗时；套件摘要只读取所属 case 本次执行开始后的阶段证据，避免复用目录中的旧通过记录。嵌套阶段可以重叠，不相加冒充总时间。报告辅助输出失败不改写原测试结果，未完成或失败的结果仍按原门禁处理。

每个 case 是独立子进程，断言失败、准备失败或超时后仍运行其他独立 case；required 的失败、取消或缺失结果使总检查失败。报告从运行前开始写入，未完成的通过前缀不会成为通过套件。informational 失败保留原始退出码、日志和状态，但不阻断 required 聚合。纯 informational 套件有失败时仍返回非零，CI 在独立性能步骤使用 `continue-on-error` 并显示警告。SIGINT/SIGTERM 会清理活动子进程树并记录取消结果。父级 runner 为每项提供独占系统临时目录（TMPDIR/TEMP/TMP），正常、失败、超时和取消后均删除；即使子进程被强制结束也不会绕过该清理。报告记录 temporaryDirectory、temporaryDataRemoved 与独立 cleanupErrors，日志和失败截图目录保留。

13 类回归（menu、settings、theme、shortcuts、feedback、mark-cards、color-settings、metadata、stepping、timeline、annotation、annotation-rendering、workspace）已迁入 `scripts/testing/browser-fixture.mjs`：每个 case 独占临时 SQLite、随机端口、浏览器/context 与产物目录，正常完成、断言失败、部分启动失败、超时、取消均按逆序清理。失败产物包含 case/engine/阶段、原始异常、控制台、页面错误、Range 请求、可用的会话状态、截图与 DOM。清理异常单独写入 `cleanup-errors.json`，不会替换原始异常。公共 fixture 接管 SIGINT/SIGTERM/SIGHUP，旧单项脚本直接中断也会先完成资源清理，并在结束后移除信号监听；浏览器关闭由 fixture 统一负责。可信 HTTPS/身份、服务重启、Range 故障注入、Vite 测试页及原生包浏览器保留专用生命周期和服务扩展；它们仍由统一 runner 执行并登记既有产物目录。主题的受限存储 context 与设置的 DPR 2 context 通过 `newContext` 登记；额外 context 的启动失败或取消也属于同一 case 的清理范围。扩展服务在开始监听或等待 ready 前可用 `defer` 注册部分启动资源。连接与身份的普通 HTTP 测试共用 `http-origin.mjs`，将虚拟测试域名的 HTTP 请求转到临时 loopback 服务，保留页面的不安全 origin；HTTPS 请求不匹配此转发，仍验证真实证书信任。

原生包 `release-analysis` 在每次 spawn 时记录该子进程的 `close`，重启与删除临时程序前必须等待关闭；`exitCode` 已设置仍不能跳过管道和进程句柄的关闭等待。日志保留实际 PID、退出码和信号。5 秒正常关闭期限到期后尝试强制清理并再等最多 5 秒，但本例仍失败；缺失 `close` 不会被当作完成。仅在关闭确认后，删除目录对 Windows 短暂文件共享锁做有界重试，持续锁仍导致失败。分析断言的 PASS 前缀不能代替整例清理及后续 HTTP/HTTPS、Windows shutdown 检查的结果。

analysis layout 的显示/hover 缓存复用检查仅排除同源、无查询串的 `GET /api/health`：来源状态 UI 已有 10 秒健康轮询，与块数据读取无关。用例在显示窗口内主动发出同样的 health GET，确认它被记录，同时严格要求其他新增请求为零、两轨分析状态与执行计数不变。任务创建/查询、Worker 资源、媒体读取、其他 origin/方法/查询串的 health 请求仍会失败；Node 负例覆盖这些情况以及无网络的新本地分析任务。请求差分写入普通 CI 日志和断言错误，便于在失败 artifact 不可读取时定位；不增加请求数量容忍值，不减少用例或放宽时限。

### 浏览器测试约定与失败取证

测试入口首先声明环境前提，操作后的断言等待可观察的完成状态：

- 通过 Agent 调用分享不带点击激活；Chromium case 必须为当前服务 origin 显式授予 `clipboard-write`，不可全局放开权限。专门验证剪贴板拒绝的用例保留拒绝路径。不同引擎只配置其支持的权限，不以捕获权限错误后继续执行代替授权。
- 通用夹具的 `ready()` 已等待动态入口发布 `window.voidPlayer.tools`。专用生命周期在导航、重载后也必须等待实际需要的 API/会话状态，再调用工具。
- `scripts/testing/browser-contracts.mjs` 的 `waitForDialogClosed(page)` 同时等待设置对话框退出、关闭标记清除和焦点归还。其他对话框显式传 selector/invoker；不要求焦点时显式传 `{ invoker: null }`。不要只等元素隐藏后立刻发送快捷键。
- 主题/高对比度变化使用 `settleAppearance(page)` 等待有限动画完成及布局刷新；忽略持续动画，但不禁用动画、不降低动态效果配置。颜色检查针对可渲染的控件或有标识的临时 probe，不读隐藏值存储器的绘制样式。既有 tooltip 延迟、暂停稳定性等有意观测窗口仍保留。
- 比较基线在相关前置操作完成后采集。拖动、seek、换源后重新获取所需基线，不沿用旧视窗。异步索引需明确等待状态或明确测试增量状态。缩放目标必须处于可达范围；测试手势生效时还须证明前后范围确实不同，零位移不能算通过。

公共夹具支持给等待命名并记录操作前现场：

```js
checkpoint('scroll-baseline', { view, scrollTop });
await phase('scroll-charts', () => page.waitForFunction(
  before => document.querySelector('.analysis-charts').scrollTop > before,
  scrollTop,
), { expectedView: view });
```

`checkpoint(name, details)` 在调用时克隆数据；`phase(name, action, details?)` 保留步骤状态、开始时间、耗时及原始错误，遵守既有逐操作和整例期限。两类记录各保留最近 50 条。完成的步骤不会把后续普通断言误标为之前的步骤。优先标记关键操作和边界，不把每个点击包装成阶段；记录有用的基线和预期，避免保存帧数据。

失败 JSON（`schemaVersion: 2`）在访问浏览器前先落盘。现有字段继续保留，并增加步骤/基线、浏览器与视口/DPR、媒体查询、主题、焦点、打开的对话框/菜单，以及关键控件的几何、计算样式和图表 dataset。Range 和普通 API 请求分别记录总数、待完成数和最近 100 条；另保留最近 100 条 HTTP/网络失败（包括静态资源）。控制台和页面错误也各保留最近 100 条，不记录请求体。截图、DOM、会话状态和界面摘要独立尽力采集；崩溃、超时或采集失败不能替换原始异常。

需要重启服务的标注持久化 case 保留专用生命周期，但共用取证器，统一 runner 下在逐 case 产物目录保存各页面的阶段和现场，随现有 CI 报告上传；直接运行时默认写入 `.run/playback-reports/annotation-persistence-<engine>/`。公共夹具报告同样遵循逐 case 产物目录及直接运行的默认目录。读取失败证据时先看统一 runner 的 `results.json`，再看阶段、基线、实际图表 dataset 和网络记录；不要只凭超时判断 runner 抖动。

`browser-contracts-{webkit,chromium}` 已登记在 `browser` / `uncovered`，不依赖媒体、core 或构建。它们故意触发一次真实页面超时，只有确认等待约定、原始失败、JSON/DOM/截图取证均正确才通过；其 `*-failure.*` 是预期的测试产物，不代表该 case 失败。Node 契约同时覆盖请求缓冲淘汰后的总数、不可变基线及清理异常。

### 覆盖下限与兼容入口

`test/testing-coverage-baseline.json` 保存迁移时已有 case × engine × platform × input、执行命令、required 属性与 CI 归属下限；`test/test-manifest.test.mjs` 检查每格仍存在。`uncovered` 保留原有 20 格，并补齐此前遗漏的 16 格；CI 按 Chromium/WebKit 拆分执行。FLV startup 两引擎、HEVC 的两引擎 × 本地/远程（各两次重开）、FATE 内部矩阵和原生 Node/Bun 三平台验证都保留。本地 `unit` 仍运行完整 Node 验证；CI 由 `source` 提前验证无需媒体的逻辑，`ci-node-media` 只运行剩余 Node 用例；断言、媒体和参考结果不变。新增 case 必须显式登记，删除矩阵项或 required 属性会使契约失败。不得改写覆盖下限文件来掩盖覆盖减少；新增基础设施用例和工具可追加登记。

契约测试解析发布与身份工作流中的 suite/case 选择和引擎/输入矩阵，要求每个 required 浏览器组合都被实际选择；移除 job、漏掉矩阵引擎或新用例未接入 CI 会失败。

CI 细分套件是统一清单的标签，本地执行相同标签会枚举相同的平台适用 case；不是第二份脚本列表。发布依赖测试继续确保所有 required job 成功才能汇总和创建草稿。`ci-native-http` / `ci-identity-http` 使用隔离数据模拟远程 HTTP 入口；`ci-native-https` 与 `ci-https` 涉及临时证书信任，入口要求 `CI=true` 的一次性主机，普通本地运行会明确失败而不会修改信任。

旧 npm 命令和脚本路径保持兼容，包括它们的既有默认引擎、参数和构建行为。例如 `npm run test:browser` 委托 runner 的 `--alias test:browser`，由现有清单 case 的 `npmAliases` 绑定选择默认 WebKit，传入 `chromium` 只选择原来的 Chromium 基础 UI case；准备步骤、默认参数和执行命令来自唯一 case 定义，别名不再独立编排 build。`npm run test:browser -- chromium --filter=子用例名` 保留原筛选参数，并在选择记录标记部分执行；未匹配任何检查必须失败，CI 覆盖枚举不能把筛选后的 case 算成完整覆盖。它仍不是完整浏览器套件；连续执行旧带 build 的命令仍会重复构建，需要完整或组合检查时使用新套件入口。浏览器领域实现归入 `scripts/testing/browser/{ui,annotations,media,workspace}/`；Node 实现按职责归入 `test/{unit,contract,media}/`，可复用模块归入 `test/helpers/`。顶层旧脚本和 Node 文件保留薄入口，清单的 `implementation` 记录实际文件。只选择旧入口或实际文件中的一处执行，不能同时枚举两处导致重复用例；`npm test` 委托 `node scripts/run-tests.mjs unit`，与 CI 使用相同的 case ID、准备步骤、超时及逐项结果；不再依赖顶层 glob。`npm test -- --list` 枚举适用用例，`npm test -- --case node-test-manifest` 可缩小选择。runner 逐项运行，原来的 Node `--test-concurrency=4` 不再维护另一份调度；参数使用 runner 的选择选项，单文件 Node/Bun 命令和旧脚本路径保持兼容。契约检查旧入口指向、唯一实现归属，以及漏登记或悬空实现。开发、夹具、诊断、性能和发布工具分列于 `scripts/tools/`，入口与保留专用工具见 [脚本职责索引](../scripts/README.md)。逐项覆盖下限见 `test/testing-coverage-baseline.json`，当前选择以统一清单为准。

## 准备

```sh
npm ci
bash scripts/sync-wasm-core.sh
bash scripts/fetch-qa-media.sh .run/qa-media fixtures/video
npx playwright install webkit chromium
npm run fixtures:flv
npm run fixtures:hlg
node scripts/sync-fate-samples.mjs
```

日常检查和发布流程从 [QA 样片仓](https://github.com/Nakiha/VoidPlayer-QA-Fixtures) 获取同一份固定版本的附件。每次运行只准备一份，校验归档 SHA-256 后供各测试任务复用。更新样片时发布新版本，并同步更新 `scripts/fetch-qa-media.sh` 里的下载地址和校验值。已有本地样片仍可用 `bash scripts/sync-samples.sh` 同步。

FLV 样片生成需要 Python 3、ffmpeg 和 ffprobe。`fixtures/`、`dist/` 和 `public/vendor/voidplayer-core/` 是本机产物，不进入 Git。需要基础合成样片时运行 `python3 test/generate-fixtures.py`。

发布 CI 的 FLV 硬件优先策略回归使用 `FLV_CASE=standard-h264`，同时限定素材生成与浏览器用例，验证 WebCodecs、Range、seek 和播放。完整 FLV 回归仍默认覆盖所有编码，其中 H.266 素材生成需要支持 VVC 的新版 FFmpeg；Ubuntu 24.04 自带的 FFmpeg 6 无法生成该素材。

## 常规检查

```sh
npm test
npm run build
npm run test:browser
node --test test/range-reader.test.ts test/mp4-packets.test.ts test/range-media.test.ts
npm run test:range:browser
```

单元测试使用 Node test runner，包含真实 WASM 和 FLV 解码。浏览器脚本启动独立的临时媒体服务并清理，不需要刷新用户页面或重启后台服务。各脚本的默认引擎和可接受参数不同：支持引擎参数的旧 npm 命令可在末尾追加 `-- chromium`；固定引擎或内部矩阵不能用该参数扩大覆盖。组合执行优先使用上文的清单筛选。

| 改动 | 补充验证 |
| --- | --- |
| 页面启动、模块载入与失败提示 | `npm run test:startup:browser`、`node --test test/startup.test.ts` |
| 标注交互、采样与图层 | `npm run test:annotations:browser`、`npm run test:annotations:rendering` |
| 设置窗口、分类导航、焦点、日志及窄屏布局 | `npm run test:settings:browser` |
| 工作区导入导出、失败回滚、外观设置及进度回跳 | `npm run test:workspace:browser` |
| 亮暗主题、系统跟随、外观持久化 | `npm run test:theme:browser` |
| 菜单、色盘、工具条 | `npm run test:menus:browser` |
| 标记身份、卡片、缩略图 | `npm run test:mark-cards:browser` |
| 快捷键与 tooltip | `npm run test:shortcuts:browser`、`npm run test:feedback:browser` |
| 混合帧率步进 | `npm run test:stepping:browser` |
| 时长、进度、子轨道 | `npm run test:timeline:browser` |
| 像素格式与色彩元数据 | `npm run test:metadata:browser` |
| FLV 文件路径 | `npm run test:flv:browser` |

修改播放或解码路径后还必须跑播放基准。修改视图尺寸调度、轨道操作或片源 UI 后跑 `test:browser`。

启动回归在 Chromium / WebKit 验证开发页面和打包页面的真实界面。它模拟入口、静态依赖、动态模块及 Vite 预构建依赖的 504，检查错误提示与重新加载；请求持续无响应超过 15 秒时显示重试，迟到的成功启动可以恢复界面，正常启动后停止超时监测。Node 开发服务测试还检查启动模块及 MessageFormat 运行时的 HTTP 状态与 JavaScript 类型，避免仅凭首页返回 200 判定可用。

## 播放基准

H.266 的「自动」按可用 CPU 和同时打开的软件解码轨道分配线程预算。「自动扩容」另外观察单轨多线程 WASM 播放：连续两个约 2 秒的窗口播放落后且队列缺帧时，检查线程饱和与帧上下文等待。两者同时受限时先试帧上下文，若两类压力持续，则交替试调；每次只增加一项，经过预热和两个观察窗口才评估收益。没有收益、被内存预算拒绝或到达上限的方向停止增长，已分配资源在本次解码中保留。

策略回归复用 `test/unit/playback.test.ts`，注入同时受限、仅线程受限、输入等待和达到上限的采样，验证同一资源不会在两项都可试时连续加码。设置页回归在已有的宽度检查中加入 620px，直接检查「硬件优先」的文字行数。前者不需要媒体，后者复用原浏览器页面和素材。

自动线程模式下的缺帧提示复用 `test/unit/session.test.ts`，通过虚拟时钟推进快慢两条轨道。覆盖索引未完成、输入读取占用窗口、快轨等待慢轨、暂停恢复、换片和重新载入。H.266 软件解码与 WebCodecs 硬件优先各有一次提示机会，用例不需要真实视频或额外播放等待。

先构建并启动包含 QA 媒体库的服务，然后运行：

```sh
node scripts/bench-playback.mjs webkit
node scripts/bench-playback.mjs chromium
```

`BASE_URL` 选择服务地址，`BENCH_REPEATS` 默认 3，`BENCH_DURATION_MS` 默认 8000。`--headless` 为离屏自动化运行。场景和阈值分别以 `scripts/bench-playback.mjs`、`src/session/benchmark.ts` 为准。

播放基准通过 Agent `benchmark_review` 和脚本运行，设置页不提供手动检查入口。它检查呈现帧、速度、等待、卡顿、同步和暂停后的旧帧；失败场景使脚本返回非零退出码。

远程 HTTP 现在进入连接准备页，不再启动播放器或 WASM。对应检查为：

```sh
npm run test:connection:browser
npm run test:presentation:browser
```

前者检查 Windows/macOS 安装步骤、实际公开 CA 下载、HTTPS 链接与未配置状态，并确认未加载播放器或解码 Worker；后者在 Chromium/WebKit 中检查原生帧和 RGBA 直接上传、按需源像素、旋转、像素缓冲复用、无 WebGL 回退与资源清理。页面取源像素应使用 `window.voidPlayer.captureFrame(slot)`，不要直接读取可能尚未生成的隐藏 canvas。

发布工作流使用 `VOIDPLAYER_HTTPS_TEST=1 node scripts/check-http-playback.mjs` 验证可信 HTTPS 下的重复载入和播放：只在一次性 Actions runner 中导入测试根证书，结束后删除信任项；浏览器不使用忽略证书错误的参数。样片由 `node scripts/make-playback-fixtures.mjs` 生成，报告写入 `.run/playback-reports/`。Linux 和 Windows 还检查用户设置、重启恢复、解码出帧与标注。本机播放基准使用上文的 localhost 媒体服务，无需更改本机证书信任。

帧队列同时按数量和字节限制，播放报告的 `measurements.buffers` 记录每轨当前值、峰值及上限。这仅统计队列内已解码帧，不代表浏览器总内存；解码器、压缩文件、画布与 GPU 还会占用内存。

GitHub CI 只运行 `--functional-only`，检查载入、真实呈现、解码路径、资源释放和队列边界；失败仍阻止发布汇总。`--benchmark-only` 与无参数的完整入口保留为显式测试工具，不由工作流调度。原可信 HTTPS 工具需要一次性证书环境；普通本机性能测试继续使用 `bench-playback.mjs`，不会自动修改本机信任库。身份与 HTTP 引导已并入日常浏览器 profile；原独立 identity 工作流移除，其 Node 用例仍由 source 完整执行。

这些是当前设备上的 canvas 呈现证据，不是物理显示扫描、所有 Safari 版本、HDR 保真或低端硬件性能保证。浏览器下载和剪贴板还受宿主权限影响，不能用“调用成功”代替实际文件/内容送达验证。

## 独立发布产物

使用 `.bun-version` 对应的 Bun 执行 `npm run release`，可用 `BUN_BIN` 指定可执行路径。`npm run test:release` 校验最新归档并在临时目录解压运行；也可传归档路径。测试服务使用空 PATH，不依赖源码或 node_modules，覆盖配置初始化、不同工作目录、HTTP/HEAD/Range、并发、中断、鉴权、上传日志、退出及升级保留数据。`RELEASE_BENCH=1 npm run test:release` 额外用 WebKit 在独立服务上跑四组真实播放基准，需要同步样片和浏览器。

POSIX 发布权限由打包阶段统一固定：主程序/目录 `0755`、普通资源 `0644`，归档后再次检查包内主程序权限；原生发布回归解压后直接执行，禁止在测试中补 chmod。已有 `node-release-pipeline` 用例增加 `0644` 无执行位与 `0700` 仅构建用户可执行的故障注入，独立核对 tar 内权限、解压权限与真实启动输出；复用原清单，无新增矩阵，使用小型临时脚本与归档，成本约数百毫秒，不依赖媒体/core。

远程 WASM 专项验证包含 MP4/VVC 索引不遍历 mdat、与原 FFmpeg 路径逐像素对比、B 帧/GOP 随机跳转和尾帧、5 GiB 稀疏来源、Range 响应校验与取消。`range-media.test.ts` 使用真实本地 HTTP 服务；`range-reader.test.ts` 使用可控响应检查缓存与 AVIO 桥接，不替代浏览器网络验证。私有 FLV 继续由 `test/flv.test.ts` 和 `test:flv:browser` 覆盖。

## 专项回归与行为边界

下列说明帮助选择专项检查；完整行为契约见 [架构](architecture.md)、[渐进索引](progressive-indexing.md) 和 [色彩链路](color-pipeline.md)，历史阶段计数见 [文档导航](README.md)。

### FLV first-frame and shared index cache

`node --test test/flv-startup.test.ts test/frame-index-cache.test.ts` checks checkpoint resume, bounded reads, index deadlines, decoder retry, cache schema/version validation, persistence, deletion and offline storage.

After syncing the pinned core and generating `standard-h264.flv`, run `node --test test/flv-background.test.ts` and `npm run test:flv:startup`. The fixture appends a sparse 256 MiB audio tail and blocks reads beyond the initial 64 KiB. The first decoded/drawn frame must arrive while the tail remains blocked. After release, the completed index becomes available, a second opening reuses the cache without rebuilding, and playback plus administrator UI/WebMCP clearing are checked. Run `node scripts/check-flv-startup-browser.mjs webkit` for WebKit.

FLV startup reads the configuration and first video packet, then flushes the decoder to display that frame. Local files and arbitrary URLs resume the client scanner from the saved tag offset; seeks wait only for the required published prefix. Version-pinned library URLs instead start or join the server shared-parser disk scan, receive progress, and import resumable chunks of the completed document. That server path does not publish playable prefixes during scanning, so seeks beyond startup coverage wait for completion. Index work does not block the first presentation. Duration is provisional until finality, exposed as `indexState` in session metadata and the inspector; a failed library build is not silently replaced with a browser full-file scan.

Media indexes are stored in `library.sqlite` schema 7, keyed by media ID/version, kind, stream, schema, and indexer build. The schema migrates older FLV rows into identity-keyed manifests and batches; downgrading to an older schema requires restoring the prior database backup or rebuilding the library index. Only version-pinned library URLs use the cache API. FLV client uploads validate bounded packet offsets, codec configuration, and timing. FFmpeg fallback indexes are built on the server for versioned library media and streamed as validated record batches. MPEG-TS scan progress is reported before batches; the demux scan reaches EOF before the complete record set is persisted and transferred. While batches import, `indexState: building` means index finality has not arrived, not that scanning is still in progress. The complete document remains available for compatibility. Missing/changed files and removed/relocated roots invalidate caches, while offline storage preserves them. FLV uploads are capped at 32 MiB; FFmpeg record streams are capped at 2 million records/128 MiB, and total live cache data is capped at 256 MiB with least-recently-used eviction. Clearing increments an epoch so an earlier in-flight upload cannot undo the clear. SQLite may retain reusable free pages after deletion.

Administrators can list/search and clear individual versions or all caches under **帧索引缓存**. `list_frame_indexes` and `clear_frame_indexes` are registered through WebMCP in both the player and administration page and share the same client functions and server authorization.

暂停续播回归：`test/session.test.ts` 验证双轨连续暂停/恢复不重新 seek 或创建迭代器；定位、替换及释放会销毁原队列。`test/playback.test.ts` 验证暂停期间未完成解码最多归还当前一帧、不继续拉取，且未显示的帧不会被丢弃。播放队列仍按 4 帧 / 64 MiB 双重背压限制，允许单帧超预算以保证进展；原生帧按 allocationSize 估算像素存储，格式不可见时才按 RGBA 估算。该值不包含解码器内部参考帧、Mediabunny 预解码队列或 GPU 的全部开销。暂停保留这些有界解码资源以便快速续播，移除轨道才完全释放。

`check-http-playback.mjs --functional-only` 在真实 MP4/WebCodecs 上验证暂停无时间推进、快速反复续播不重新 configure 解码器，并继续执行原有双轨内存与资源释放检查。性能基准仍独立记录，避免把续播改善等同于持续解码达到实时。

失败诊断：`test/media-diagnostics.test.ts` 覆盖带 CRC 的 PAT/PMT、跨包 PSI、连续计数缺口、188/192/204 字节 TS 包，以及 AVS3 (0xD4)、HEVC (0x24)、私有 PES (0x06) 不误识别。只有所有打开路径都失败且不是网络/资源错误时，才额外探测至多 64 KiB、远程读取至多等待 1.5 秒。诊断报告 PMT 声明的编码，不把声明当作码流有效性证明；探测失败保留原错误，不扩大下载范围。

FLV 损坏恢复：`test/flv-recovery.test.ts` 和 `test/flv.test.ts` 验证首帧优先、尾部截断与有界内部重同步。已有有效配置和起始关键包后，标签类型/flags、stream ID、PreviousTagSize 或不完整标签等结构损坏会尝试有预算的重新定位；后续必须同时证明标签结构和独立解码锚点，不能仅凭容器 key 标志恢复。找不到安全锚点或耗尽预算时保留已验证前缀，配置头或起始关键帧缺失仍失败。IO/版本变化、取消、不支持的编码/配置和资源限制不转成可缓存的损坏文件。时长来自保留包的真实时间戳；`indexIntegrity` 区分 complete / recovered / prefix，警告及 `indexTruncatedAt` 保留损坏边界，索引 complete 仅表示终态。共享 FLV 帧索引为 schema 3 / `flv-demux-v3`，保存恢复间隙、损坏原因与解码边界；旧格式按新身份重建，客户端和服务器需一起升级。详细恢复预算与准入见 [FLV 时间线](flv-timeline.md#damaged-tails)和 [容器恢复](container-recovery.md)。

真实 HEVC/私有 VVC/AVC 回归在完整码流后追加残缺视频标签，验证连续取帧、前后定位、尾帧及警告。首帧浏览器夹具包含被阻塞的大尾部和最终残缺标签，验证后台恢复、播放基准、警告显示与服务器缓存复用。缺失包可能是其他完整包的参考帧，因此恢复不保证任意损坏流都能输出每一帧；解码失败保留上下文并停止重复调用失败的解码器。worker 原始异常堆栈进入现有本地诊断日志，不额外上传。

FLV 同编码配置/分辨率切换：索引记录每段配置和所属视频包，新配置从关键帧开始；解码或跨段定位时切换对应配置并在段末 drain，避免丢失旧段 B 帧。WASM 复用模块，通过既有 vp_packet_open 重建上下文；WebCodecs 重新 configure。`test/flv-resolution.test.ts` 生成真实 H.264/HEVC 双分辨率文件，验证顺序帧、来回定位和缓存序列化；浏览器夹具验证实际播放跨过切换点及 UI 尺寸。尺寸由 session 在显示帧时更新，不由后台预读提前改变。不支持中途更换视频编码种类；配置切换缺少关键帧仍明确报错。

HEVC 竖屏：从 hvcC 的 SPS 数组读取编码尺寸、按色度采样单位计算的 conformance window 和 VUI SAR；配置 WebCodecs codedWidth/codedHeight 与 displayAspect，切换配置时同步更新。coded 与 SPS 不一致、visible 缺失/更小/错位、宽高互换时拒绝原生首帧并走软件回退，不能仅交换画布宽高；浏览器 visible 完全包含 SPS 可见区时只做 VideoFrame 元数据收窄（同一底层资源，无像素拷贝）并记 `hevc-visible-rect-repaired` 后继续 WebCodecs，像素区域一致时才可通过 VideoFrame 显示元数据修正比例。SPS 读取有边界/数量限制，多个不同尺寸 SPS 不猜测当前生效者。`test/hevc-geometry.test.ts` 包括 736→720 的 4:2:0 裁剪、720×1272→1270 收窄修复/拒绝分支与真实竖屏/非方形 SAR。

首帧与关闭重开：原生片源保留一份首帧引用，frameAt(0) 返回独立 clone，dispose 释放缓存及活跃 sink 迭代器。添加片源不会重复解码已经在会话时间 0 的其他轨道。浏览器回归使用带预滚的 H.264 / HEVC MP4，重复定位 0 不重新 configure 解码器，双轨打开/播放/关闭循环后检查所有主线程 VideoDecoder 都已关闭，并验证竖屏上屏与采样尺寸。

软件解码预滚：逐个探测负时间前缀，仅将返回时间不匹配的不可输出包移出显示索引，原始包仍留在 core 中用于解码参考。最多探测 128 个，非负时间包及其他错误不跳过。`test/preroll.test.ts` 使用真实 HEVC open-GOP 裁切文件验证首次及重复定位；浏览器回归同时覆盖原生与可用的软件回退路径。

HDR 上屏一致性：自有色彩模式接收满足契约的高位深 PQ/HLG 平面；浏览器原生 HDR 在浮点桥接与扩展画布能力满足时输出 HDR，其余环境走 SDR 兼容预览。首帧、播放、定位应使用同一路径，截图与缩略图保持 SDR。以实际资源 transfer 为准，不用容器标签覆盖已转换资源。具体准入、降级原因与真实屏幕测试入口见 [HDR 支持](hdr-support.md)及 [色彩链路契约](color-pipeline.md)；普通呈现回归不认证物理 HDR 显示。

`check-presentation-browser.mjs` 使用相同 PQ/HLG 像素的真实 VideoFrame 和 VideoSample，验证 clone/toVideoFrame 元数据、展示层创建前后、连续帧、回到首帧的像素完全一致，并检查随后 SDR 恢复直接上传；保留旋转、像素提取、无 WebGL 回退和资源释放检查。

WASM 堆增长：通过 Emscripten 公开的 instantiateWasm 回调取得 core 的实际 WebAssembly.Memory。每次外部包/配置写入及 RGBA 读取，按 memory.buffer 重建过期视图，再执行范围检查；不信任 pthread 扩容后可能滞后的 Module.HEAPU8，不修改生成胶水、不移除越界检查。测试覆盖非共享内存增长后旧视图脱离、另一 worker 扩容共享内存后旧视图仍有效但过短，以及真实 720×1280 HEVC 多线程 core 首帧、连续播放、回退定位。core 版本和构建锁不变。

后台索引时长：子轨道 dock 的刷新签名纳入 durationUs/indexState。FLV 启动浏览器回归在阻塞尾部时记录临时时长，解除阻塞后验证子轨道时长文字和标尺更新到完整索引时长，不靠切换轨道/修改标记触发刷新。

### 码流分析与按需面板

原生 Mediabunny 分析通过独立 metadata Worker 持有包表、排序缓存和统计，主线程每批最多发送 2,000 条 PTS/大小/关键包元数据，并等待追加确认。查询取消立即结束调用方等待、移除排队请求，并在执行中的下一批计算前中断排序或统计。排序以最多 512 项的小段排序和每 4096 项让出检查点的稳定归并进行；桶与曲线生成共用同步后端的生成器口径，每个 Worker 回合约 4ms 后让出事件循环。取消不会发布部分结果或半成品索引，释放片源会终止 Worker。解码帧与播放缓冲不跨此通道。分析面板按首次展开加载，纯绘图模型与偏好迁移分别位于 `src/ui/analysis/model.ts` 和 `preferences.ts`；关闭/销毁期间完成的 import 不会重新打开面板，工作区快照仍保存尚未加载面板的状态。

`src/ui/analysis/queries.ts` 独立持有每轨查询、覆盖缓存、100ms 手势节流和取消生命周期，所有请求仍调用 `session.queryAnalysis`。覆盖记录使用请求发出时的窗口与偏移；换片、实例重建、关闭或销毁时取消并作废在途请求，即使后端忽略取消也不会发布旧结果或旧错误。`test/unit/analysis-view-cache.test.ts` 覆盖这些竞态、节流尾查、构建中索引不可建立覆盖，以及放大时样本邻域和曲线网格的独立密度。

帧号状态按片源与实例保留已知总帧数所需的宽度；逐帧查询期间保留上一条确认的数字与按钮节点，新结果返回后原位更新，避免省略号、禁用态与悬停动效反复闪烁。换片、实例重建或移除轨道会作废旧排名，首次查询仍显示占位。分析浏览器回归会寻找工具条的一行/两行临界宽度，在真实双轨播放中观察查询等待和结果，断言数字持续可见、按钮不重建、帧号宽度与表头高度稳定；暂停后再用完整包表验证最终帧号，并继续验证点击编辑的尺寸契约。

时间轴选中颜色回归通过 Web Animations API 等待当前 CSS 过渡完成，再分别核对选中与悬停状态的 `--track-active` 最终颜色；两个动画帧仅用于布局稳定，不代表 240ms 颜色动画已经结束。恢复历史分页使用独立的 `.checkpoint-history-pages`，不复用服务器工作区分页控件的行为选择器。

本机检查点每用户最多 100 份、JSON UTF-8 估算大小合计 64 MiB。v2 迁移保留旧记录并建立轻量摘要索引；分页和用量查询不复制所有工作区文档。新增或更新超出预算时整个事务回滚，已有超限历史只允许不增大用量的更新；不自动删除用户工作。跨窗口并发保存、两类容量上限、旧库迁移、失败后记录保留与删除后恢复保存均有回归覆盖。

服务器工作区恢复必须完成记录绑定后才允许再次分享；会话画面结束 busy 并不代表工作区装配已经结束。分享浏览器用例延迟标注空间响应，验证这段间隙中 UI 和公开分享入口都拒绝操作，随后仍复用原工作区地址。

## 帧契约与 FATE 门禁

先同步 core、普通样片和 FATE 样本，再运行 `npm test` / `npm run build`。
`test/avc-geometry.test.ts` 和 `test/media-state.test.ts` 使用固定 FATE 样本。

```
node scripts/sync-fate-samples.mjs
npm run test:fate
npm run test:fate:browser
```

参考 `scripts/fate-reference.json` 固定逐帧 PTS、尺寸和 SDR RGB 分区指纹；
普通检查不调用本机 ffprobe 改写预期。`update-fate-reference.mjs` 仅用于人工
维护参考结果，记录生成工具版本，变更必须审阅。分区最大差 8 / 平均差 3
允许浏览器 YUV 转换舍入，不代表 HDR 色准或逐像素 bit-exact 验收。

`fate-expectations.json` 按片源和后端区分成功与预期拒绝；新失败令检查返回非零。
组合数量以当前参考和预期文件及执行报告为准，不能沿用历史验收计数。适用组合及浏览器本地/HTTP 重开必须通过；明确的 container 能力拒绝按预期校验，不作为已知失败豁免。CI 将此步骤作为阻塞门禁；
独立性能报告保持非阻塞。报告仍写入 `.run/playback-reports/`。

### 静音轨道信息

`node scripts/check-track-metadata-browser.mjs chromium`（登记在 `ci-audio`）用真实 MP4、FLV、TS、Matroska/WebM 比较信息面板关闭/打开时的 HTTP Range 与本地 Blob offset/length 序列；视频执行相同完整遍历、往返 seek，音频保持静音。包含确认无音频、未支持编码、多声道、重复开关、中文/英文切换和实际面板截图；不得用媒体读取重试补全元数据。源逻辑测试另覆盖缺缓存、查询预算、取消和过期回包。

轨道信息是缓存证据，不是完整 ffprobe：仅检查已读的 FLV header/tag、MP4 moov、EBML Tracks 和 TS PAT/PMT（以及已有 AAC 配置）。每次查询最多 4 MiB、256 个不超过 64 KiB 的缓存 peek，2 秒软截止；顶层遍历和轨道数另有上限。TS 限制为启动 64 KiB 内完整且 CRC 有效的单节 PAT/PMT，未知私有流不推断为无音频。EBML 不扫描 Cluster；超预算、缓存空洞、复杂或缺失元数据保留“尚未确认”。只在信息面板请求时查询，最多每秒一次；正常视频读取带来新证据后可更新，关闭/换片/释放会取消旧查询。不会创建 AudioContext/AudioDecoder、额外元数据 worker 或修改服务端索引及 WASM ABI。

## 历史证据的读取边界

2026-09-07 的 [FATE 审计原文](https://github.com/Nakiha/VoidPlayer-Web/blob/1d94ddb81be4800d60a852b4c210a494bfedead4/docs/fate-audit.md)描述的是修复前状态，其后续任务列表与探索性非阻塞配置已被当前帧契约及门禁替代。FATE 包含故意损坏的输入，不应将全部文件必须可播放当作目标；首帧、帧数或时间推进也不能替代逐帧尺寸、PTS、像素和定位验证。

历史帧契约验收见 [frame-contract-acceptance.json](frame-contract-acceptance.json)，其中包含未达门槛的性能结果。界面重做基准保留在 [2026-09-06 原始报告](../.design/2026-09-06/)，均不代表当前版本验收。

2026-09-12 本机编码矩阵的原始产物位于 `artifacts/local-codecs-2026-09-12/`（`report.json`、`chromium-4k-recheck.json`、`exact-recheck/report.json`）；这些产物未提交，当前 checkout 无法直接复核。历史记录中的载入/定位通过不等于首次播放全部通过，后续 4K 软件复测也不能抹去首次失败或推广为稳定性能保证。需要重新取证时使用 `scripts/check-local-codec-matrix.mjs`，按其 `CODEC_FILES`、`CODEC_BROWSER`、`CODEC_MODE` 和 `CODEC_REPEATS` 配置明确输入与环境。

2026-10-30 按项目要求移除了 GitHub CI 的配对 HTTPS 性能 job、独立播放测速步骤和性能摘要。旧配对脚本保留为未调度的历史工具，原始报告不改写为通过；后续性能验收在明确的本机环境进行。

### 有限 fMP4 分区

`node scripts/make-analysis-fmp4-fixtures.ts` 生成三 codec 的 byte-identical fragment remux 与真实视频复制/AAC traf 片源。`test/bitstream-analysis-fmp4.test.ts` 覆盖 payload/config、独立 codec/VTM 答案、真实播放 AU、跨非关键片 range、whole drain、取消、实际 Blob IO、媒体库缓存重启/补缺与 edit-list/raw ticks。`test/mp4-fragments.test.ts` 校验 addressing/defaults、64 位时间、合法 CTO 及越界/截断/时间断裂等拒绝边界。

`ci-analysis-matrix-fmp4` 在 WebKit/Chromium 各自独立 job 执行 12 个组合，保留既有每操作上限和 600 秒 case watchdog；加严跨片 seek 后的实际 presented token/遮罩精确匹配，并明确断言 VVC 的实际软件路径。原普通 MP4 与两 FLV 分区继续独立运行。

## Canonical execution and compatibility paths

The manifest's `implementation` (or `script` when no forwarding alias exists) is the canonical executable. `command` invokes it exactly once; the validator rejects executing a forwarding alias or duplicating the entry. The existing `script` path is retained only as a documented compatibility alias and remains a thin import/export forwarding to that implementation. CLI arguments, engines, inputs, preparation, budgets, gate flags and reports remain unchanged. Direct legacy paths are deprecated for new automation; use stable case IDs through `scripts/run-tests.mjs`.

The fixed-baseline comparison in `docs/evidence/test-entry-migration.json` records all migrated owners. The coverage contract preserves the original catalog and argument lists, allowing only the alias-to-implementation path substitution. This stage retains compatibility files while npm aliases are migrated separately; it does not claim the remaining npm preparation/list duplication is already resolved.

### 媒体与 Worker 的翻译依赖边界

`node-i18n-build` 使用 `scripts/testing/i18n-architecture.mjs` 检查 media、presenter、FFmpeg/packet Worker 与实际 `src/thumbnails/pixel-worker.ts` 根入口。必检根入口或递归依赖缺失必须报出路径并失败。扫描相对运行时 import、re-export 和字符串字面量 dynamic import；type-only import/export 与包依赖不递归。Worker URL 单独列为根入口，计算式 import、require 和未列出的 Worker URL 不属于这个扫描器的覆盖范围。临时工程负例验证缺失入口、缩略图直接/间接引入翻译依赖均被拒绝；现有 progress callback 限制保持。

### 服务端索引数据库 RPC

`server/frame-index-protocol.ts` 绑定六个数据库操作的字段与结果，`FrameIndexJobs.call` 从操作名推导返回值，Worker 使用 `frameIndexReply` 检查响应。HTTP JSON 和磁盘索引的既有运行时校验仍在入口执行；数据库 Worker 消息布局、transfer、超时、并发与关闭策略保持。`test/helpers/frame-index-protocol-types.ts` 的负例随 build 和 `node-frame-index-worker` 编译，拒绝未知操作、缺失/错误字段及请求/响应错配；这些测试不在媒体逐帧路径增加校验或复制。

### 可丢弃像素缩略图 Worker

`src/thumbnails/tasks.ts` 每个像素候选拥有一个一次性 browser Worker。正常结果、`error`、`messageerror`、`postMessage` 抛错或候选到期均走单次结束：解除三个事件属性与到期回调，终止该 Worker，随后仅释放候选自己的帧和预算、清除 in-flight。失败不会标记 completed，也不触碰播放原帧或下一任务；已捕获的迟到回调不能再次提交或清理。既有 hold deadline、队列上限和复制/transfer 路径保持。

`node-thumbnail-offer` 从实际 offer/task 入口验证这些分支、成功回包、到期计时器清理与恢复任务。受控 browser-like Worker 使用真实 `structuredClone` transfer，验证播放像素数组仍完整；测试主动派发 `messageerror`，并不声称复现浏览器底层损坏消息。浏览器缩略图套件继续验证实际编码、存储与显示；此一次性客户端不增加 Node Worker 适配层。

### npm compatibility and retired forwarding paths

Every `test`/`test:*` npm command now delegates to the catalog runner. The 48 migrated legacy commands are declared by stable case IDs in `manifest.json` `npmCommands`; engine alternatives share the canonical owner, and literal legacy arguments (including package paths and required hardware flags) remain argument arrays, never shell commands. The two chained HDR commands stop after an earlier stage fails. Manual/diagnostic execution remains explicit and its failing exit is blocking when directly invoked through npm; these customized aliases cannot count toward CI matrix coverage. Use `node scripts/run-tests.mjs --list --alias <name>` to inspect the exact plan.

Unreferenced thin forwarding paths listed in `docs/evidence/retired-test-entrypoints.json` are retired: use their npm alias or `node scripts/run-tests.mjs --case <id>`. Their case IDs and canonical implementations remain, and `retiredAlias` is accepted only with the checked-in matching retirement record and an absent forwarding file. Documented/imported/workflow-used forwarding entries remain compatible. A legacy top-level test glob is not the complete unit suite; `npm test` discovers every canonical unit case, including retired aliases, exactly once.

Release aliases keep the browser default-archive `-` token. Explicit archives bypass only the latest-release fixture; default archive selection still requires that metadata. HEVC alias `--engine` selects only that engine's local/remote cases and conflicts or unsupported engines fail before execution.

## 模块边界与目录维护

Agent 标注浏览器用例在建立工作区快照前，有界等待新生成的 A/B 文件从媒体库 pending 转为 ready，不触发额外扫描、不修改状态、不重试打开/播放。浏览器 ready 区分仍在 busy 的渐进占位轨道与载入结束后的失败/relink，真实失败立即报告。管理页面轮询测试每轮仍推进完整 10.1 秒，但快进前及每个至多 1 秒的片段后等待真实网络 idle，避免虚拟定时器消耗 localhost 请求的真实执行时间；原连接/断连和 pageerror 严格为空断言保留，增加错误页面/阶段/堆栈及浏览请求追踪，不忽略 CORS 错误。

JS 容器矩阵的 corrupt-cache/fresh-runtime 两次 reload 分别记录命名阶段，原 reload、原超时和第二轮 reuse 断言不变。普通日志的 `js-container-navigation` 输出主文档导航/响应/失败、页面 crash/浏览器断连、服务 listening 与限时 health、Node/host/cgroup 内存，以及有界 tracks/busy/resources 和最近 blob 归属；不包含像素、媒体字节或标注正文。每个诊断采样限 1.5 秒，普通事件至多 256 行并预留 32 行关键 reload 记录；数据 URL 省略。WebKit 此 case 开启 `pw:browser` 进程退出日志，不增加自动重试或错误豁免。pagehide 标记只证明应用 handler 已被调用，Worker close 仅表示可观察执行上下文关闭，均不冒充 OS 进程/内存已完成回收。诊断失败不会覆盖原导航错误，也不将导航失败当作成功。

`node-module-boundaries` 随 fast、contract、source 执行，构建也运行同一边界扫描。检查覆盖生产目录中的静态与类型导入、重新导出、字面量动态加载和 Worker URL；不存在的相对依赖会直接失败。独立 Bun 程序的条件 Worker 地址按编译后服务根目录校验，Node 地址按源码位置校验，发布回归另从真实原生包启动验证。前后端不能互相引用，共享层不能引用任何宿主，外部包仅准入 Mediabunny。计算式加载仅保留登记的资源加载入口；新增入口需明确其职责。负例覆盖间接越界、类型引用、Worker 缺失、计算式加载和未归属的顶层模块。

共享层另以 `tsconfig.shared.json` 在无 DOM 类型环境编译，真实编译负例证明 window、document、IndexedDB、VideoFrame 不可进入共享代码。标准 Fetch/Blob、AbortSignal 与 WebAssembly 可由两种宿主使用。共享源码及其类型配置参与准备构建指纹、前端来源摘要和发布源码包，移动公共实现后不能复用过期构建。

Frontend HTML entry names live in `scripts/frontend-entries.mjs`. Vite inputs,
embedded source evidence and test preparation fingerprints consume that definition.
A prepared receipt hashes every entry's actual bytes, including `quality.html`;
source archives and already-dirty checkouts must reject a stale receipt after any
entry change. `test-runner.test.mjs` exercises real preparation/reuse/rejection and
rebuild for each HTML entry, without relying on Git's dirty marker.

像素传递回归扩充已有职责用例，不新增套件或媒体矩阵：`frame-description.test.ts` 以会拒绝旧 `vp_pixels`
的替身保留修复前失败，独立核对 padding、负 stride、heap 增长、越界及复用输出；`gpu-presentation-guard.test.ts`
核对同一像素缓冲和最后持有者回收；`yuv-color.test.ts` 核对 GPU 对齐尾部和最后一行无需整平面补齐。
这些是无需浏览器/core 的常数成本逻辑检查。`analysis-quality-core.test.ts` 仅新增一帧 CAMBI 上传计数，
禁止申请紧凑 staging 或调用旧 feed，要求精确上传一份输入；原有官方分数、热图、ROI、8/10-bit 与连续历史
对照继续承担数值正确性，未扩充循环或重新生成 oracle。播放路径改动另跑实际播放 bench，结果仅代表本机同条件。

片源列表交互沿用基础 UI 用例：延迟一次目录响应，核对就绪前保留原节点；真实按压检查只有外层行着色，宽窄侧栏核对大小、来源列对齐及整列隐藏时间。菜单用例覆盖外部点击消费、触屏长按与移动取消，Chromium 额外使用原生触屏事件；复用已有素材，不扩充媒体矩阵。

媒体库前进/后退复用目录浏览用例，核对初始禁用、双向遍历、目录搜索恢复，以及后退后新导航截断前进分支；仅增加已有目录的常数次导航，无额外素材或解码。

库列表挂载路径菜单复用目录浏览用例：复制真实配置路径、未知根/错误方法/损坏编码的 HTTP 负例，以及长按释放不导航；路径分隔箭头点击也导航到相邻项，不留下不可点击占位。无新套件或素材。

管理端复用播放器媒体库组件时，扩充既有 admin 浏览器用例：检查管理入口保留原评审标签、首选项语言切换、矮于屏幕的卡片、两端行密度/图标几何一致，以及后台目录/普通行点击不隐式打开媒体。窄屏和伪语言布局矩阵补入首选项；沿用现有素材，不增加评分或解码矩阵。播放器原目录、工作区还原和缩略图用例继续承担迁移前后的行为对照。

后台分栏模式在同一 admin 用例中检查默认分栏、列表切换保留目录/搜索、前进/后退、窄屏横向滚动和视图偏好。复用原 fake MP4，另加一个嵌套文件与 61 个空目录，独立覆盖祖先目录第 60 项后的选中分支恢复；元数据/目录测试不扩充解码或评分矩阵。后台没有最近打开数据或折叠控件，播放器保持原分组行为。

分栏宽度与横向滚动继续扩充同一 admin 用例：实际拖动细分隔条，核对独立宽度、键盘调整/取消、同层目录替换、视图/刷新保持和窄屏夹限后恢复；用水平/垂直 wheel 输入区分整组分栏与单列滚动，并拖动底部横向滚动条。沿用既有目录素材，仅增加常数次导航和交互，不增加媒体解码；旧构建在“每列独立 resize edge”断言失败，新构建必须通过。

共享分隔条的迁移沿用同一 admin 用例，直接比较播放器面板边缘与分栏边缘在闲置/悬浮时的实际高亮色、线宽、命中范围和过渡参数；既有分栏拖动、宽度持久化及前端面板收起用例保留。旧分栏自绘样式应在同一表面比较上失败；另外核对后台每列右侧的默认 1px 分隔线。无新素材、解码或测试入口。

挂载容量第二行在同一 admin 分栏拖动用例中收窄/放宽，检查可用空间完整保留、总空间整段移出裁剪行，重新放宽后总空间恢复；无新素材和解码。通过公共库行同步覆盖播放器与后台，离线/未知空间仍走原有单段提示。

后台文件打开回归在同一 admin 用例中把嵌套文件改为既有微型 H.264 样片副本：普通文件行点击不导航；右键显式“在播放器中浏览”在新标签页上屏所选 ID/版本，并检查首帧、目录上下文与暂停状态。每个浏览器仅增加这一次实际载入，不扩充编解码矩阵或发起评分；原播放器标签保持不变。链接单元用例覆盖版本冻结、目录保留及非法/异源引用。

独立媒体库管理入口复用前端按压/搜索用例：核对其与地址栏之间的 4px 可见间距、共用底色/按压效果，以及悬浮和聚焦管理按钮均不激活地址栏；原 admin 用例继续验证新标签页入口。无新素材或解码矩阵。

后台视图切换按钮的独立布局在原 admin 用例中核对：悬浮/聚焦不激活地址栏，二者相隔 4px，原列表/分栏切换流程继续运行；无新增素材或解码。

选中库/文件夹的图标与色块沿用 admin 分栏用例，在亮/暗主题及临时强调色下检查图标跟随选中文字、色块响应强调色；仅增加颜色观察和截图，无新素材或解码。

后台右键打开文件的新播放器页沿用同一实际载入用例，增加首次打开片源面板时分隔条立即可见、elementFromPoint 命中/hover 与实际宽度拖动检查，不以窗口缩放或重开面板修复初始状态。旧构建在首次可见断言失败；不新增素材或解码次数。

媒体库 HTTP 链接改为 library 参数直接承载库 ID：既有链接单元用例覆盖集合/全部/目录的新格式、旧格式、Unicode、冲突参数与历史开关同名库；目录浏览用例分别冷启动新旧链接并粘贴导航，后台文件动作核对新链接没有 root 参数且仍能上屏精确文件版本。仅增加一次目录冷启动和常数次导航，无新素材/解码次数。

缩略图上下屏连续性扩充原 thumbnail 用例：按钮/右键各做一次下屏和上屏，逐帧检查同一已解码图片节点、可见状态与无空帧；既有折叠、缓存复用、错误绘制和非零加入保持。复用现有样片，每个浏览器增加两次实际重新载入；同片源跨目录/最近打开视图保持图片，新增一个空目录验证真正离开片源列表后仍释放图片。仅增加目录请求，不扩充编解码/评分矩阵；旧构建在下屏保留节点断言失败。

后台文件行按压扩充同一 admin 用例：亮/暗主题下逐帧观察按下、松开的外层背景过渡，要求按压填充有效、区别于悬浮且松开后恢复，内部始终透明；正常动画模式验证连续变化后恢复减少动态效果设置。旧构建会因未定义按压颜色而变透明；不增加素材或解码，每端只增加四段 320ms 的颜色采样。

同一 admin 用例继续通过真实目录导航采样亮/暗主题的选中与取消选中：图标颜色和缩略色块不能早于整行文字/背景结束过渡。复用现有空目录，无新增素材或解码；每端增加四段 320ms 的动画观察。

后台文件管理扩充同一 admin 用例：将原祖先主题色断言映射为中性路径标记，保留独立选中行的动画验证；检查同列 Shift 范围、Command/Ctrl 跳选、跨列排他、列表切换和全选。用既有四个空目录与 fake MP4 做一次五项拖拽移动/移回，核对紧凑预览、数量、无效目标/Escape 取消、服务端真实字节位置和目录刷新，不新增素材或解码。原右键显式打开播放器及分栏宽度用例保留。

同一选中项显式修改 mtime 后重新扫描，核对路径选中状态保持、媒体版本确实更新；选中身份与媒体版本身份分开，拖拽命令仍冻结实际版本。旧构建会丢失选中；仅增加一次小夹具的元数据修改与目录观察。

`library-index` 既有 Node 用例增加临时目录上的文件管理 HTTP 验证：同源写入、源版本、路径/符号链接/挂载保护、整批冲突预检、移动/改名/删除后的索引、跨卷文件复制路径、源移除失败时双端保留，以及写入与配置互斥。故障注入只作用于该用例的临时文件，finally 还原 fs 方法；复用已有 suite 登记，不增加媒体/core/浏览器成本。

后台媒体库卡片在原亮/暗主题循环中与扫描卡片比较填色，并确认浏览器、各列和横向滚动条不会以不透明底色盖住卡片材质；播放器底色保持既有规则，无新增交互或素材成本。

分割线拖拽回归复用 admin 的单次文件拖拽：从祖先目录选文件，在不同目标目录的分割线中心及两侧命中区移动，要求无目录落点高亮，松开不发起文件写入。旧构建会将分割线回退为整个浏览器落点；只增加鼠标事件，不增加素材、目录移动或解码次数。

缩略图向上拖入同列文件夹扩充同一 admin 用例：在原真实小 MP4 旁增加一个空目标目录，并放入合成 JPEG 缓存，不额外解码视频。普通缩略图起拖/目标悬浮可取消；再注入最终 pointerup 坐标先于最后 pointermove 的场景，要求按松手处移动至已打开的上方文件夹，并核对真实文件字节。旧构建沿用先前无效落点而不发送移动请求；随后经公开接口移回，保留原文件链接/分割线回归。每端仅新增一次移动/移回与图片解码。

移动后缩略图/稳定状态回归扩充同一 admin 拖拽，要求目标与移回后的旧路径立即 ready 且缓存 JPEG 字节相同，不增加移动、素材或视频解码。`media-thumbnail-store` Node 用例使用临时文件和合成 JPEG，覆盖文件移动/移回、独占跨卷复制、目录子文件、原本 pending、执行中修改子文件和清空缓存；后两者通过 fs 故障注入核对不会继承失效缩略图，finally 恢复。修复前同一用例在第一次移动后 thumbnail=false 失败，修复后通过。仅新增小文件系统/SQLite 操作，不增加 core 或浏览器矩阵。

后台媒体库紧凑密度扩充既有 admin 用例：验证单行高度、隐藏次要信息、切换密度复用原行、列表/分栏共用密度以及刷新后保留偏好。只增加按钮切换与布局观察，不增加片源、解码或矩阵。

紧凑密度公共化沿用 admin 既有用例，验证前后端地址栏右侧按钮顺序、播放器行高/图标/隐藏次行、两窗口双向同步；保留原列表/分栏、行复用和刷新偏好断言。复用原窗口与挂载行，无新增媒体或解码。

分栏横向滚动复用原 overlay scrollbar，admin 既有用例验证列底部直达路径栏、6px 透明悬浮轨道、拖动/键盘滚动及离开后的渐隐；亮暗主题核对后台工具栏和路径栏与扫描状态块使用相同底色和卡片衬底。故障注入旧布局的 14px 预留空间，先核对内容高度确实减少，再还原为零占位并验证。沿用既有窗口、列和主题循环，无新增媒体或解码。

媒体库斑马色在同一 admin 亮/暗循环中比较相邻普通行与图标背景的最终颜色和渐变层，要求两种完整背景精确交叉相等。旧实现图标使用 panel、行依赖透明叠色，无法交叉匹配。沿用既有文件夹行，无新增素材、导航或解码成本。

媒体目录卡片调整复用 admin 的编辑与真实保存用例：核对还原/保存均位于编辑区上方、软盘图标按钮保留可访问名称、输入框无边框；继续验证两列对齐、未保存导航保护及保存后的服务配置。截图保留亮暗与窄屏检查，无新增素材或服务写入次数。
