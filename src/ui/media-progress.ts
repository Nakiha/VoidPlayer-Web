import { msg, t } from '../i18n.ts';
import type { MediaLoadStage } from '../media-progress.ts';
const stages = {
 queued: msg('progress.queued', '正在准备载入'), download: msg('progress.download', '正在读取视频数据'),
 decode: msg('progress.decode', '正在选择解码方式'), inspect: msg('progress.inspect', '正在读取视频信息'),
 index: msg('progress.index', '正在建立帧索引'), decoder: msg('progress.decoder', '正在启动软件解码器'),
 'first-frame': msg('progress.firstFrame', '正在解码首帧'), synchronize: msg('progress.synchronize', '正在定位到当前播放位置'),
};
export const loadStageLabel = (stage: MediaLoadStage) => t(stages[stage]);

export type { MediaLoadStage } from '../media-progress.ts';
