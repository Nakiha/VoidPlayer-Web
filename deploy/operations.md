# 独立程序的后台运行与恢复

以下操作用于解压后的独立发布包。先完成 `--init`、`--check` 和一次前台媒体读取验证，再设置后台运行。程序目录与可写数据目录分开；升级时替换程序，保留数据。服务账号必须能读取媒体路径，并能写入自己的数据目录。

## Linux：systemd

示例约定程序位于 `/opt/voidplayer/current/voidplayer`，数据位于 `/var/lib/voidplayer`。`current` 可以是指向某次解压目录的符号链接。不要把数据放进 `current`。使用独立 `voidplayer` 账号，并通过存储的组权限或 ACL 授予媒体只读权限。

以该账号初始化后，将以下内容保存为 `/etc/systemd/system/voidplayer.service`：

```ini
[Unit]
Description=VoidPlayer media service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=voidplayer
Group=voidplayer
ExecStart=/opt/voidplayer/current/voidplayer --data-dir /var/lib/voidplayer
WorkingDirectory=/var/lib/voidplayer
EnvironmentFile=-/etc/voidplayer.env
Restart=on-failure
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/voidplayer

[Install]
WantedBy=multi-user.target
```

如果媒体来自系统挂载的网络盘，在 `[Unit]` 中添加 `RequiresMountsFor=/实际挂载点`；路径和凭据由操作系统管理。远端访问仍须经过 HTTPS 认证网关，令牌可放在仅服务管理员可读的 `/etc/voidplayer.env`，格式为 `VOIDPLAYER_PROXY_TOKEN=实际令牌`。不要将该文件放入程序目录或源码仓库。

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now voidplayer
sudo systemctl status voidplayer
sudo journalctl -u voidplayer --since '10 minutes ago'
sudo systemctl stop voidplayer
sudo systemctl start voidplayer
```

`stop` 会先发送 SIGINT，正常结束现有连接；超时由 systemd 收尾。启动失败看 journal 中具体的配置、权限或端口错误。取消开机启动使用 `sudo systemctl disable --now voidplayer`。

## macOS：用户 LaunchAgent

用系统文本编辑器创建 `~/Library/LaunchAgents/dev.voidplayer.standalone.plist`。将示例中的三个路径替换为实际绝对路径；不要使用 `~`，XML 特殊字符需要转义。先创建日志目录。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.voidplayer.standalone</string>
  <key>ProgramArguments</key><array>
    <string>/absolute/path/to/program/voidplayer</string>
    <string>--data-dir</string><string>/absolute/path/to/data</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ExitTimeOut</key><integer>10</integer>
  <key>StandardOutPath</key><string>/absolute/path/to/logs/service.log</string>
  <key>StandardErrorPath</key><string>/absolute/path/to/logs/service-error.log</string>
</dict></plist>
```

```sh
plutil -lint ~/Library/LaunchAgents/dev.voidplayer.standalone.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.voidplayer.standalone.plist
launchctl print gui/$(id -u)/dev.voidplayer.standalone
launchctl bootout gui/$(id -u)/dev.voidplayer.standalone
```

登录时启动，异常退出后重启；`bootout` 停止并卸载本次登录会话的服务，下次启动用 `bootstrap`。取消以后登录自动启动时，在 `bootout` 后移走此 plist。不要用源码开发用的 `npm run service` 管理独立程序。服务文本日志需要由管理员轮转，浏览器诊断日志的本地保留策略不适用于这些文件。

## Windows：计划任务

前台使用 PowerShell 运行程序，Ctrl+C 停止。需要登录后自动后台运行时，可在同一用户的 PowerShell 中注册计划任务；此方式无需安装 Node 或第三方服务包装器：

```powershell
$program = 'C:\VoidPlayer\current\voidplayer.exe'
$dataDirectory = 'C:\VoidPlayerData'
& $program --data-dir $dataDirectory --check
if ($LASTEXITCODE -ne 0) { throw '请先修复配置或目录错误' }
$action = New-ScheduledTaskAction -Execute $program -Argument ('--data-dir "{0}"' -f $dataDirectory)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'VoidPlayer' -Action $action -Trigger $trigger -Settings $settings -Description 'VoidPlayer standalone media service'
Start-ScheduledTask -TaskName 'VoidPlayer'
Get-ScheduledTaskInfo -TaskName 'VoidPlayer'
```

检查 `http://127.0.0.1:5180/api/ready` 是否就绪。更换端口后使用配置中的地址。停止用 `Stop-ScheduledTask -TaskName 'VoidPlayer'`；删除自动启动配置用 `Unregister-ScheduledTask -TaskName 'VoidPlayer' -Confirm`。

计划任务的停止是操作系统终止进程，不等同于前台 Ctrl+C 的正常退出；备份前应确认任务已停止。此示例在用户登录后运行，不宣称支持未登录即启动的原生 Windows Service。Windows 服务管理器不能直接把普通控制台 exe 注册成服务。长期无人值守远端部署可使用本项目提供的 Linux 容器与认证网关。

## 停机备份、升级与回退

1. 记录当前 `--version`、完整启动命令、数据目录位置和挂载点配置。停止后台任务，并确认进程已经退出。
2. 复制**整个**数据目录到备份位置，保留文件属性和 ACL。外置的 `--config`、网关账号/令牌、系统服务定义和挂载配置需一起备份。服务未停止时不要直接复制可能正在写入的数据文件。
3. 保留旧程序包及 `.sha256`。校验并解压新包到新目录，使用相同数据目录执行 `--check`，再切换 `current` 或后台任务的程序路径并启动。
4. 检查 `/api/ready`、带认证的媒体列表与实际视频读取。启动失败时，先停止新程序，再恢复旧程序路径；如果新版本已改变数据格式，应恢复本次升级前的完整数据备份，不要让旧程序直接打开新格式。
5. 定期将备份恢复到另一数据目录，使用与备份匹配的程序和一个空闲端口启动，验证配置与媒体引用。只检查备份文件存在不算恢复验证。

当前首次引入 SQLite schema 1。数据目录包含 `library.sqlite` 及可能存在的 WAL/SHM/锁文件，必须停机复制整个目录；未知的更新 schema 会拒绝打开。旧 preview.1 没有数据库，升级会创建索引；回退应使用升级前备份。媒体原文件由存储系统备份，数据目录和工作区文件并不包含视频副本。备份中的账号、令牌、私有 CA 私钥和诊断记录应按原数据的访问权限保管。

容器部署需备份应用的 `app-data` 卷和 Caddy 数据卷以保留已被客户端信任的 CA；操作见 `README.md`。不要在正常升级时使用 `docker compose down -v` 删除该卷。
