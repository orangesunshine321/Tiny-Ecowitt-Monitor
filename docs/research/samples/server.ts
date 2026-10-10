// Fastify 5: SSE without plugins + @fastify/static SPA with cache headers.
import Fastify, { type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

const WEB_ROOT = path.resolve(process.env.WEB_ROOT ?? path.join(import.meta.dirname, '..', 'web'));

const app = Fastify({ logger: true, trustProxy: true });

// ---------- SSE ----------
type SseClient = { res: ServerResponse; send: (event: string, data: unknown, id?: number) => boolean };
const sseClients = new Set<SseClient>();

app.get('/api/events', (request, reply) => {
  reply.hijack(); // we own reply.raw from here on; Fastify hooks/serializers/compress are bypassed
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', // ignored/forbidden on HTTP/2, harmless on HTTP/1.1
    'X-Accel-Buffering': 'no', // nginx / Nginx Proxy Manager: disable proxy buffering for this response
  });
  res.write('retry: 5000\n\n');
  const client: SseClient = {
    res,
    send(event, data, id) {
      let frame = '';
      if (id !== undefined) frame += `id: ${id}\n`;
      frame += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; // JSON.stringify never emits raw newlines
      return res.write(frame); // false => kernel buffer full (slow client): skip/coalesce next updates
    },
  };
  sseClients.add(client);
  const heartbeat = setInterval(() => res.write(': hb\n\n'), 15_000); // < proxy_read_timeout (nginx default 60s)
  res.on('close', () => { // fires on client disconnect (verified Node 20/22/24)
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
  client.send('hello', { lastEventId: request.headers['last-event-id'] ?? null });
});

export function broadcast(event: string, data: unknown, id?: number) {
  for (const c of sseClients) c.send(event, data, id);
}

// Without this, app.close() (SIGTERM) waits until every SSE client disconnects.
app.addHook('preClose', async () => {
  for (const c of sseClients) c.res.end();
});

// ---------- static SPA ----------
await app.register(fastifyStatic, {
  root: WEB_ROOT,
  wildcard: true,
  index: false,
  // @fastify/static >= 10: (reply: FastifyReply, filePath, stat). v8/v9: (res: ServerResponse, ...)
  setHeaders(reply: FastifyReply, filePath: string) {
    const rel = path.relative(WEB_ROOT, filePath).split(path.sep).join('/');
    reply.header('Cache-Control', rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
});
app.get('/', (_req, reply) => reply.header('Cache-Control', 'no-cache').sendFile('index.html'));

app.setNotFoundHandler((req, reply) => {
  const url = req.url.split('?')[0] ?? '';
  const wantsHtml = (req.headers.accept ?? '').includes('text/html');
  if ((req.method === 'GET' || req.method === 'HEAD') && !url.startsWith('/api/') && !path.extname(url) && wantsHtml) {
    return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
  }
  return reply.code(404).send({ error: 'Not Found' });
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => { void app.close().then(() => process.exit(0)); });
}

await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 8080) });
