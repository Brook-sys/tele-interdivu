import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProxiedConnection, formatHostPort } from './tunnel';

describe('createProxiedConnection', () => {
  let echoServer: net.Server;
  let echoPort: number;

  let httpProxyServer: net.Server;
  let httpProxyPort: number;

  let socks5Server: net.Server;
  let socks5Port: number;

  let echoServerV6: net.Server;
  let echoV6Port: number;

  let socks5V6Server: net.Server;
  let socks5V6Port: number;
  let lastSocks5Target: Buffer | undefined;

  let httpV6ProxyServer: net.Server;
  let httpV6ProxyPort: number;
  let lastConnectLine = '';

  beforeAll(async () => {
    // 1. Plain echo server acting as the target host
    echoServer = net.createServer((socket) => {
      socket.pipe(socket);
    });
    await new Promise<void>((resolve) => {
      echoServer.listen(0, '127.0.0.1', () => {
        echoPort = (echoServer.address() as net.AddressInfo).port;
        resolve();
      });
    });

    // 2. Mock HTTP CONNECT Proxy (requires auth user:pass)
    httpProxyServer = net.createServer((clientSocket) => {
      let buffer = '';
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.includes('\r\n\r\n')) {
          clientSocket.removeListener('data', onData);
          const authExpected = `Basic ${Buffer.from('testuser:testpass').toString('base64')}`;
          if (buffer.includes(`Proxy-Authorization: ${authExpected}`)) {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            const targetSocket = net.connect({ host: '127.0.0.1', port: echoPort });
            clientSocket.pipe(targetSocket).pipe(clientSocket);
          } else {
            clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
            clientSocket.destroy();
          }
        }
      };
      clientSocket.on('data', onData);
    });
    await new Promise<void>((resolve) => {
      httpProxyServer.listen(0, '127.0.0.1', () => {
        httpProxyPort = (httpProxyServer.address() as net.AddressInfo).port;
        resolve();
      });
    });

    // 3. Mock SOCKS5 Proxy with User/Pass authentication
    socks5Server = net.createServer((socket) => {
      let stage = 0;
      socket.on('data', (rawChunk) => {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        if (stage === 0) {
          // Greeting
          expect(chunk[0]).toBe(0x05);
          socket.write(Buffer.from([0x05, 0x02])); // Select User/Pass auth
          stage = 1;
        } else if (stage === 1) {
          // Auth: [0x01, ulen, ...u, plen, ...p]
          const ulen = Number(chunk[1]);
          const username = chunk.subarray(2, 2 + ulen).toString();
          const plen = Number(chunk[2 + ulen]);
          const password = chunk.subarray(3 + ulen, 3 + ulen + plen).toString();

          if (username === 'myuser' && password === 'mypass') {
            socket.write(Buffer.from([0x01, 0x00])); // Auth success
            stage = 2;
          } else {
            socket.write(Buffer.from([0x01, 0x01])); // Auth fail
            socket.destroy();
          }
        } else if (stage === 2) {
          // Connect request
          expect(chunk[0]).toBe(0x05);
          expect(chunk[1]).toBe(0x01); // CONNECT
          // Reply success
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]));
          const target = net.connect({ host: '127.0.0.1', port: echoPort });
          socket.pipe(target).pipe(socket);
          stage = 3;
        }
      });
    });
    await new Promise<void>((resolve) => {
      socks5Server.listen(0, '127.0.0.1', () => {
        socks5Port = (socks5Server.address() as net.AddressInfo).port;
        resolve();
      });
    });

    // 4. IPv6 echo server on [::1]
    echoServerV6 = net.createServer((socket) => {
      socket.pipe(socket);
    });
    await new Promise<void>((resolve) => {
      echoServerV6.listen(0, '::1', () => {
        echoV6Port = (echoServerV6.address() as net.AddressInfo).port;
        resolve();
      });
    });

    // 5. SOCKS5 proxy reachable over IPv6 ([::1]) that accepts IPv6 targets
    socks5V6Server = net.createServer((socket) => {
      let stage = 0;
      socket.on('data', (rawChunk) => {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        if (stage === 0) {
          socket.write(Buffer.from([0x05, 0x00])); // no auth
          stage = 1;
        } else if (stage === 1) {
          // Connect request: must carry ATYP 0x04 + 16-byte address for ::1
          expect(chunk[0]).toBe(0x05);
          expect(chunk[3]).toBe(0x04);
          lastSocks5Target = chunk.subarray(4, 20);
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x04, ...Buffer.alloc(16), 0, 80]));
          const target = net.connect({ host: '::1', port: echoV6Port });
          socket.pipe(target).pipe(socket);
          stage = 2;
        }
      });
    });
    await new Promise<void>((resolve) => {
      socks5V6Server.listen(0, '::1', () => {
        socks5V6Port = (socks5V6Server.address() as net.AddressInfo).port;
        resolve();
      });
    });

    // 6. HTTP CONNECT proxy that verifies bracketed IPv6 in the request line
    httpV6ProxyServer = net.createServer((clientSocket) => {
      let buffer = '';
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.includes('\r\n\r\n')) {
          clientSocket.removeListener('data', onData);
          const requestLine = buffer.slice(0, buffer.indexOf('\r\n'));
          lastConnectLine = requestLine;
          if (requestLine.startsWith('CONNECT [::1]:')) {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            const targetSocket = net.connect({ host: '::1', port: echoV6Port });
            clientSocket.pipe(targetSocket).pipe(clientSocket);
          } else {
            clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            clientSocket.destroy();
          }
        }
      };
      clientSocket.on('data', onData);
    });
    await new Promise<void>((resolve) => {
      httpV6ProxyServer.listen(0, '::1', () => {
        httpV6ProxyPort = (httpV6ProxyServer.address() as net.AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    echoServer.close();
    httpProxyServer.close();
    socks5Server.close();
    echoServerV6.close();
    socks5V6Server.close();
    httpV6ProxyServer.close();
  });

  it('connects directly when no proxy is configured', async () => {
    const socket = await createProxiedConnection({
      targetHost: '127.0.0.1',
      targetPort: echoPort,
    });

    const received = await new Promise<string>((resolve) => {
      socket.once('data', (chunk) => resolve(chunk.toString()));
      socket.write('ping');
    });

    expect(received).toBe('ping');
    socket.destroy();
  });

  it('connects through authenticated HTTP CONNECT proxy', async () => {
    const socket = await createProxiedConnection({
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      proxyUrl: `http://testuser:testpass@127.0.0.1:${httpProxyPort}`,
    });

    const received = await new Promise<string>((resolve) => {
      socket.once('data', (chunk) => resolve(chunk.toString()));
      socket.write('hello-http-proxy');
    });

    expect(received).toBe('hello-http-proxy');
    socket.destroy();
  });

  it('connects through authenticated SOCKS5 proxy', async () => {
    const socket = await createProxiedConnection({
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      proxyUrl: `socks5://myuser:mypass@127.0.0.1:${socks5Port}`,
    });

    const received = await new Promise<string>((resolve) => {
      socket.once('data', (chunk) => resolve(chunk.toString()));
      socket.write('hello-socks5-proxy');
    });

    expect(received).toBe('hello-socks5-proxy');
    socket.destroy();
  });

  it('fails closed when proxy authentication is invalid', async () => {
    await expect(createProxiedConnection({
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      proxyUrl: `http://wronguser:wrongpass@127.0.0.1:${httpProxyPort}`,
    })).rejects.toThrow('FAIL-CLOSED');
  });

  it('fails closed when proxy host is unreachable', async () => {
    // Unused port on localhost
    await expect(createProxiedConnection({
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      proxyUrl: 'socks5://127.0.0.1:49999',
      timeoutMs: 1000,
    })).rejects.toThrow('FAIL-CLOSED');
  });

  it('connects to an IPv6 proxy host with an IPv6 target via SOCKS5 (ATYP 0x04)', async () => {
    const socket = await createProxiedConnection({
      targetHost: '::1',
      targetPort: echoV6Port,
      proxyUrl: `socks5://[::1]:${socks5V6Port}`,
      timeoutMs: 5000,
    });

    const received = await new Promise<string>((resolve) => {
      socket.once('data', (chunk) => resolve(chunk.toString()));
      socket.write('hello-ipv6-socks5');
    });

    expect(received).toBe('hello-ipv6-socks5');
    expect(lastSocks5Target).toBeDefined();
    expect([...lastSocks5Target!]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    socket.destroy();
  });

  it('sends a bracketed IPv6 target in HTTP CONNECT to an IPv6 proxy host', async () => {
    const socket = await createProxiedConnection({
      targetHost: '::1',
      targetPort: echoV6Port,
      proxyUrl: `http://[::1]:${httpV6ProxyPort}`,
      timeoutMs: 5000,
    });

    const received = await new Promise<string>((resolve) => {
      socket.once('data', (chunk) => resolve(chunk.toString()));
      socket.write('hello-ipv6-connect');
    });

    expect(received).toBe('hello-ipv6-connect');
    expect(lastConnectLine).toContain('CONNECT [::1]:');
    socket.destroy();
  });

  it('formats host:port with brackets only for IPv6 literals', () => {
    expect(formatHostPort('1.2.3.4', 443)).toBe('1.2.3.4:443');
    expect(formatHostPort('2001:db8::1', 443)).toBe('[2001:db8::1]:443');
    expect(formatHostPort('[::1]', 80)).toBe('[::1]:80');
    expect(formatHostPort('example.com', 443)).toBe('example.com:443');
  });
});
