/** Display a filename without changing the source name used by the session. */
export function fileBasename(name: string) {
  return name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1) || name;
}
