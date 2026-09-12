import express, { type Express } from 'express';
import type { Config } from '../config.js';
import { createMcpServer } from '../mcp/server.js';
import { bearerAuth } from './auth.js';
import { createTransport } from './transport.js';

export function createApp(config: Config): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  // Isento de auth: é o healthcheck apontado no Coolify.
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/mcp', bearerAuth(config.authTokenHash));

  // O transport aceita GET e abre um SSE, mas em stateless não há sessão para
  // correlacionar notificação: o stream ficaria aberto sem nunca receber nada,
  // segurando socket e atrapalhando o shutdown. Recusamos antes de delegar.
  app.get('/mcp', (_req, res) => {
    res.status(405).json({ error: 'method_not_allowed' });
  });

  // Sobra POST (JSON-RPC) e DELETE (no-op em stateless), ambos do transport.
  app.all('/mcp', async (req, res) => {
    const server = createMcpServer();
    const transport = createTransport();

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(
        JSON.stringify({ level: 'error', msg: 'mcp request failed', error: String(error) }),
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  return app;
}
