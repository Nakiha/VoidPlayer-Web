# 便携运行

解压独立包，直接运行 `./voidplayer`（Windows 为 `./voidplayer.exe`），打开 `http://127.0.0.1:5180/`。

首次自动创建程序旁边的 `data/`，配置、用户、工作区、索引与上传日志都集中在里面。不需要安装系统服务、专用账号、容器或网关。

- [运行、目录与升级](standalone.md)
- [可选后台运行与备份](operations.md)
- [媒体库与服务管理](admin.md)

内网共享加 `--host 0.0.0.0`。普通 HTTP 可使用单线程 WASM 解码；localhost 上会按浏览器能力使用 WebCodecs 和多线程 WASM。首次访问自动创建用户，设置 → 用户中可改名或选择已有用户，完全信任用户自选身份。
