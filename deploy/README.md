# 运行与内网部署

发布包包含构建后的网页、单/多线程 WASM、零运行时依赖的 Node 服务及部署配置。
媒体文件、真实配置、账号、日志不进包。运行要求 Node 24+；正式运行不需要 Vite、npm install 或本机 FFmpeg。

## 本机：一个服务提供网页和媒体库

解压发布包，进入包目录：

```sh
node server/main.ts --folder /absolute/path/to/media --port 5180 --no-logs
```

打开 `http://127.0.0.1:5180/`。可重复传入 `--folder` 添加白名单目录。
复制 `voidplayer.config.example.json` 为 `voidplayer.config.json` 后，也可使用 `npm start`。
配置文件内的相对路径以配置文件所在目录为基准。`logsDir` 控制用户主动上传的诊断日志；设为 `null` 禁用上传。
本机 Finder/Explorer 定位需要显式启用 `allowLocalReveal`，不要用于远端或端口转发。

## 内网小团队：HTTPS + 每人独立账号

应用自身仍为单个 Node 服务；Caddy 只负责 HTTPS 和登录入口。
下列步骤在有 Docker Engine / Compose 的目标服务器执行。先为服务器配置内网域名及 DNS。

1. 进入发布包的 `deploy/`，复制 `.env.example` 为 `.env`，设置 `VOIDPLAYER_SITE` 为实际内网域名，`VOIDPLAYER_MEDIA_DIR` 为服务器媒体目录的绝对路径。目录需允许容器内 UID 1000 读取；挂载只读，应用不能改源文件。
2. 用下面的命令生成网关密钥，将输出写入 `.env` 的 `VOIDPLAYER_PROXY_TOKEN`，不要提交配置或把密钥发到聊天中：

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
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

**当前评审仍保存在页面会话中，关闭前需要导出。** 这不是完整的协作存储或操作审计：后续保存/修改/删除标注的 API 应由后端从认证身份填写作者，并保存服务器时间、版本和操作记录。客户端 JSON 中的作者字段不是防篡改证据。页面里的每次 seek、播放和绘图也没有上传成团队审计记录。
Basic Auth 暂无应用内账号管理、改密与登出界面；本轮适用于受管理的小团队入口。账号 ID 重命名会被视为新身份，需稳定分配。

### 运维与更新

- `/api/health`：进程存活；`/api/ready`：初始媒体索引已建立。容器健康检查使用 ready。
- 共享媒体索引默认有效期 30 秒，到期后的首次访问刷新；媒体库刷新按钮立即刷新。视频 Range 请求在有效期内直接查索引，仍检查文件存在、大小/修改时间及白名单边界。
- `docker compose logs --tail=100 app gateway` 查看服务请求日志；默认每容器 10 MB × 3 轮转。这是短期排障记录，不是长期审计存档。浏览器诊断仍保存在本地，容器默认禁用上传。
- 修改账号文件后执行 `docker compose exec gateway caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`；网关密钥更新需重建两个容器的环境。
- 更新时校验新包 `.sha256`，解压到新目录，只迁移实际 `.env`、`users.caddy`，执行 `docker compose up -d --build`。模板固定项目名为 `voidplayer`，避免新目录另建一套 CA 数据卷；同机多实例需各自指定并保留不同项目名。保留旧包便于回退。
- `docker compose down` 停止；不要加 `-v`，否则会删除 CA 数据卷，客户端证书信任需要重新配置。备份 CA 私钥所在卷时按密钥管理要求保护。

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

## 发布与校验

源码仓库执行 `npm run release`，产物在 `artifacts/`；`.tar.gz.sha256` 校验归档，包内 `release.json` 包含逐文件 SHA-256。发布不包含 node_modules 或真实片源。
开发机可运行 `CADDY_BIN=/path/to/caddy node scripts/check-gateway.mjs` 做独立的 HTTPS/鉴权/Range 验证；使用临时私有 CA，不安装到系统信任。

配置依据：[Caddy Basic Auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth)、[反向代理请求头](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[自动 HTTPS 与本地 CA](https://caddyserver.com/docs/automatic-https)。
