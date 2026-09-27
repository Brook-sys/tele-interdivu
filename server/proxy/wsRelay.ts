import type http from 'node:http';
import type stream from 'node:stream';
import { URL } from 'node:url';

import { createProxiedConnection } from './tunnel';

export function handleWsRelay(
  req: http.IncomingMessage,
  clientSocket: stream.Duplex,
  head: Buffer,
  proxyUrl?: string,
) {
  const reqUrl = req.url || '/';
  const parsedUrl = new URL(reqUrl, 'http://localhost');
  const ip = parsedUrl.searchParams.get('ip');
  const portStr = parsedUrl.searchParams.get('port');
  const isTest = parsedUrl.searchParams.get('test') === '1';
  const isPremium = parsedUrl.searchParams.get('premium') === '1';

  if (!ip || !portStr) {
    clientSocket.write('HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nMissing ip or port parameter\r\n');
    clientSocket.destroy();
    return;
  }

  const port = Number(portStr);
  if (!port || port <= 0 || port > 65535) {
    clientSocket.write('HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nInvalid port parameter\r\n');
    clientSocket.destroy();
    return;
  }

  // Telegram DC path
  const targetPath = `/apiws${isTest ? '_test' : ''}${isPremium ? '_premium' : ''}`;
  const secKey = req.headers['sec-websocket-key'];
  const secProtocol = req.headers['sec-websocket-protocol'] || 'binary';
  const secVersion = req.headers['sec-websocket-version'] || '13';

  createProxiedConnection({
    targetHost: ip,
    targetPort: port,
    proxyUrl,
    timeoutMs: 15000,
  }).then((targetSocket) => {
    clientSocket.once('error', () => {
      targetSocket.destroy();
    });

    targetSocket.once('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[WS Relay] Target socket error (${ip}:${port}):`, err.message);
      clientSocket.destroy();
    });

    clientSocket.once('close', () => {
      targetSocket.destroy();
    });

    targetSocket.once('close', () => {
      clientSocket.destroy();
    });

    // Forward the initial HTTP upgrade request to the Telegram DC
    let upgradeReq = `GET ${targetPath} HTTP/1.1\r\n`
      + `Host: ${ip}:${port}\r\n`
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n';

    if (secKey) upgradeReq += `Sec-WebSocket-Key: ${secKey}\r\n`;
    if (secVersion) upgradeReq += `Sec-WebSocket-Version: ${secVersion}\r\n`;
    if (secProtocol) upgradeReq += `Sec-WebSocket-Protocol: ${secProtocol}\r\n`;

    upgradeReq += '\r\n';

    targetSocket.write(upgradeReq);

    if (head && head.length > 0) {
      targetSocket.write(head);
    }

    clientSocket.pipe(targetSocket);
    targetSocket.pipe(clientSocket);
  }).catch((err: Error) => {
    // eslint-disable-next-line no-console
    console.error(`[WS Relay FAIL-CLOSED] Failed to connect to ${ip}:${port} (proxy: ${proxyUrl || 'none'}):`, err.message);
    const msg = `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nProxy Relay Error: ${err.message}\r\n`;
    clientSocket.write(msg);
    clientSocket.destroy();
  });
}
