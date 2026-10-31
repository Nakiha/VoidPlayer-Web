/** Whole-file memory cap for the WASM fallback (the file lives in MEMFS).
 * File-fed decoder admission owns this budget; it is independent of review state. */
export const MAX_FALLBACK_FILE_BYTES = 512 * 1024 * 1024;
