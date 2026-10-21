// Diagnostic only: observes the reader the application itself consumes. It
// neither clones a Response nor makes another request or reads another stream.
export function installStatusReadProbe() {
  const originalFetch = window.fetch.bind(window);
  window.__statusReads = [];
  window.fetch = async function(input, options) {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    const method = options?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method !== 'GET' || !/bitstream-analysis\/requests\//.test(url.pathname) || url.searchParams.get('pack') !== 'gop') return originalFetch(input, options);
    const row = { url: url.href, start: performance.now(), events: [] };
    window.__statusReads.push(row);
    const signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.addEventListener('abort', () => { row.abort = { at: performance.now(), afterEOF: !!row.eof, reason: String(signal.reason) }; }, { once: true });
    const response = await originalFetch(input, options);
    row.headersAt = performance.now(); row.status = response.status;
    const getReader = response.body.getReader.bind(response.body);
    response.body.getReader = function(...args) {
      const reader = getReader(...args), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader), release = reader.releaseLock.bind(reader);
      const decoder = new TextDecoder(); let text = '';
      reader.read = async function() {
        try {
          const value = await read();
          if (value.done) {
            row.eof = true; row.eofAt = performance.now(); text += decoder.decode();
            try {
              const body = JSON.parse(text);
              row.body = { state: body.state, published: body.published, counters: body.counters,
                chunks: body.chunks.map(chunk => ({ cursor: chunk.cursor, startCursor: chunk.startCursor, cached: chunk.cached,
                  au: chunk.cachedGop?.map(summary => summary.picture.au) })) };
            } catch (error) { row.parseError = error.message; }
          } else text += decoder.decode(value.value, { stream: true });
          return value;
        } catch (error) { row.readError = { message: error.message, name: error.name }; throw error; }
      };
      reader.cancel = function(reason) {
        row.events.push({ operation: 'cancel', afterEOF: !!row.eof, at: performance.now(), reason: String(reason) });
        return cancel(reason);
      };
      reader.releaseLock = function() { row.events.push({ operation: 'releaseLock', afterEOF: !!row.eof, at: performance.now() }); return release(); };
      return reader;
    };
    return response;
  };
}
