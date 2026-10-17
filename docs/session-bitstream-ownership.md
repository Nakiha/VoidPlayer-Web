# Session bitstream analysis ownership

`ReviewSession` remains the single UI/Agent facade. `src/session/bitstream-analysis.ts` owns the existing bitstream task bookkeeping; it receives only an opaque track instance, generation and availability snapshot, an invalidation subscription and a state-change notification. It receives no mutable Session, track, source or decoded frame.

| Owner | Responsibility |
| --- | --- |
| Coordinator | Admission pool and concurrency, shared lazy service/cache, per-slot task/controller/service/state, last task slot, completed-stream records, cancellation and task finalizers |
| Session | Track/source lifetime, slot/input validation, real presented-frame tokens, source-version/time mapping, frame-change/playback checks before picture requests, source identity check before committing whole-stream completion |
| Session color transaction | Prepare/reconfigure, draw, commit, rollback and rollback-error reporting; unchanged by this extraction |
| Analysis service | Independent analysis reader/Worker, stream ACK/progress, result cache, terminal state; unchanged by this extraction |

The coordinator compares opaque source-instance identity and availability on the existing Session subscription. Removal, replacement or failure aborts that task; the task owns removing its subscription, external abort listener and releasing its pool permit. Queued cancellation, draining limits and error categories retain their previous behavior. Explicit per-slot state and completed coverage remain generation checked; the unspecified-slot diagnostic continues to expose the last task's failure even after its source is removed.

Session permits only cache/query operations through the coordinator's `queries` interface. Picture/range/stream request closures stay in Session so they continue to use its exact source and actual presented identity. Completion writes remain behind Session's source-instance check. No frames cross the new boundary and it cannot seek, draw, close a source or alter the color transaction.

Verification uses the existing Session, bitstream, color rollback, decode cancellation and failure-diagnostic cases. The two cache-eviction fixture accesses follow the new internal owner; their assertions are unchanged. Actual Worker result handling, task admission/cancellation/replacement, completed-stream retention through eviction and picture errors, presented identity and per-track rollback are exercised. This extraction does not add a common Worker framework or change transport, decoder routing, concurrency limits or stream messages. Broader Worker failure cleanup and lifecycle fixes remain separate #64 work.
