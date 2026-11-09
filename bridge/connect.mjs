import net from 'node:net';

// All candidates have already passed the DNS policy. This lookup is a pinned
// snapshot: Node's family/address selection must never resolve the name again.
export function connectPinned(addresses, port, { allowHalfOpen = false } = {}) {
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(address=>!net.isIP(address))) throw new Error('Invalid resolved addresses');
  const socket = net.createConnection({
    host: 'validated.invalid', port, autoSelectFamily: true, allowHalfOpen,
    lookup(_host, options, callback) {
      const rows=addresses.map(address=>({address,family:net.isIP(address)}));
      if (options.all) callback(null, rows);
      else callback(null, rows[0].address, rows[0].family);
    }
  });
  // Disable Nagle for small TLS handshake records; keep the pinned lookup.
  socket.setNoDelay(true);
  return socket;
}
