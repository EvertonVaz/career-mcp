import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createApp } from './app.js';

const TOKEN = 'token-de-teste';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_RPC = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

let baseUrl: string;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

beforeAll(async () => {
  const app = createApp(loadConfig({ MCP_AUTH_TOKEN: TOKEN }));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('sem porta');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

type JsonRpcResponse = {
  result?: {
    protocolVersion?: string;
    capabilities?: Record<string, unknown>;
    serverInfo?: { name: string; version: string };
  };
  error?: { code: number; message: string };
};

async function body(response: Response): Promise<JsonRpcResponse> {
  return (await response.json()) as JsonRpcResponse;
}

function rpc(method: string, params: unknown = {}, id = 1): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { ...JSON_RPC, ...AUTH },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

const INITIALIZE_PARAMS = {
  protocolVersion: LATEST_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: 'vitest', version: '0' },
};

describe('GET /health', () => {
  it('responde 200 sem autenticação', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('continua isento mesmo com token errado', async () => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { authorization: 'Bearer errado' },
    });

    expect(response.status).toBe(200);
  });
});

describe('/mcp', () => {
  it('exige bearer token', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: JSON_RPC,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });

    expect(response.status).toBe(401);
  });

  it('responde initialize com a identidade do servidor', async () => {
    const response = await rpc('initialize', INITIALIZE_PARAMS);

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.result?.serverInfo?.name).toBe('career-mcp-server');
    expect(payload.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('não abre sessão — stateless', async () => {
    const response = await rpc('initialize', INITIALIZE_PARAMS);

    expect(response.headers.get('mcp-session-id')).toBeNull();
  });

  it('anuncia só as capabilities que existem de fato', async () => {
    const response = await rpc('initialize', INITIALIZE_PARAMS);

    const capabilities = (await body(response)).result?.capabilities;
    // resources vieram na Fase 2; tools e prompts ainda não existem, e
    // anunciar o que não existe faz o cliente chamar método que dá -32601.
    expect(capabilities).toHaveProperty('resources');
    expect(capabilities).not.toHaveProperty('tools');
    expect(capabilities).not.toHaveProperty('prompts');
  });

  it('responde ping', async () => {
    expect((await rpc('ping')).status).toBe(200);
  });

  it('devolve erro JSON-RPC para método desconhecido, sem derrubar o servidor', async () => {
    const payload = await body(await rpc('metodo/inexistente'));

    expect(payload.error?.code).toBe(-32601);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it('rejeita GET (não há stream em modo stateless)', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      headers: { ...AUTH, accept: 'text/event-stream' },
    });

    expect(response.status).toBe(405);
  });

  it('aceita DELETE como no-op', async () => {
    const response = await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers: AUTH });

    expect(response.status).toBe(200);
  });

  it('rejeita corpo que não é JSON válido', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...JSON_RPC, ...AUTH },
      body: '{ isso não é json',
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});

describe('rota desconhecida', () => {
  it('responde 404', async () => {
    expect((await fetch(`${baseUrl}/nada`)).status).toBe(404);
  });
});
