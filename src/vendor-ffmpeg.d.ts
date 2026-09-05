// @ffmpeg/core ships no TypeScript declarations.
declare module '@ffmpeg/core' {
  const createFFmpegCore: (options?: object) => Promise<unknown>;
  export default createFFmpegCore;
}
