import { createHash } from 'node:crypto';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearerAuth } from './auth.js';

const TOKEN = 'token-correto';

/** Sobe um app real numa porta efêmera; os testes batem HTTP de verdade. */
const app = express();
app.get('/open', (_req, res) => {
  res.json({ ok: true });
});
app.use('/guarded', bearerAuth(createHash('sha256').update(TOKEN).digest()));
app.get('/guarded', (_req, res) => {
  res.json({ ok: true });
});

let baseUrl: string;
let server: ReturnType<typeof app.listen>;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('sem porta');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function get(path: string, authorization?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe('bearerAuth', () => {
  it('não interfere em rota fora do middleware', async () => {
    expect((await get('/open')).status).toBe(200);
  });

  it('libera com o token correto', async () => {
    const response = await get('/guarded', `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('aceita o esquema em qualquer caixa (RFC 7235)', async () => {
    expect((await get('/guarded', `bearer ${TOKEN}`)).status).toBe(200);
  });

  it('bloqueia sem header', async () => {
    const response = await get('/guarded');

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('bloqueia com esquema errado', async () => {
    expect((await get('/guarded', `Basic ${TOKEN}`)).status).toBe(401);
  });

  it('bloqueia com token errado do mesmo tamanho', async () => {
    expect((await get('/guarded', 'Bearer token-errado!')).status).toBe(401);
  });

  it('bloqueia token de tamanho diferente sem estourar RangeError', async () => {
    expect((await get('/guarded', 'Bearer x')).status).toBe(401);
    expect((await get('/guarded', `Bearer ${'x'.repeat(500)}`)).status).toBe(401);
  });

  it('bloqueia header sem token', async () => {
    expect((await get('/guarded', 'Bearer')).status).toBe(401);
    expect((await get('/guarded', 'Bearer ')).status).toBe(401);
  });

  it('não vaza motivo nem header de desafio', async () => {
    const response = await get('/guarded', 'Bearer errado');

    expect(await response.text()).not.toMatch(/token|hash|expected/i);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });
});
