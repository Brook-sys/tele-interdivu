import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProxiedConnection } from './tunnel';

describe('createProxiedConnection', () => {
  let echoServer: net.Server;
  let echoPort: number;

  let httpProxyServer: net.Server;
  let httpProxyPort: number;

  let socks5Server: net.Server;
  let socks5Port: number;

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
  });

  afterAll(async () => {
    echoServer.close();
    httpProxyServer.close();
    socks5Server.close();
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
});
