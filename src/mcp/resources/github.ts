import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config.js';
import { readActivityCache, readRepoCache } from '../../lib/github.js';

export function registerGithubResources(server: McpServer, config: Config): void {
  registerRepos(server, config);
  registerActivity(server, config);
}

function registerActivity(server: McpServer, config: Config): void {
  const uri = 'github://activity';

  server.registerResource(
    'github-activity',
    uri,
    {
      description:
        'Último relatório de suggest_experience_from_activity. Cache, não fonte de verdade.',
      mimeType: 'application/json',
    },
    async () => {
      const cache = await readActivityCache<Record<string, unknown>>(config.paths.cache);

      const view = cache ?? {
        cached_at: null,
        hint: 'Nunca rodado — chame a tool suggest_experience_from_activity.',
      };

      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(view, null, 2) }],
      };
    },
  );
}

function registerRepos(server: McpServer, config: Config): void {
  const uri = 'github://repos';

  server.registerResource(
    'github-repos',
    uri,
    {
      description:
        'Repositórios do GitHub como estavam no último sync_github. Cache, não fonte de verdade.',
      mimeType: 'application/json',
    },
    async () => {
      const cache = await readRepoCache(config.paths.cache);

      // Sem cache não é erro: é só um sync que ainda não aconteceu. Devolver
      // a orientação é mais útil para a LLM do que estourar.
      const view =
        cache === null
          ? {
              synced_at: null,
              count: 0,
              repos: [],
              hint: 'Cache vazio — rode a tool sync_github para popular.',
            }
          : { synced_at: cache.synced_at, count: cache.repos.length, repos: cache.repos };

      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(view, null, 2) }],
      };
    },
  );
}
