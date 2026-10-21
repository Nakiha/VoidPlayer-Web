// A response event only means headers arrived. Aborted fetches can emit it too,
// and Chromium cannot provide their body even when json() is called immediately.
// Read completed transports only; keep cancellations, other failures and pending
// requests explicit so the scenario can enforce its terminal/cache contract.
export function recordStatusEvidence(page, matches) {
  const requests = new Map(), bodies = [];
  const request = value => {
    if (!matches(value)) return;
    requests.set(value, { url: value.url(), state: 'pending' });
  };
  const finished = value => {
    const row = requests.get(value); if (!row) return;
    row.state = 'finished';
    bodies.push(Promise.resolve().then(async () => {
      const response = await value.response();
      if (!response) throw Error('Completed status request has no response');
      row.status = response.status(); row.body = await response.json();
    }).catch(error => { row.bodyError = error.message; }));
  };
  const failed = value => {
    const row = requests.get(value); if (!row) return;
    row.state = 'failed'; row.failure = value.failure()?.errorText ?? 'Unknown transport failure';
  };
  page.on('request', request); page.on('requestfinished', finished); page.on('requestfailed', failed);
  return {
    async snapshot() { await Promise.all(bodies); return structuredClone([...requests.values()]); },
    dispose() { page.off('request', request); page.off('requestfinished', finished); page.off('requestfailed', failed); },
  };
}
