import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { Ctx } from './context.ts';
import { ApiError, Codes, envelope, fail } from './lib/errors.ts';
import { authRoutes } from './modules/auth.ts';
import { roomRoutes } from './modules/rooms.ts';
import { recordingRoutes } from './modules/recording.ts';
import { syncRoutes } from './modules/sync.ts';
import { uploadRoutes } from './modules/uploads.ts';
import { videoRoutes } from './modules/videos.ts';

export const API_PREFIX = '/api';

/** Giới hạn tần suất đơn giản theo IP cho các API xác thực (chống dò mật khẩu/mã). */
function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string, now: number) => {
    const h = hits.get(key);
    if (!h || h.reset <= now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      if (hits.size > 10_000) for (const [k, x] of hits) if (x.reset <= now) hits.delete(k);
      return;
    }
    if (++h.n > limit) fail(Codes.LIMITED_ACCESS, undefined, { retry_after: Math.ceil((h.reset - now) / 1000) });
  };
}

export async function buildApp(ctx: Ctx, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024, trustProxy: true });

  // JSON body rỗng được coi là {} ; JSON hỏng → 1003.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new ApiError(Codes.PARAM_TYPE_INVALID, 'Invalid JSON body'), undefined);
    }
  });

  await app.register(cors, {
    origin: ctx.config.corsOrigin ? ctx.config.corsOrigin.split(',').map((s) => s.trim()) : true,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(200).send(envelope(err.code, err.message, err.data));
    const e = err as { code?: string; statusCode?: number; message: string };
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send(envelope(Codes.PARAM_VALUE_INVALID, 'Body too large'));
    if (e.code?.startsWith('FST_ERR_CTP') || e.statusCode === 400 || e.statusCode === 415)
      return reply.code(200).send(envelope(Codes.PARAM_TYPE_INVALID, e.message));
    if (e.code?.startsWith('ERR_SQLITE') || /database is locked/i.test(e.message)) {
      req.log.error(err);
      return reply.code(503).send(envelope(Codes.DB_UNAVAILABLE));
    }
    req.log.error(err);
    return reply.code(500).send(envelope(Codes.EXCEPTION));
  });

  const authLimit = rateLimiter(30, 60_000);

  await app.register(
    async (api) => {
      api.addHook('onRequest', async (req) => {
        if (req.method === 'POST' && req.url.startsWith(`${API_PREFIX}/auth/`) && !req.url.endsWith('/refresh'))
          authLimit(`${req.ip}:${req.url}`, ctx.now());
      });
      api.get('/health', async () => envelope(Codes.OK, undefined, { status: 'ok', time: new Date(ctx.now()).toISOString() }));
      authRoutes(api, ctx);
      roomRoutes(api, ctx);
      syncRoutes(api, ctx);
      recordingRoutes(api, ctx);
      uploadRoutes(api, ctx);
      videoRoutes(api, ctx);
    },
    { prefix: API_PREFIX },
  );

  // Phục vụ giao diện Controller (web/dist) cùng một địa chỉ với API → chỉ cần một tunnel.
  const dist = ctx.config.webDist;
  const hasWeb = !!dist && fs.existsSync(path.join(dist, 'index.html'));
  if (hasWeb) await app.register(fastifyStatic, { root: dist!, wildcard: false });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith(API_PREFIX) || !hasWeb || req.method !== 'GET')
      return reply.code(404).send(envelope(Codes.METHOD_INVALID, `Cannot ${req.method} ${req.url.split('?')[0]}`));
    return reply.sendFile('index.html');
  });

  return app;
}
