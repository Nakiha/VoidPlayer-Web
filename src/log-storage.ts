import { contextLog, log, sessionLog } from './log.ts';
import type { LogDocument, LogStorage } from './log.ts';

export const LOG_RETENTION = { sessions: 3, days: 7 };
export function retainLogs(documents: LogDocument[], current: LogDocument, now = Date.now()) {
  return [current, ...documents.filter(d => d.sessionId !== current.sessionId && Date.parse(d.updatedAt) >= now - LOG_RETENTION.days * 86400000)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, LOG_RETENTION.sessions - 1)];
}
export function indexedDBLogStorage(): LogStorage {
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('voidplayer-diagnostics', 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'sessionId' });
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('日志存储被其他页面阻塞。')); };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
  return {
    async save(document) {
      const db = await database;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('sessions', 'readwrite');
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('日志保存事务中断。'));
        const store = tx.objectStore('sessions');
        const read = store.getAll();
        read.onsuccess = () => {
          const existing = read.result as LogDocument[];
          const retained = new Set(retainLogs(existing, document).map(d => d.sessionId));
          for (const old of existing) if (!retained.has(old.sessionId)) store.delete(old.sessionId);
          store.put(document);
        };
      });
    },
    async list() {
      const db = await database;
      return new Promise<LogDocument[]>((resolve, reject) => {
        const request = db.transaction('sessions').objectStore('sessions').getAll();
        request.onsuccess = () => resolve(request.result.filter((d: LogDocument) => Date.parse(d.updatedAt) >= Date.now() - LOG_RETENTION.days * 86400000));
        request.onerror = () => reject(request.error);
      });
    },
  };
}
export function environmentInfo() {
  return {
    build: typeof __BUILD_INFO__ === 'undefined' ? 'test' : __BUILD_INFO__,
    userAgent: navigator.userAgent, language: navigator.language,
    secureContext: globalThis.isSecureContext, webCodecs: typeof VideoDecoder !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency, devicePixelRatio: globalThis.devicePixelRatio,
    colorGamut: matchMedia('(color-gamut: p3)').matches ? 'p3-or-better' : 'srgb',
    page: location.origin + location.pathname,
  };
}
export function startBrowserLogging() {
  const environment = environmentInfo();
  // Synchronous access denial becomes a recoverable storage failure, never an app crash.
  let storage: LogStorage;
  try { storage = indexedDBLogStorage(); }
  catch (error) { storage = { save: async () => { throw error; }, list: async () => { throw error; } }; }
  void sessionLog.attach(storage, environment);
  log.info('session', '会话启动', environment);
  const error = (event: ErrorEvent) => {
    log.error('error', '未捕获的异常', { error: event.error ?? event.message, source: event.filename.split(/[?#]/)[0], line: event.lineno });
    void sessionLog.flush();
  };
  const rejection = (event: PromiseRejectionEvent) => { contextLog().error('error', '未处理的 Promise 拒绝', { error: event.reason }); void sessionLog.flush(); };
  const visibility = () => { log.info('ui', '页面可见性变化', { state: document.visibilityState }); if (document.hidden) void sessionLog.flush(); };
  const pagehide = () => { log.info('session', '页面离开'); void sessionLog.flush(); };
  window.addEventListener('error', error); window.addEventListener('unhandledrejection', rejection);
  window.addEventListener('pagehide', pagehide); document.addEventListener('visibilitychange', visibility);
  return () => {
    window.removeEventListener('error', error); window.removeEventListener('unhandledrejection', rejection);
    window.removeEventListener('pagehide', pagehide); document.removeEventListener('visibilitychange', visibility);
    void sessionLog.dispose();
  };
}
