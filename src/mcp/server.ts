import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Factory, não singleton: em modo stateless cada requisição recebe um
 * McpServer e um transport novos. Reaproveitar a mesma instância entre
 * transports concorrentes causa colisão de request id.
 */
export function createMcpServer(): McpServer {
  // Sem `capabilities` na mão: o McpServer declara cada uma conforme os
  // register* acontecem. Declarar o que não existe faz o cliente chamar
  // método que responde -32601.
  const server = new McpServer({ name: 'career-mcp-server', version: '0.1.0' });

  // Fase 2+: registerResources(server), registerTools(server), registerPrompts(server)

  return server;
}
