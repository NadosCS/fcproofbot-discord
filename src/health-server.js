import { createServer } from 'node:http';

function writeResponse(response, statusCode, contentType, body, headOnly) {
  const payload = Buffer.from(body, 'utf8');

  response.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });

  response.end(headOnly ? undefined : payload);
}

function writeJson(response, statusCode, data, headOnly) {
  writeResponse(
    response,
    statusCode,
    'application/json; charset=utf-8',
    `${JSON.stringify(data)}\n`,
    headOnly,
  );
}

export async function startHealthServer({ port, getStatus }) {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('The health server PORT must be between 1 and 65535.');
  }

  if (typeof getStatus !== 'function') {
    throw new TypeError('startHealthServer requires a getStatus function.');
  }

  const server = createServer((request, response) => {
    const method = request.method || 'GET';
    const headOnly = method === 'HEAD';

    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      writeJson(
        response,
        405,
        { ok: false, error: 'Method not allowed.' },
        headOnly,
      );
      return;
    }

    let pathname = '/';

    try {
      pathname = new URL(
        request.url || '/',
        'http://localhost',
      ).pathname;
    } catch {
      writeJson(
        response,
        400,
        { ok: false, error: 'Invalid request URL.' },
        headOnly,
      );
      return;
    }

    if (pathname === '/health') {
      try {
        const status = getStatus();
        writeJson(
          response,
          status?.ok === true ? 200 : 503,
          {
            ...status,
            checkedAt: new Date().toISOString(),
            uptimeSeconds: Math.floor(process.uptime()),
          },
          headOnly,
        );
      } catch (error) {
        console.error('Health status generation failed:', error);
        writeJson(
          response,
          500,
          { ok: false, error: 'Health status unavailable.' },
          headOnly,
        );
      }
      return;
    }

    if (pathname === '/') {
      writeResponse(
        response,
        200,
        'text/plain; charset=utf-8',
        'Ultimate Clone Hero FC Proof Bot is running.\n',
        headOnly,
      );
      return;
    }

    writeJson(
      response,
      404,
      { ok: false, error: 'Not found.' },
      headOnly,
    );
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 10_000;

  await new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off('listening', handleListening);
      reject(error);
    };

    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };

    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, '0.0.0.0');
  });

  server.on('error', (error) => {
    console.error('Health server error:', error);
  });

  console.log(`Health server listening on 0.0.0.0:${port}.`);
  return server;
}

export async function stopHealthServer(server) {
  if (!server || !server.listening) return;

  await new Promise((resolve) => {
    const forceCloseTimer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 5_000);

    forceCloseTimer.unref?.();

    server.close(() => {
      clearTimeout(forceCloseTimer);
      resolve();
    });
  });
}
