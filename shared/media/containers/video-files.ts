// File pickers and the library advertise the same container extensions.
// Local files with missing or unusual extensions can also be recognized by their header.
export const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.ts', '.m2ts', '.mpg', '.mpeg', '.avi', '.flv', '.h264', '.avc', '.h265', '.hevc', '.h266', '.vvc'];
export const VIDEO_ACCEPT = ['video/*', ...VIDEO_EXTENSIONS].join(',');
