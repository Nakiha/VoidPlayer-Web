// A response event only means headers arrived. Aborted fetches can emit it too,
// and Chromium cannot provide their body even when json() is called immediately.
// Keep transport metadata for diagnosis; CDP can report a successfully consumed
// fetch body as ERR_ABORTED on Linux Chromium, so it cannot define coverage.
export function recordStatusEvidence(page, matches) {
  const requests = new Map(), metadata = [];
  const request = value => {
    if (!matches(value)) return;
    requests.set(value, { url: value.url(), state: 'pending' });
  };
  const finished = value => {
    const row = requests.get(value); if (!row) return;
    row.state = 'finished';
    metadata.push(Promise.resolve().then(async () => {
      const response = await value.response();
      if (!response) throw Error('Completed status request has no response');
      row.status = response.status();
    }).catch(error => { row.metadataError = error.message; }));
  };
  const failed = value => {
    const row = requests.get(value); if (!row) return;
    row.state = 'failed'; row.failure = value.failure()?.errorText ?? 'Unknown transport failure';
  };
  page.on('request', request); page.on('requestfinished', finished); page.on('requestfailed', failed);
  return {
    async snapshot() { await Promise.all(metadata); return structuredClone([...requests.values()]); },
    dispose() { page.off('request', request); page.off('requestfinished', finished); page.off('requestfailed', failed); },
  };
}

// Install before the fresh page starts. Observe the very reader used by the
// application, without cloning responses, adding reads or re-fetching statuses.
// The observer returns the original Response, reader and read results unchanged.
export function installStatusReadEvidence(host = window) {
  const fetch = host.fetch.bind(host), reads = host.__vpStatusReads = [];
  host.fetch = async function(input, options) {
    const url = new URL(input instanceof Request ? input.url : input, host.location.href);
    const method = String(options?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET' || !/bitstream-analysis\/requests\//.test(url.pathname) || url.searchParams.get('pack') !== 'gop') return fetch(input, options);
    const signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
    const row = { url: url.href, state: 'pending', bytes: 0, signalAborted: !!signal?.aborted };
    reads.push(row);
    signal?.addEventListener('abort', () => { row.signalAborted = true; }, { once: true });
    let response;
    try { response = await fetch(input, options); }
    catch (error) { row.state = signal?.aborted ? 'cancelled' : 'failed'; row.error = error.message; throw error; }
    row.status = response.status;
    if (!response.body) { row.state = 'failed'; row.error = 'Missing status body'; return response; }
    const getReader = response.body.getReader.bind(response.body);
    response.body.getReader = function(...args) {
      const reader = getReader(...args), read = reader.read.bind(reader), decoder = new TextDecoder();
      let text = '';
      reader.read = async function() {
        let value;
        try { value = await read(); }
        catch (error) { row.state = signal?.aborted ? 'cancelled' : 'failed'; row.error = error.message; throw error; }
        if (value.done) {
          row.state = 'complete';
          if (!row.bodyError) {
            try { row.body = JSON.parse(text + decoder.decode()); }
            catch (error) { row.bodyError = error.message; }
          }
          text = '';
        } else {
          row.bytes += value.value.byteLength;
          if (row.bytes > 9 * 1024 * 1024) { row.bodyError = 'Status evidence exceeds the transport budget'; text = ''; }
          else if (!row.bodyError) text += decoder.decode(value.value, { stream: true });
        }
        return value;
      };
      return reader;
    };
    return response;
  };
}
