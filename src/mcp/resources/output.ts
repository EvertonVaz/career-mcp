import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config.js';
import { CHANNELS, outputPath } from '../../lib/coherence.js';

export function registerOutputResources(server: McpServer, config: Config): void {
  for (const channel of CHANNELS) {
    const uri = `output://${channel}`;

    server.registerResource(
      `output-${channel}`,
      uri,
      {
        description: `Última geração de ${channel}. Derivado do career.yml, não é fonte de verdade.`,
        mimeType: 'application/json',
      },
      async () => {
        const file = outputPath(config.paths.output, channel);

        let view: Record<string, unknown>;
        try {
          const content = await readFile(file, 'utf8');
          view = { generated: true, path: file, characters: content.length, content };
        } catch {
          // Nunca gerado não é erro: é uma tool que ainda não rodou.
          view = { generated: false, hint: `Rode a tool generate_${channel} para gerar.` };
        }

        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(view, null, 2) }],
        };
      },
    );
  }
}
