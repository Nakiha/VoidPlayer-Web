# VoidPlayer 独立运行包（预览版）

无需安装 Node、Bun、npm 或 FFmpeg。选择与系统/架构匹配的包，校验 `.sha256` 后解压。
保持 `voidplayer`（Windows 为 `voidplayer.exe`）与 `dist/` 在同一目录。

## 首次运行

```sh
/path/to/voidplayer --init --folder /absolute/path/to/media --data-dir /absolute/path/to/voidplayer-data
/path/to/voidplayer --data-dir /absolute/path/to/voidplayer-data --check
/path/to/voidplayer --data-dir /absolute/path/to/voidplayer-data
```

Windows 可在 PowerShell 中用 `& 'C:\VoidPlayer\voidplayer.exe'` 替换程序路径；包含空格的所有路径需要加引号。
`--folder` 可重复；`--init` 只创建配置并退出，已有配置不会覆盖。打开 http://127.0.0.1:5180/。
也可直接用 `--folder /media` 临时启动，不写配置。

未指定 `--data-dir` 时使用 `VOIDPLAYER_DATA_DIR`，否则使用系统用户数据目录：
macOS 为 `~/Library/Application Support/VoidPlayer`，Windows 为 `%LOCALAPPDATA%\VoidPlayer`，
Linux 为 `$XDG_DATA_HOME/voidplayer` 或 `~/.local/share/voidplayer`。
配置文件为该目录下的 `voidplayer.config.json`；用户主动上传的日志保存在 `logs/`。
可用 `--config` / `VOIDPLAYER_CONFIG` 指定其他配置，文件内相对路径以配置文件所在目录为基准。
程序不自动读取当前目录中的 `.env` 或 `bunfig.toml`。

`--version` 显示产物版本，`--healthcheck` 检查运行实例就绪状态，`--help` 显示选项。
默认前台运行；Ctrl+C / SIGTERM 正常退出，未结束的连接最多等待 5 秒后关闭。
长期运行应交给系统服务管理器或容器，服务的启动命令使用绝对路径并显式指定数据目录。
macOS 公网下载包的签名/公证尚待首发平台验收，不提供绕过系统信任检查的启动脚本。

## 升级与恢复

1. 停止旧服务并备份独立数据目录，保留旧程序包。
2. 校验新包并解压到新目录，不覆盖数据目录。
3. 用同一个 `--data-dir` 执行新程序的 `--check`，再启动并检查媒体读取。
4. 本阶段没有数据库迁移；失败时停止新程序，使用旧程序和原数据目录恢复。未来数据库升级需按对应版本迁移说明处理。

媒体原文件由存储系统备份，不在程序包或工作区文件中。更新程序不删除视频、用户配置或日志。

## 远端部署

远端使用 HTTPS 和认证网关；具体配置见 `deploy/README.md`。不能仅将 `--host` 改为公网地址。
`deploy/Dockerfile` 消费此包中的 Linux 可执行文件；macOS/Windows 包不能放进 Linux 容器。

## 验收与来源

`release.json` 列出平台、Bun 版本、源码修订和逐文件 SHA-256；`BUILD-SOURCES.md` 记录来源。
`source.tar.gz` 包含本次应用源码，便于重建；编译后的程序运行不依赖该源码包。
本产物为预览版，跨平台、真实网络存储、网关和签名等验收进度见项目 Roadmap。
