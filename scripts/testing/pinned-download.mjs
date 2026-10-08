import { createHash } from 'node:crypto';

class IntegrityError extends Error {}
class HttpError extends Error {
  constructor(file, status) { super(`${file}: HTTP ${status}`); this.status = status; }
}
const retryable = error => error instanceof HttpError
  ? error.status === 429 || error.status >= 500
  : !(error instanceof IntegrityError) && (error instanceof TypeError || error.name === 'TimeoutError' || /^(UND_ERR_|ECONNRESET|ETIMEDOUT)/.test(error.cause?.code ?? error.code ?? ''));

// Shared fixture acquisition helper, imported by the FATE preparation tool.
// Retry only transport/server availability failures. Pinned byte counts and
// hashes are mandatory on every attempt, and integrity failures stay fatal.
export async function downloadPinnedSample(sample, { fetchImpl = fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onRetry = message => console.warn(message), attempts = 3 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(sample.url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpError(sample.file, response.status);
      }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > sample.size) throw new IntegrityError(`${sample.file}: download exceeds pinned size`);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== sample.size || createHash('sha256').update(bytes).digest('hex') !== sample.sha256)
        throw new IntegrityError(`${sample.file}: checksum mismatch`);
      return bytes;
    } catch (error) {
      if (attempt === attempts || !retryable(error)) throw error;
      onRetry(`${sample.file}: transient download failure; retry ${attempt + 1}/${attempts}`);
      await wait(attempt * 1000);
    }
  }
  throw new Error('At least one download attempt is required');
}
