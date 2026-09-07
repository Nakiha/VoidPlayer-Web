# VoidPlayer 便携运行包

解压与你的系统匹配的包，直接运行，不需要安装 Node、Bun、FFmpeg，也不需要建立专用系统账号。

```sh
./voidplayer
```

Windows 在解压目录运行 `./voidplayer.exe`。打开 `http://127.0.0.1:5180/` 即可使用；首次媒体库为空，可以直接打开本地视频，也可以在服务管理页 `/admin` 添加媒体目录。

也可以启动时指定片源：

```sh
./voidplayer --folder /你的媒体目录
```

首次启动自动保存配置，以后直接运行程序即可。`--folder` 可重复指定；已有配置时它是本次启动的覆盖，不会自动覆盖已保存的媒体目录。

## 远程 WebCodecs 与硬件解码

在 Linux 上直接开启内置 HTTPS，把下面的地址换成 Windows 实际访问的服务器 IP 或域名：

```sh
./voidplayer --https 192.168.1.20
```

该选项默认监听所有网卡，在原端口（默认 5180）提供 HTTPS。多个地址可写成 `--https 192.168.1.20,player.lan`。不需要 Caddy、OpenSSL、域名服务或公网连接。

首次启动会在 `data/tls/` 创建本地根证书和服务器证书。将其中的 **`voidplayer-ca.crt`** 复制到 Windows，在它所在目录运行一次：

```powershell
certutil -user -addstore Root .\voidplayer-ca.crt
```

关闭并重新打开浏览器，再访问 **`https://192.168.1.20:5180/`**。使用启动时指定的地址；根证书从你自己的服务器复制，程序会打印证书 SHA-256 指纹。只分发 `.crt` 公共证书，不分发 `authority.json` 或 `server.json` 中的私钥。

首次没有配置时，`--https` 会随新配置保存。已有配置时，继续使用同一启动命令；若希望以后直接运行程序，可在 `data/voidplayer.config.json` 中设置 `"host": "0.0.0.0"` 和 `"tls": { "hosts": ["192.168.1.20"] }`。更换 IP 后更新 hosts/启动参数即可，根证书保持不变，已信任的客户端不用重新安装；服务器证书在启动时按地址和有效期重新签发。

已有受信任证书时，可用 `"tls": { "certFile": "tls/server.pem", "keyFile": "tls/server.key" }`，路径相对配置文件；此模式不会生成或改写证书。

在“设置 → 性能”检查安全上下文和 WebCodecs 是否启用；轨道信息显示“WebCodecs · 硬件优先”时，表示浏览器接受了硬件优先请求，**不代表网页能够证明实际使用了 GPU**。浏览器不接受该硬件配置时使用浏览器自动解码；WebCodecs 不支持的编码才回退到 WASM，界面明确显示“WASM 软件解码”。实际硬件使用需在目标 Windows 的浏览器媒体诊断与任务管理器 Video Decode 中核验。HTTP 内网地址不会开启 WebCodecs；页面和媒体都应使用上述 HTTPS 同源地址。

## 文件都在哪里

程序只在**可执行文件旁边的 `data/`** 下保存运行数据，与从哪个工作目录启动无关：

| 路径 | 内容 |
| --- | --- |
| `voidplayer` / `voidplayer.exe` | 独立程序 |
| `dist/` | 随包网页和解码器资源 |
| `data/voidplayer.config.json` | 自动生成的配置 |
| `data/library.sqlite` | 媒体索引 |
| `data/workspaces.sqlite` | 用户和保存的工作区 |
| `data/logs/` | 用户主动上传的诊断日志 |
| `data/tls/` | HTTPS 证书与私钥（启用 HTTPS 后生成） |

SQLite 的 WAL、SHM 和进程锁也留在 `data/` 内。不会默认写入用户的 AppData、Application Support、XDG 目录或 `/var/lib`。程序不安装系统服务，也不自动读取启动目录的 `.env` 或 `bunfig.toml`。控制台日志输出到终端，不额外创建服务日志文件。浏览器自身保存的身份和诊断记录仍在浏览器存储里。

整个解压目录放在当前用户可写的位置即可；目录不可写时会报错，不会悄悄改用其他目录。

## 可选参数

- `--port 5180 --host 0.0.0.0`：允许内网其他机器访问。默认仅本机访问。
- `--https IP或域名`：内置 HTTPS 和便携证书，远程使用 WebCodecs。
- `--data-dir /其他目录`：主动选择外置数据目录。也支持 `VOIDPLAYER_DATA_DIR`；命令行优先。
- `--config /配置文件`：读取指定配置，不自动创建或覆盖它。配置中的相对路径相对该文件，命令行路径相对当前工作目录。
- `--init`：仅生成配置并退出，不覆盖已有配置；普通启动不需要先执行它。
- `--check`、`--healthcheck`、`--version`、`--help`：检查配置、就绪状态、版本和帮助。
- `--no-logs`：禁用用户主动上传诊断日志。

默认前台运行，Ctrl+C 停止。需要关闭终端后继续运行，可看 [后台运行与更新](operations.md)。管理页的远端管理用户名在 `adminUsers` 中配置，见 [服务管理](admin.md)。

## 搬家、升级和旧版迁移

停止程序后，移动整个文件夹即可保留配置、用户与评审；外部媒体路径仍需有效。

升级时停止旧程序，备份整个 `data/`，解压新包到新文件夹，把 `data/` 复制进去，再启动新程序。也可以保留原文件夹中的 `data/`，只替换程序和随包资源。不要同时运行两个指向同一数据目录的实例。

旧版数据不会被自动搬动或删除。如果之前使用系统用户目录或 `/var/lib/voidplayer`，停止旧程序后将其中的配置、数据库和日志整体复制到新包的 `data/`，或者继续显式使用 `--data-dir` 指向原位置。旧配置中自定义的绝对路径会保留，需要时手动调整。

媒体索引和用户工作区当前都使用 SQLite schema 2。回退旧程序时使用升级前的完整数据备份；不要把保存用户和评审的 `workspaces.sqlite` 当缓存删除。视频原文件不在数据备份中。

## 包的来源

`release.json` 记录平台、版本、源码修订和逐文件校验和；`BUILD-SOURCES.md` 记录构建来源，`source.tar.gz` 是对应源码。运行不依赖源码包。macOS 包的签名和公证尚未提供。
