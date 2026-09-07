# 运行与内网部署

预览发布包包含 Bun 独立可执行程序、构建后的网页、单/多线程 WASM、应用源码快照及部署配置。
媒体文件、真实配置、账号、日志不进包。运行不需要预装 Node、Bun、Vite、npm 依赖或本机 FFmpeg。开发与构建仍使用 Node 24+，构建可执行程序需要 `.bun-version` 指定的 Bun。

## 本机：一个服务提供网页和媒体库

解压发布包，进入包目录：

```sh
./voidplayer --folder /absolute/path/to/media --port 5180 --no-logs
```

打开 `http://127.0.0.1:5180/`。可重复传入 `--folder` 添加白名单目录。
持久化配置请执行 `./voidplayer --init --folder /absolute/path/to/media --data-dir /absolute/path/to/data`，然后用相同 `--data-dir` 启动。详细路径、检查和升级约定见 [独立运行说明](standalone.md)。
配置文件内的相对路径以配置文件所在目录为基准。`logsDir` 控制用户主动上传的诊断日志；设为 `null` 禁用上传。
本机 Finder/Explorer 定位需要显式启用 `allowLocalReveal`，不要用于远端或端口转发。

## 内网小团队：HTTPS + 每人独立账号

应用自身仍为单个独立服务程序；Caddy 只负责 HTTPS 和登录入口。
下列步骤从与服务器架构匹配的 Linux 发布包执行，目标服务器需有 Docker Engine / Compose。源码目录及 macOS/Windows 包不能直接作为该 Dockerfile 的构建上下文。先为服务器配置内网域名及 DNS。

1. 进入 Linux 发布包的 `deploy/`，复制 `.env.example` 为 `.env`，设置 `VOIDPLAYER_SITE` 为实际内网域名，`VOIDPLAYER_MEDIA_DIR` 为服务器媒体目录的绝对路径。目录需允许容器内 UID 1000 读取；挂载只读，应用不能改源文件。
2. 用下面的命令生成网关密钥，将输出写入 `.env` 的 `VOIDPLAYER_PROXY_TOKEN`，不要提交配置或把密钥发到聊天中：

   ```sh
   openssl rand -hex 32
   ```

3. 复制 `users.caddy.example` 为 `users.caddy`。每人一个固定账号 ID（字母、数字、`_.@-`，最多 128 字符），不要共用。交互式生成密码哈希，文件中每行写 `账号ID 哈希`，不要写明文密码：

   ```sh
   docker run --rm -it caddy:2.11.4 caddy hash-password
   chmod 600 .env users.caddy
   ```

4. 检查配置并启动：

   ```sh
   docker compose config --quiet
   docker compose up -d --build
   docker compose ps
   ```

仅网关向主机开放 80/443；媒体端口不发布。应用拒绝没有有效网关凭据的媒体请求，用户名由网关认证后覆盖转发，应用不信任浏览器自行声明的身份。

### 内网 HTTPS 的证书

默认使用 Caddy 私有 CA。客户端需由团队管理员分发并信任其根证书，可导出公开证书：

```sh
docker compose cp gateway:/data/caddy/pki/authorities/local/root.crt ./voidplayer-root.crt
```

请通过团队的系统信任配置/设备管理分发，并核验来源。不要分发 `root.key` 或整个 CA 数据卷，也不要让测试人员跳过证书错误。可信 HTTPS 是浏览器媒体能力与跨源隔离正常工作的前提。
已有组织证书时改用组织的证书配置；使用可验证公网域名和自动证书时，可移除 Caddyfile 的 `tls internal`，按实际 DNS/网络条件配置。

### 身份与评审记录的边界

登录账号作为稳定 `actor.id` 传给页面，新标注和导出的评审包含作者快照。右上角状态提示显示当前账号。网关拒绝错误密码，后端访问日志包含 requestId、actorId、请求路径、结果与耗时；不记录密码、网关密钥或请求正文。

**页面会话不会自动保存；关闭前可导出文件，或在设置中主动保存到服务器。** 服务器工作区记录可信归属、更新时间和版本，更新/删除需版本匹配，冲突时可另存副本。管理员可以检视和管理工作区，详见 [服务器工作区](admin.md#服务器工作区)。这不是实时协作或完整操作审计：客户端 JSON 中的标注作者字段不是防篡改证据，页面里的每次 seek、播放和绘图也没有上传成团队审计记录。
Basic Auth 暂无应用内账号管理、改密与登出界面；本轮适用于受管理的小团队入口。账号 ID 重命名会被视为新身份，需稳定分配。

### 运维与更新

- `/api/health`：进程存活；`/api/ready`：已有可查询的媒体索引（可能来自上次运行，存储是否在线需另看扫描状态）。容器健康检查使用 ready。
- 媒体索引保存在本地 SQLite，后台默认每 30 秒校准。Range 请求直接查索引，不等待全库扫描；仍检查文件版本和白名单边界。根目录离线时保留缓存，任务状态见 `/api/library/scan`。
- 应用数据保存在 `app-data` 卷，媒体 `/media` 保持只读；迁移时保留该卷及配置。备份前停止应用，复制完整 `/data`，不能只复制正在写入的 SQLite 主文件。
- `docker compose logs --tail=100 app gateway` 查看服务请求日志；默认每容器 10 MB × 3 轮转。这是短期排障记录，不是长期审计存档。浏览器诊断仍保存在本地，容器默认禁用上传。管理身份、持久化配置和启用方式见 [服务管理](admin.md)。
- 修改账号文件后执行 `docker compose exec gateway caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`；网关密钥更新需重建两个容器的环境。
- 更新时校验新包 `.sha256`，解压到新目录，只迁移实际 `.env`、`users.caddy`，执行 `docker compose up -d --build`。模板固定项目名为 `voidplayer`，避免新目录另建一套 CA 数据卷；同机多实例需各自指定并保留不同项目名。保留旧包便于回退。
- `docker compose down` 停止；不要加 `-v`，否则会删除媒体索引和 CA 数据卷，客户端证书信任需要重新配置。备份 CA 私钥所在卷时按密钥管理要求保护。

## 源码开发与 macOS 后台运行

在源码仓库运行 `npm run dev` 会在同一个 Node 进程中启动网页 5178 和媒体 5180；退出会一并停止。`npm run dev:web` 仅用于不需要媒体库的纯网页调试。端口冲突直接报错，不自动改端口。

```sh
cp voidplayer.config.example.json voidplayer.config.json
# 检查媒体目录与端口后，选择前台 npm run dev 或后台服务，不能同时运行：
npm run service -- install
npm run service -- status
npm run service -- stop
npm run service -- start
npm run service -- uninstall
```

后台服务由 macOS 用户 LaunchAgent 管理，登录自动启动、异常退出重启，与 Codex 进程独立。`stop` 仅停止本次运行，下次登录仍启动；`uninstall` 删除自动启动配置。Node 安装路径或仓库位置改变后重新安装服务。前端有热更新；修改后端或服务配置后需要 stop/start。日志在 `.run/`，开发日志目前不自动轮转。
`--production` 管理独立的生产模式用户服务，使用前必须构建，并避免与开发服务占用同一媒体端口。

独立程序的 systemd、LaunchAgent、Windows 计划任务与停机备份/回退步骤见 [后台运行与恢复](operations.md)。

## 发布与校验

源码仓库安装 `.bun-version` 指定的 Bun 后执行 `npm run release`（可用 `BUN_BIN` 指定路径），产物在 `artifacts/`；`.tar.gz.sha256` 校验归档，包内 `release.json` 包含逐文件 SHA-256。发布不包含 node_modules 或真实片源。
`node scripts/package-release.mjs --target bun-linux-x64` 可从已构建网页生成其他平台的包；交叉编译不代表已在该平台运行。`npm run test:release` 在当前平台校验并测试最新产物，也可显式传归档路径。

正式打包入口是 GitHub Actions 的 [Build and verify standalone releases](https://github.com/Nakiha/VoidPlayer-Web/actions/workflows/release-preview.yml)。推送代码到 `main` 自动运行（纯文档改动除外），也可在 Actions 页面点击 **Run workflow**，无需手工准备 core 下载地址。

1. Linux 构建任务读取 `scripts/release-core.json`，检出固定修订的独立解码器构建仓库、FFmpeg 和 dav1d，使用固定 Emscripten/Meson/Ninja 构建单/多线程 core。裁剪和编译逻辑仍由解码器仓库维护。源码和构建工具锁定不变时复用缓存，缓存也重新校验接口、来源和逐文件 SHA-256。
2. Linux x64（Ubuntu 24.04）、Windows x64（Windows Server 2022）、macOS ARM64（macOS 14）原生 runner 消费同一份 core，使用固定 Node/Bun 构建网页和独立程序，再验证解压产物。Node 仅用于构建与测试；被测程序运行时 PATH 为空。
3. 运行成功后，在该次 Actions 页面的 **Artifacts** 下载 `voidplayer-linux-x64`、`voidplayer-windows-x64` 或 `voidplayer-darwin-arm64`。外层是 GitHub artifact ZIP，里面是发布包 `.tar.gz` 及 `.sha256`；解开发布包即可运行。预览包保留 30 天，尚未纳入 Linux ARM64、Windows ARM64 和 Intel Mac 的验收。

包内 `release.json` 和 `BUILD-SOURCES.md` 记录应用修订、运行时版本、解码器精确源码修订和构建任务链接，core 自身的 `provenance.json` 记录其字节校验和。更新解码器时先提交并推送解码器仓库，再更新 lock；不引用本地未提交源码或浮动的 `latest`。

分支构建生成预览产物；版本标签构建在三平台任务全部通过后生成未发布的 Release 草稿。汇总任务核对三个归档的版本、Git 修订、Bun 版本、解码器来源和相同 core 字节，检查归档 SHA-256，提供 `verified-release-set` artifact。只有草稿任务拥有写入 Release 的权限。Windows 额外测试独立控制台 Ctrl+C 正常退出；Linux 额外运行随包 Docker/Compose/Caddy 模板，验证可信 TLS、鉴权、并发 Range 和重启保留 CA。三平台均测试 SQLite、扫描期间并发 Range、进程锁、崩溃恢复，以及停机备份后在离线存储上恢复索引。真实网络存储仍需独立验收，进度见项目 Roadmap。

开发机可运行 `CADDY_BIN=/path/to/caddy node scripts/check-gateway.mjs` 做独立的 HTTPS/鉴权/Range 验证；使用临时私有 CA，不安装到系统信任。

配置依据：[Caddy Basic Auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth)、[反向代理请求头](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[自动 HTTPS 与本地 CA](https://caddyserver.com/docs/automatic-https)。

### 从发布包运行浏览器验收

在匹配目标平台的验收机上准备仓库测试依赖和 Playwright 浏览器、同步 QA 样片后运行：

```sh
npm run test:release:browser -- /path/to/voidplayer-package.tar.gz webkit
npm run test:release:browser -- /path/to/voidplayer-package.tar.gz chromium
RELEASE_BENCH=1 npm run test:release:browser -- /path/to/voidplayer-package.tar.gz webkit
```

脚本核验归档与逐文件 SHA-256，在临时目录解压包，用空 PATH、独立数据目录和空闲端口启动包内程序；不构建或使用仓库的 `dist/`，不重启已有服务。验证双轨真实解码、矢量标注、gzip 导出/导入、服务器保存、管理页检视和进程重启后的恢复。`RELEASE_BENCH=1` 额外运行四组播放基准。`VOIDPLAYER_SAMPLES` 可指定共享 QA 样片目录，默认读取 `fixtures/video`。这些本地浏览器工具属于验收机依赖，不是最终用户的运行依赖；也不替代真实网络挂载验收。

### 版本标签与 Release 草稿

1. 将 `package.json` 与 lockfile 的版本更新为目标 `x.y.z`，并提交 `docs/releases/<版本>.md`，说明支持平台、改动、升级步骤和已知限制。正式标签使用 `vx.y.z`，候选标签可使用 `vx.y.z-rc.1`，候选版的说明文件相应为 `x.y.z-rc.1.md`。
2. 确认目标修订和工作区干净，再创建并推送对应 Git 标签。工作流会检查标签指向当前修订、版本匹配及说明存在。也可以在 Actions 页面选择已有版本标签重跑；不要移动已经发出的标签。
3. 三平台原生验收、Linux HTTPS/Docker 验收及汇总校验通过后，Actions 将同一批受测归档及校验文件放入 Release 草稿，上传后再比对 GitHub 返回的 SHA-256。标签包名称固定，例如 `voidplayer-0.1.0-linux-x64.tar.gz`；程序报告的版本与标签一致。
4. 在草稿中核对说明和三平台附件，完成 Roadmap 当前约定的生成片源环境及正式验收后再点击 **Publish release**。自动流程始终保留草稿状态；候选标签的草稿自动标为 prerelease。

中断后可重跑失败的草稿任务：相同校验和的已有附件会跳过。已有公开 Release、归属修订/说明不符、同名异内容附件或不完整附件会阻止继续，不删除或覆盖。此时先检查失败原因；如需重新构建不同内容，使用新候选版本，避免更换已经受测的包。跨平台构建成功本身不替代真实 SMB/NFS 验收。

流程依据：[GitHub 工作流权限](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)、[Release 草稿](https://docs.github.com/en/rest/releases/releases#create-a-release)、[附件上传与摘要](https://docs.github.com/en/rest/releases/assets#upload-a-release-asset)。

本轮媒体库验收使用 FFmpeg 生成的 5,242 个真实可解码文件（多根目录、12 层嵌套、零散文件），实际 SMB/NFS 验证延期。生成及针对归档运行的方法见 [生成片源验收](../docs/generated-library-acceptance.md)。
