/** Written by the service, consumed by maintenance tools. Never a disposable artifact. */
export const DATA_DIRECTORY_MARKER = '.voidplayer-user-data';
/** Legacy services predate the marker; their durable database names remain protected. */
export function persistentDataFile(name: string): boolean {
  return /^(?:library|workspaces|annotations)\.sqlite(?:[.-].*)?$/.test(name);
}
