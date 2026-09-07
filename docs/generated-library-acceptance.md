# 生成片源验收环境

本轮按用户确定的范围，以本地生成的真实可解码文件验证媒体库和独立发布包。SMB/NFS 实测延期；以下目录离线模拟不验证网络协议、实际挂载语义或 NAS 吞吐。

## 生成

开发/验收机器需要 FFmpeg（libx264、FFV1、MPEG-2 编码器）和 ffprobe；最终用户运行发布包不需要它们。

```sh
npm run fixtures:library
```

脚本在 `.run/generated-library-*` 新建独占目录，输出 JSON 中的 `directory` 为实际路径，不覆盖已有目录。可用 `FFMPEG` / `FFPROBE` 指定可执行文件。生成内容：

- 9 个不同样片：H.264 / FFV1 10-bit / MPEG-2，各 3 个尺寸、时长和色相组合；每个母片完整解码一次，记录 FFmpeg 版本、像素格式、时长和 SHA-256。
- 3 个媒体根目录，根层及中间目录有散落文件，同名片源跨根重复；归档根包含 12 层嵌套，各层都有片源。
- 三个母片复制成 5,200 个独立 H.264 文件，加上深层与零散样片共 5,242 个媒体条目，约 590 MB。不是 5,242 个不同编码内容；每条路径的真实字节及摘要记在 `fixture.json`，没有伪视频占位文件。

## 对发布产物验收

从对应版本 GitHub Actions 或 Release 下载本机平台的 `.tar.gz` 和同名 `.sha256`。下列命令中的路径替换为实际生成目录和归档：

```sh
VOIDPLAYER_LIBRARY_FIXTURE=.run/generated-library-xxxxxx \
  npm run test:release:browser -- /absolute/path/to/package.tar.gz webkit
VOIDPLAYER_LIBRARY_FIXTURE=.run/generated-library-xxxxxx \
  npm run test:release:browser -- /absolute/path/to/package.tar.gz chromium
```

脚本核验全部媒体摘要和发布清单，从归档启动独立程序，使用空 PATH、临时数据目录、随机回环端口，与正在使用的开发服务无关。依次验证：

1. 5,242 条路径准确入库、稳定 ID、同名文件隔离、200 项 API 分页、260 项目录尾页和深层搜索。
2. 四路 Range 与扫描实际重叠；逐字节核对响应及 Content-Range，设置请求超时。
3. 打包网页中的根目录选择、60 项分页、搜索及载入；跨根 H.264 / FFV1 双轨、偏移、标注、视口、gzip 导入导出和服务器保存。
4. 移走一个生成根目录后保留缓存，其他根仍可读取；离线期间重启服务，恢复目录后原版本引用和保存的工作区仍可还原。
5. 替换生成媒体后 ID 保持稳定，旧版本 URL 返回 409；结束时恢复原始样片字节。

每次测试创建新的服务数据目录。替换测试会改变片源的文件系统时间，因此不要把该生成目录当作长期工作区使用。脚本正常结束或断言失败会停止其服务、清理临时程序/数据并还原移走的目录；强制杀死测试进程后如留下 `archive.offline`，需手动移回 `archive`。确认不再使用后，可删除该独占生成目录回收空间。

原有真实解码样片的四组播放基准仍单独运行；这些低分辨率生成片源用于库规模和恢复验收，不代表生产视频的解码吞吐上限。
