import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// Fonte única da versão: o tsup embute o valor no bundle, então o runtime não
// precisa do package.json. Bump com `npm version <x.y.z>`.
import pkg from '../../package.json' with { type: 'json' };
import type { Config } from '../config.js';
import { registerPrompts } from './prompts/index.js';
import { registerCareerResources } from './resources/career.js';
import { registerGithubResources } from './resources/github.js';
import { registerOutputResources } from './resources/output.js';
import { registerCareerReadTools } from './tools/career-read.js';
import { registerCareerWriteTools } from './tools/career-write.js';
import { registerGithubTools, requireToken } from './tools/github.js';
import { registerGithubActivityTool } from './tools/github-activity.js';
import { registerGeneratorTools } from './tools/generators.js';
import { registerGithubSuggestTools } from './tools/github-suggest.js';
import { registerTailorTool } from './tools/tailor.js';
import { registerValidateTool } from './tools/validate.js';

/**
 * Factory, não singleton: em modo stateless cada requisição recebe um
 * McpServer e um transport novos. Reaproveitar a mesma instância entre
 * transports concorrentes causa colisão de request id.
 */
export function createMcpServer(config: Config): McpServer {
  // Sem `capabilities` na mão: o McpServer declara cada uma conforme os
  // register* acontecem. Declarar o que não existe faz o cliente chamar
  // método que responde -32601.
  const server = new McpServer({ name: 'career-mcp-server', version: pkg.version });

  registerCareerResources(server, config);
  registerGithubResources(server, config);
  registerOutputResources(server, config);
  registerCareerReadTools(server, config);
  registerCareerWriteTools(server, config);
  registerValidateTool(server, config);
  registerGithubTools(server, config);
  registerGithubSuggestTools(server, config, requireToken);
  registerGithubActivityTool(server, config, requireToken);
  registerGeneratorTools(server, config);
  registerTailorTool(server, config);
  registerPrompts(server);

  return server;
}
