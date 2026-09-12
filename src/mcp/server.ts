import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import { registerCareerResources } from './resources/career.js';
import { registerCareerReadTools } from './tools/career-read.js';

/**
 * Factory, não singleton: em modo stateless cada requisição recebe um
 * McpServer e um transport novos. Reaproveitar a mesma instância entre
 * transports concorrentes causa colisão de request id.
 */
export function createMcpServer(config: Config): McpServer {
  // Sem `capabilities` na mão: o McpServer declara cada uma conforme os
  // register* acontecem. Declarar o que não existe faz o cliente chamar
  // método que responde -32601.
  const server = new McpServer({ name: 'career-mcp-server', version: '0.1.0' });

  registerCareerResources(server, config);
  registerCareerReadTools(server, config);

  return server;
}
