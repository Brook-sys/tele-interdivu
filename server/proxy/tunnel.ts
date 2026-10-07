import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';

export interface ProxiedConnectionOptions {
  targetHost: string;
  targetPort: number;
  proxyUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;

// Formats host:port with brackets for IPv6 literals (valid in HTTP CONNECT,
// Host headers and URLs)
export function formatHostPort(host: string, port: number): string {
  const bare = host.replace(/^\[|\]$/g, '');
  return net.isIPv6(bare) ? `[${bare}]:${port}` : `${host}:${port}`;
}

// Returns a human-readable problem with a proxy URL so misconfiguration
// surfaces at boot. Returns `undefined` when the value is usable. Credentials
// belong before the host (`http://user:pass@host:port`); anything else fails
// URL parsing and would otherwise surface only as endless relay retries
export function getProxyUrlFormatError(proxyUrl?: string): string | undefined {
  if (!proxyUrl) return undefined;

  try {
    const parsed = new URL(proxyUrl);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'socks5:' && protocol !== 'socks5h:') {
      return `unsupported protocol "${protocol}" — supported: http://, https://, socks5://, socks5h://`;
    }
    return undefined;
  } catch {
    return 'invalid URL — credentials must come before the host, e.g. http://user:pass@host:port';
  }
}

// Parses an IPv6 literal into 16 bytes (expands "::" shorthand)
function ipv6ToBuffer(host: string): Buffer {
  const bare = host.replace(/^\[|\]$/g, '');
  const sections = bare.split('::');

  if (sections.length > 2) {
    throw new Error(`Invalid IPv6 address: ${host}`);
  }

  const parseGroups = (part: string) => (part === '' ? [] : part.split(':'));

  const head = parseGroups(sections[0]);
  const tail = sections.length === 2 ? parseGroups(sections[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) {
    throw new Error(`Invalid IPv6 address: ${host}`);
  }

  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  const buf = Buffer.alloc(16);
  groups.forEach((group, i) => {
    const value = parseInt(group, 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff) {
      throw new Error(`Invalid IPv6 address: ${host}`);
    }
    buf.writeUInt16BE(value, i * 2);
  });
  return buf;
}

export async function createProxiedConnection(options: ProxiedConnectionOptions): Promise<net.Socket | tls.TLSSocket> {
  const {
    targetHost,
    targetPort,
    proxyUrl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  if (!proxyUrl) {
    return connectDirect(targetHost, targetPort, timeoutMs);
  }

  const parsed = new URL(proxyUrl);
  const protocol = parsed.protocol.toLowerCase();

  if (protocol === 'socks5:' || protocol === 'socks5h:') {
    return connectSocks5(parsed, targetHost, targetPort, timeoutMs);
  }

  if (protocol === 'http:' || protocol === 'https:') {
    return connectHttpConnect(parsed, targetHost, targetPort, timeoutMs);
  }

  throw new Error(`Unsupported proxy protocol: ${parsed.protocol}. Supported: socks5://, http://`);
}

function connectDirect(targetHost: string, targetPort: number, timeoutMs: number): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const cleanup = () => {
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
    };

    const onError = (err: Error) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(err);
      }
    };

    const onTimeout = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        socket.destroy();
        reject(new Error(`Connection timeout to ${targetHost}:${targetPort}`));
      }
    };

    const isTls = targetPort === 443;
    const socket = isTls
      ? tls.connect({
        host: targetHost,
        port: targetPort,
        servername: targetHost,
        rejectUnauthorized: false,
      }, () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(socket);
        }
      })
      : net.connect({
        host: targetHost,
        port: targetPort,
      }, () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(socket);
        }
      });

    socket.setTimeout(timeoutMs);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

function connectSocks5(
  proxyUrl: URL,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxyUrl.port) || 1080;
    // URL#hostname keeps brackets on IPv6 literals ("[::1]"); net.connect wants the bare form
    const proxyHost = proxyUrl.hostname.replace(/^\[|\]$/g, '');
    const username = proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined;
    const password = proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined;

    let stage: 'greeting' | 'auth' | 'connect' | 'done' = 'greeting';
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    socket.setTimeout(timeoutMs);

    const fail = (err: Error) => {
      socket.destroy();
      reject(new Error(`[Proxy FAIL-CLOSED] SOCKS5 connection to ${targetHost}:${targetPort} failed: ${err.message}`));
    };

    socket.once('timeout', () => fail(new Error('SOCKS5 proxy connection timed out')));
    socket.once('error', fail);

    socket.on('connect', () => {
      // SOCKS5 Greeting: [VER=5, NMETHODS, METHODS...]
      if (username !== undefined && password !== undefined) {
        socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      } else {
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      }
    });

    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer | string) => {
      const bufChunk = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      buffer = Buffer.concat([buffer, bufChunk]);

      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        const ver = buffer[0];
        const method = buffer[1];
        buffer = buffer.subarray(2);

        if (ver !== 0x05) {
          fail(new Error(`Invalid SOCKS version: ${ver}`));
          return;
        }

        if (method === 0x00) {
          // No auth needed, proceed to connect
          sendConnectRequest();
        } else if (method === 0x02 && username !== undefined && password !== undefined) {
          // User/Password auth (RFC 1929)
          stage = 'auth';
          const uBuf = Buffer.from(username);
          const pBuf = Buffer.from(password);
          const authReq = Buffer.concat([
            Buffer.from([0x01, uBuf.length]),
            uBuf,
            Buffer.from([pBuf.length]),
            pBuf,
          ]);
          socket.write(authReq);
        } else {
          fail(new Error(`SOCKS5 proxy rejected authentication methods (method: ${method})`));
        }
        return;
      }

      if (stage === 'auth') {
        if (buffer.length < 2) return;
        const status = buffer[1];
        buffer = buffer.subarray(2);

        if (status !== 0x00) {
          fail(new Error(`SOCKS5 authentication failed (status: ${status})`));
          return;
        }

        sendConnectRequest();
        return;
      }

      if (stage === 'connect') {
        if (buffer.length < 4) return;
        const rep = buffer[1];
        const atyp = buffer[3];

        let minLen = 4;
        if (atyp === 0x01) minLen += 4 + 2; // IPv4 + port
        else if (atyp === 0x03) minLen += 1 + (buffer[4] || 0) + 2; // Domain + port
        else if (atyp === 0x04) minLen += 16 + 2; // IPv6 + port

        if (buffer.length < minLen) return;

        if (rep !== 0x00) {
          fail(new Error(`SOCKS5 connect request failed with response code ${rep}`));
          return;
        }

        stage = 'done';
        socket.removeAllListeners('data');
        socket.removeAllListeners('timeout');
        socket.removeAllListeners('error');

        // If extra bytes arrived, push back to socket stream
        const remaining = buffer.subarray(minLen);
        if (remaining.length > 0) {
          socket.unshift(remaining);
        }

        if (targetPort === 443) {
          const tlsSocket = tls.connect({
            socket,
            servername: targetHost,
            rejectUnauthorized: false,
          }, () => {
            resolve(tlsSocket);
          });
          tlsSocket.once('error', (err) => {
            fail(new Error(`TLS handshake through SOCKS5 failed: ${err.message}`));
          });
        } else {
          resolve(socket);
        }
      }
    });

    function sendConnectRequest() {
      stage = 'connect';
      const isIpv4 = net.isIPv4(targetHost);
      const isIpv6 = net.isIPv6(targetHost);
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(targetPort, 0);

      if (isIpv4) {
        const ipParts = targetHost.split('.').map(Number);
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x01]),
          Buffer.from(ipParts),
          portBuf,
        ]);
        socket.write(req);
      } else if (isIpv6) {
        const addressBuf = ipv6ToBuffer(targetHost);
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x04]),
          addressBuf,
          portBuf,
        ]);
        socket.write(req);
      } else {
        const domainBuf = Buffer.from(targetHost);
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, domainBuf.length]),
          domainBuf,
          portBuf,
        ]);
        socket.write(req);
      }
    }
  });
}

function connectHttpConnect(
  proxyUrl: URL,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxyUrl.port) || 8080;
    // URL#hostname keeps brackets on IPv6 literals ("[::1]"); net.connect wants the bare form
    const proxyHost = proxyUrl.hostname.replace(/^\[|\]$/g, '');
    const decodedUser = proxyUrl.username ? decodeURIComponent(proxyUrl.username) : '';
    const decodedPass = proxyUrl.password ? decodeURIComponent(proxyUrl.password) : '';
    const auth = proxyUrl.username
      ? `Basic ${Buffer.from(`${decodedUser}:${decodedPass}`).toString('base64')}`
      : undefined;

    const socket = net.connect({ host: proxyHost, port: proxyPort });
    socket.setTimeout(timeoutMs);

    const fail = (err: Error) => {
      socket.destroy();
      reject(new Error(`[Proxy FAIL-CLOSED] HTTP CONNECT to ${targetHost}:${targetPort} failed: ${err.message}`));
    };

    socket.once('timeout', () => fail(new Error('HTTP proxy connection timed out')));
    socket.once('error', fail);

    socket.on('connect', () => {
      const hostPort = formatHostPort(targetHost, targetPort);
      let req = `CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n`;
      if (auth) {
        req += `Proxy-Authorization: ${auth}\r\n`;
      }
      req += '\r\n';
      socket.write(req);
    });

    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const firstLine = buffer.slice(0, buffer.indexOf('\r\n'));
      const match = firstLine.match(/^HTTP\/1\.[01]\s+(\d{3})/i);
      const statusCode = match ? Number(match[1]) : 0;

      if (statusCode !== 200) {
        fail(new Error(`HTTP proxy returned non-200 status: ${firstLine}`));
        return;
      }

      socket.removeAllListeners('data');
      socket.removeAllListeners('timeout');
      socket.removeAllListeners('error');

      const remainingBytes = Buffer.from(buffer.slice(headerEnd + 4), 'latin1');
      if (remainingBytes.length > 0) {
        socket.unshift(remainingBytes);
      }

      if (targetPort === 443) {
        const tlsSocket = tls.connect({
          socket,
          servername: targetHost,
          rejectUnauthorized: false,
        }, () => {
          resolve(tlsSocket);
        });
        tlsSocket.once('error', (err) => {
          fail(new Error(`TLS handshake through HTTP proxy failed: ${err.message}`));
        });
      } else {
        resolve(socket);
      }
    });
  });
}
