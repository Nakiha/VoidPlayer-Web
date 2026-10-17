const USER_ERROR_CODES = {
  '请先打开视频。': 'open-video-first',
  '请先载入视频。': 'load-video-first',
  '该片源已在视图中，不能重复添加。': 'duplicate-source',
  '所有轨道均已停用，请重新载入片源。': 'all-tracks-disabled',
  '请等待当前操作完成后再播放。': 'wait-operation-before-play',
  '请先完成画面定位。': 'finish-seek-first',
  '请暂停并等待画面定位完成后再标注。': 'pause-before-mark',
  '当前轨道尚未同步，请等待追赶完成或定位后再标注。': 'track-not-synced-for-mark',
  '当前轨道没有可标注的有效画面，请重新载入停用的片源。': 'no-valid-frame-for-mark',
  '请暂停并等待画面定位完成后再编辑标注。': 'pause-before-edit-mark',
  '请返回标注对应的画面后再编辑。': 'return-to-mark-frame',
  '请等待色彩模式切换完成。': 'wait-color-mode',
  '正在切换色彩模式。': 'changing-color-mode',
  '请选择非空的视频文件。': 'empty-video-file',
} as const;

export type UserErrorCode = (typeof USER_ERROR_CODES)[keyof typeof USER_ERROR_CODES];

export function classifyUserError(raw: string): UserErrorCode | undefined {
  return (USER_ERROR_CODES as Record<string, UserErrorCode | undefined>)[raw];
}
