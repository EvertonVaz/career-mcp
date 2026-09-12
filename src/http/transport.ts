import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export function createTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({
    // Sem sessão: nada de estado em memória. O estado real está no YAML.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
}
