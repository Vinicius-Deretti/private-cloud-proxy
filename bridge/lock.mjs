import fs from 'node:fs';
import crypto from 'node:crypto';

// Single-instance lock for the local client.
//
// process.kill(pid, 0) alone is not enough on Windows: after a crash the PID
// can be reused by an unrelated process (false "Client already active"), and
// EPERM means "exists but not ours". The owner therefore refreshes the lock's
// mtime every LOCK_HEARTBEAT_MS (a local file touch, no network traffic). A
// lock is honoured only if its PID is alive AND it was refreshed within
// LOCK_STALE_MS; otherwise it is stale and replaced. Release removes the file
// only when it still carries this process's nonce.
export const LOCK_HEARTBEAT_MS = 30_000;
export const LOCK_STALE_MS = 3 * LOCK_HEARTBEAT_MS;
// A lock whose content cannot be parsed may be mid-creation by a racing
// starter; it becomes stale after this short grace.
export const LOCK_UNREADABLE_GRACE_MS = 10_000;

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function inspect(file, { now, isAlive, staleMs }) {
  let stat, raw;
  try { stat = fs.statSync(file); raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { state: 'absent' }; throw error; }
  const age = now() - stat.mtimeMs;
  let pid;
  try {
    const parsed = JSON.parse(raw);
    pid = typeof parsed === 'number' ? parsed : parsed?.pid; // legacy locks held a bare PID
  } catch {}
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: age > LOCK_UNREADABLE_GRACE_MS ? 'stale' : 'active', reason: 'unreadable' };
  if (pid === process.pid) return { state: 'stale', reason: 'own-pid' };
  if (!isAlive(pid)) return { state: 'stale', reason: 'dead-pid' };
  if (age > staleMs) return { state: 'stale', reason: 'expired' }; // PID reused after a crash, or owner frozen
  return { state: 'active', pid };
}

export function acquireLock(file, { now = Date.now, isAlive = pidAlive, staleMs = LOCK_STALE_MS, heartbeatMs = LOCK_HEARTBEAT_MS } = {}) {
  const nonce = crypto.randomUUID();
  const content = () => JSON.stringify({ pid: process.pid, nonce, createdAt: new Date(now()).toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = inspect(file, { now, isAlive, staleMs });
    if (current.state === 'active') throw Object.assign(new Error('Client already active'), { code: 'LOCK_HELD' });
    if (current.state === 'stale') { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    try { fs.writeFileSync(file, content(), { flag: 'wx', mode: 0o600 }); break; }
    catch (error) { if (error.code !== 'EEXIST' || attempt === 1) throw Object.assign(error, { code: error.code === 'EEXIST' ? 'LOCK_HELD' : error.code }); }
  }
  const owned = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).nonce === nonce; } catch { return false; } };
  const timer = heartbeatMs > 0 ? setInterval(() => {
    try { if (owned()) { const t = new Date(now()); fs.utimesSync(file, t, t); } } catch {}
  }, heartbeatMs) : undefined;
  timer?.unref();
  let released = false;
  return {
    nonce,
    release() {
      if (released) return; released = true; clearInterval(timer);
      if (owned()) { try { fs.unlinkSync(file); } catch {} }
    }
  };
}
