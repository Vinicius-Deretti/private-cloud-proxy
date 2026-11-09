import { Duplex } from 'node:stream';

// Duplex over a tunnel WebSocket with optional TCP half-close propagation.
//
// Data always travels in binary frames. When both peers negotiated
// half-close (upgrade header X-Tunnel-Half-Close: 1, verdict halfClose:true),
// ending the writable side sends a single text frame EOF_FRAME instead of
// closing the WebSocket, so the opposite direction keeps flowing (TCP
// half-open). The WebSocket is closed (1000) only after EOF was both sent and
// received. A WebSocket close without a prior EOF is abrupt and surfaces as
// an error, so a truncated stream is never presented as a clean end.
//
// Legacy peers (no negotiation): `legacyFinal: 'close'` mirrors ws'
// createWebSocketStream (end => ws.close()); `legacyFinal: 'keep'` finishes
// the writable side locally without closing, so reading continues until the
// peer closes (the origin then never sees FIN, but responses are not cut).
export const HALF_CLOSE_HEADER = 'x-tunnel-half-close';
export const EOF_FRAME = '{"eof":true}';

export function createTunnelStream(ws, { halfClose = false, legacyFinal = 'close', highWaterMark } = {}) {
  let sentEof = false, peerEof = false, terminateOnDestroy = true;
  const duplex = new Duplex({ highWaterMark, autoDestroy: false, emitClose: false, objectMode: false });
  const protocolError = () => duplex.destroy(Object.assign(new Error('Tunnel protocol violation'), { failure: 'REMOTE_SOCKET_CLOSED' }));
  const maybeClose = () => { if (sentEof && peerEof && ws.readyState === ws.OPEN) ws.close(1000); };

  ws.on('message', (message, isBinary) => {
    if (duplex.destroyed) return;
    if (halfClose && !isBinary) {
      if (peerEof || message.toString() !== EOF_FRAME) return protocolError();
      peerEof = true; duplex.push(null); maybeClose(); return;
    }
    if (halfClose && peerEof) return protocolError();
    if (!duplex.push(message)) ws.pause();
  });
  ws.once('error', error => { if (duplex.destroyed) return; terminateOnDestroy = false; duplex.destroy(error); });
  ws.once('close', () => {
    if (duplex.destroyed) return;
    if (halfClose && !peerEof) {
      duplex.destroy(Object.assign(new Error('Tunnel closed before EOF'), { failure: 'REMOTE_SOCKET_CLOSED' }));
      return;
    }
    duplex.push(null);
  });

  duplex._read = () => { if (ws.isPaused) ws.resume(); };
  duplex._write = (chunk, _encoding, callback) => {
    if (ws.readyState !== ws.OPEN) return callback(new Error('Tunnel not open'));
    ws.send(chunk, { binary: true }, callback);
  };
  duplex._final = callback => {
    if (ws.readyState !== ws.OPEN) return callback();
    if (halfClose) {
      ws.send(EOF_FRAME, { binary: false }, error => { if (!error) { sentEof = true; maybeClose(); } callback(error); });
    } else if (legacyFinal === 'keep') {
      callback();
    } else {
      if (!ws._socket || ws._socket.writableFinished) { callback(); ws.close(); return; }
      ws._socket.once('finish', () => callback());
      ws.close();
    }
  };
  duplex._destroy = (error, callback) => {
    if (ws.readyState === ws.CLOSED) { callback(error); process.nextTick(() => duplex.emit('close')); return; }
    let called = false;
    ws.once('error', wsError => { called = true; callback(wsError); });
    ws.once('close', () => { if (!called) callback(error); process.nextTick(() => duplex.emit('close')); });
    // Errors abort immediately; a clean destroy closes gracefully (close frame).
    if (error && terminateOnDestroy) ws.terminate();
    else if (ws.readyState === ws.OPEN) ws.close(1000);
    else if (ws.readyState === ws.CONNECTING) ws.terminate();
  };
  duplex.on('end', () => { if (!duplex.destroyed && duplex.writableFinished) duplex.destroy(); });
  duplex.on('finish', () => { if (!duplex.destroyed && duplex.readableEnded) duplex.destroy(); });
  return duplex;
}
