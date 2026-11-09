// Concurrency limits for one user, shared by the local client and the relay so
// the two ends stay coherent. Tune here (or per instance via options).
//
//   RELAY_MAX_SESSIONS = POOL_MAX_TUNNELS + CLOSING_HEADROOM + CLIENT_MAX_SESSIONS
//
// - POOL_MAX_TUNNELS: reserved for optional pre-authenticated idle tunnels
//   (pool feature flag); kept free even while the pool is disabled.
// - CLOSING_HEADROOM: the client releases a slot as soon as its WebSocket
//   closes, while the relay may still be tearing that session down.
export const RELAY_MAX_SESSIONS = 32;
export const POOL_MAX_TUNNELS = 4;
export const CLOSING_HEADROOM = 2;
export const CLIENT_MAX_SESSIONS = RELAY_MAX_SESSIONS - POOL_MAX_TUNNELS - CLOSING_HEADROOM;
// Requests beyond CLIENT_MAX_SESSIONS wait in a bounded queue.
export const CLIENT_MAX_QUEUED = 32;
export const CLIENT_QUEUE_WAIT_MS = 20_000;
// Queue stall relief: only when every slot is busy, preempt the oldest tunnel
// that carried no data for this long (was 90 s).
export const CLIENT_IDLE_EVICT_MS = 30_000;
