import type { RuntimeLog } from './runtime.ts';

const sinks = new Set<RuntimeLog>();
export function attachRuntimeLog(sink: RuntimeLog) { sinks.add(sink); return () => { sinks.delete(sink); }; }
function errorValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (value instanceof Error) return { name: value.name, message: value.message.slice(0, 2000), stack: value.stack?.slice(0, 6000),
    ...(value.cause ? { cause: errorValue(value.cause, depth + 1) } : {}),
    ...(value instanceof AggregateError ? { errors: value.errors.slice(0, 8).map(error => errorValue(error, depth + 1)) } : {}) };
  return String(value).slice(0, 2000);
}
function emit(level: string, event: string, data: Record<string, unknown> = {}) {
  let record: Record<string, unknown> = { ...data, t: new Date().toISOString(), level, event };
  let line: string;
  try { line = JSON.stringify(record, (_key, value) => typeof value === 'bigint' ? String(value) : value) + '\n'; }
  catch {
    record = { t: record.t, level: 'warn', event: 'log-serialization-failed', originalEvent: event };
    line = JSON.stringify(record) + '\n';
  }
  // Normalize bigint and custom toJSON values before passing to the file sink.
  record = JSON.parse(line);
  for (const sink of sinks) sink.write(record);
  if (!sinks.size || process.env.VOIDPLAYER_SERVICE_STDIO !== '0') {
    const stream = level === 'error' ? process.stderr : process.stdout;
    if (stream.writableLength + Buffer.byteLength(line) <= 1024 ** 2) stream.write(line);
  }
}
export const serverLog = {
  info: (event: string, data?: Record<string, unknown>) => emit('info', event, data),
  warn: (event: string, data?: Record<string, unknown>) => emit('warn', event, data),
  error: (event: string, error: unknown, data?: Record<string, unknown>) => emit('error', event, { ...data, error: errorValue(error) }),
};
