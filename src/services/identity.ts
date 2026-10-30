export type Actor = { id: string; name: string; kind?: "named" | "guest" };
type Health = {
  service: string;
  actor: Actor | null;
  capabilities?: {
    admin?: boolean;
    workspaces?: boolean;
    annotations?: boolean;
    reveal?: boolean;
  };
};
let actor: Actor | null = null;
let pending: Promise<Health> | undefined;
let queue: Promise<unknown> = Promise.resolve();
export const currentActor = () => actor;
function remember(next: Actor | null) {
  if (actor?.id === next?.id && actor?.name === next?.name) return;
  const previous = actor;
  actor = next;
  try {
    localStorage.setItem("voidplayer.identity", JSON.stringify(actor));
  } catch {}
  window.dispatchEvent(
    new CustomEvent("voidplayer-identity-change", {
      detail: { actor, previous },
    }),
  );
}
function serialize<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(run);
  queue = result.catch(() => {});
  return result;
}
export function identityHealth(
  options: { fresh?: boolean } = {},
): Promise<Health> {
  const read = () =>
    serialize(async () => {
      const response = await fetch("/api/health", {
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      });
      const health = (await response.json()) as Health;
      if (!response.ok || health.service !== "voidplayer-media")
        throw new Error("媒体服务未连接。");
      remember(health.actor);
      return health;
    });
  return options.fresh
    ? read()
    : (pending ??= read().finally(() => {
        pending = undefined;
      }));
}

// Notifications are hints to read the cookie-backed service identity. A single
// confirmation epoch fences all admin observers, even if /health remembers the
// same actor and therefore emits no legacy identity-change event.
let uncertain = false,
  scopeRevision = 0,
  scopeUsers = 0;
const scopeEvent = "voidplayer-identity-scope";
export const confirmedActor = () => (uncertain ? null : actor);
type IdentityScope = {
  invalidated(): void;
  confirmed?(): void;
  failed?(error: unknown): void;
};
const publishScope = (
  state: "invalidated" | "confirmed" | "failed",
  error?: unknown,
) =>
  window.dispatchEvent(
    new CustomEvent(scopeEvent, { detail: { state, error } }),
  );
function confirmScope() {
  const ticket = ++scopeRevision;
  uncertain = true;
  publishScope("invalidated");
  // Queue a new read after any older health/identity operation, never reuse a
  // response captured before this notification. Only the newest epoch publishes.
  void identityHealth({ fresh: true }).then(
    () => {
      if (ticket === scopeRevision) {
        uncertain = false;
        publishScope("confirmed");
      }
    },
    (error) => {
      if (ticket === scopeRevision) publishScope("failed", error);
    },
  );
}
const scopeStorage = (event: StorageEvent) => {
  if (event.key === "voidplayer.identity" || event.key === null) confirmScope();
};
const scopeChanged = () => {
  if (uncertain) return;
  uncertain = true;
  publishScope("invalidated");
  uncertain = false;
  publishScope("confirmed");
};
const scopeFocus = () => {
  if (uncertain) confirmScope();
  else void identityHealth().catch(() => {});
};
export function observeIdentity(signal: AbortSignal, handlers: IdentityScope) {
  if (signal.aborted) return;
  window.addEventListener(
    scopeEvent,
    (event) => {
      const { state, error } = (event as CustomEvent).detail;
      if (state === "invalidated") handlers.invalidated();
      else if (state === "confirmed") handlers.confirmed?.();
      else handlers.failed?.(error);
    },
    { signal },
  );
  if (scopeUsers++ === 0) {
    window.addEventListener("storage", scopeStorage);
    window.addEventListener("voidplayer-identity-change", scopeChanged);
    window.addEventListener("focus", scopeFocus);
    if (uncertain) confirmScope();
  }
  signal.addEventListener(
    "abort",
    () => {
      if (--scopeUsers === 0) {
        window.removeEventListener("storage", scopeStorage);
        window.removeEventListener("voidplayer-identity-change", scopeChanged);
        window.removeEventListener("focus", scopeFocus);
      }
    },
    { once: true },
  );
}
export function chooseIdentity(
  input:
    | { name: string; mode?: "rename" | "create" }
    | { id: string }
    | { guest: true },
): Promise<Actor> {
  return serialize(async () => {
    const response = await fetch("/api/identity", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-voidplayer-action": "identity",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "用户名设置失败。");
    remember(result.actor);
    if (uncertain) {
      scopeRevision++;
      uncertain = false;
      publishScope("confirmed");
    }
    return result.actor;
  });
}
