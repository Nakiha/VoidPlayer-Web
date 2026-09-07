# 便携运行

解压独立包，直接运行 `./voidplayer`（Windows 为 `./voidplayer.exe`），打开 `http://127.0.0.1:5180/`。

首次自动创建程序旁边的 `data/`，配置、用户、工作区、索引与上传日志都集中在里面。不需要安装系统服务、专用账号、容器或网关。

- [运行、目录与升级](standalone.md)
- [可选后台运行与备份](operations.md)
- [媒体库与服务管理](admin.md)

远程 WebCodecs 使用 `./voidplayer --https 服务器IP`，在客户端信任 `data/tls/voidplayer-ca.crt` 后访问 HTTPS；Windows 一次性信任命令及已有证书配置见[运行说明](standalone.md#远程-webcodecs-与硬件解码)。程序自己提供 HTTPS，证书和私钥都留在 data/，不需要代理或外部证书工具。

普通 HTTP 内网共享仍可加 `--host 0.0.0.0`，使用 WASM 软件解码。首次访问自动创建用户，设置 → 用户中可改名或选择已有用户，完全信任用户自选身份。
