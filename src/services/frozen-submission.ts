import { ApiError } from "./api-error.ts";
import { randomUUID } from "../../shared/utils/uuid.ts";
import { canonicalJson } from "../../shared/analysis/quality/correspondence.ts";

export type FrozenSubmission<T> = {
  body: T;
  key: string;
  confirmed?: boolean;
  attempted?: boolean;
};
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type SubmissionCodec<T> = {
  read(value: unknown, owner: string): FrozenSubmission<T>;
  write(value: FrozenSubmission<T>, owner: string): unknown;
};
export function assertJobReceipt(
  value: unknown,
  owner: string,
  pending: FrozenSubmission<unknown>,
) {
  const r = value as {
    replayed?: unknown;
    job?: {
      id?: unknown;
      actor?: { id?: unknown };
      key?: unknown;
      input?: unknown;
      submitted?: { actorId?: unknown; idempotencyKey?: unknown };
    };
  };
  if (
    typeof r?.replayed !== "boolean" ||
    typeof r.job?.id !== "string" ||
    !r.job.id ||
    (r.job.actor?.id ?? r.job.submitted?.actorId) !== owner ||
    (r.job.key ?? r.job.submitted?.idempotencyKey) !== pending.key ||
    canonicalJson(r.job.input) !== canonicalJson(pending.body)
  )
    throw Error(
      "Incomplete submission acknowledgement; retain the original request",
    );
}
/** Owns acceptance uncertainty independently of any current view. Storage writes
 * precede POST; an old valid receipt may settle its own key after observation ends. */
export class FrozenSubmissionJournal<T> {
  private sending = new Map<string, Promise<unknown>>();
  constructor(
    privateStorage: StoragePort,
    key: (owner: string) => string,
    parse: (value: unknown) => T,
    codec?: SubmissionCodec<T>,
    uuid = randomUUID,
  ) {
    this.storage = privateStorage;
    this.key = key;
    this.parse = parse;
    this.codec = codec;
    this.uuid = uuid;
  }
  private storage: StoragePort;
  private key: (owner: string) => string;
  private parse: (value: unknown) => T;
  private codec?: SubmissionCodec<T>;
  private uuid: () => string;
  pending(owner: string): FrozenSubmission<T> | null {
    const raw = this.storage.getItem(this.key(owner));
    if (!raw) return null;
    const value = JSON.parse(raw),
      p = this.codec ? this.codec.read(value, owner) : value;
    if (
      !p ||
      typeof p.key !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(p.key)
    )
      throw Error("Stored submission key is invalid");
    return { ...p, body: this.parse(p.body) };
  }
  private save(owner: string, p: FrozenSubmission<T>) {
    this.storage.setItem(
      this.key(owner),
      JSON.stringify(this.codec ? this.codec.write(p, owner) : p),
    );
  }
  freeze(owner: string, body: T) {
    if (!owner) throw Error("Choose an identity before submitting");
    if (this.pending(owner))
      throw Error(
        "Resolve the original submission before creating another key",
      );
    const p = {
      body: this.parse(structuredClone(body)),
      key: this.uuid(),
      attempted: false,
    };
    this.save(owner, p);
    return p;
  }
  clearConfirmed(owner: string) {
    if (this.pending(owner)?.confirmed)
      this.storage.removeItem(this.key(owner));
  }
  execute<R>(
    owner: string,
    key: string,
    send: (p: FrozenSubmission<T>) => Promise<R>,
    validate: (value: R, p: FrozenSubmission<T>) => void,
    retainConfirmed = true,
  ): Promise<R> {
    const identity = this.key(owner) + "\0" + key,
      prior = this.sending.get(identity);
    if (prior) return prior as Promise<R>;
    const work = Promise.resolve().then(async () => {
      const p = this.pending(owner);
      if (!p || p.key !== key)
        throw Error("Original frozen submission is unavailable");
      // Legacy records without an attempt marker are uncertain, never presumed unsent.
      const previouslyAttempted = p.attempted !== false;
      this.save(owner, { ...p, attempted: true });
      let result: R;
      try {
        result = await send(structuredClone(p));
        validate(result, p);
      } catch (error) {
        if (
          !previouslyAttempted &&
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.code !== "idempotency-conflict"
        ) {
          if (this.pending(owner)?.key === key)
            this.storage.removeItem(this.key(owner));
        }
        throw error;
      }
      if (this.pending(owner)?.key === key) {
        if (retainConfirmed)
          this.save(owner, { ...p, attempted: true, confirmed: true });
        else this.storage.removeItem(this.key(owner));
      }
      return result;
    });
    this.sending.set(identity, work);
    void work
      .finally(() => {
        if (this.sending.get(identity) === work) this.sending.delete(identity);
      })
      .catch(() => {});
    return work;
  }
}
