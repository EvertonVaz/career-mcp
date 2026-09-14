import { mkdir, writeFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { CHANNELS, compareChannel, outputPath, render, type Channel } from '../../lib/coherence.js';
import { loadCareer } from '../../lib/loader.js';

const DESCRIPTION: Record<Channel, string> = {
  linkedin: 'headline, sobre, experiências e competências, em seções prontas para colar',
  resume: 'currículo completo em Markdown',
  portfolio: 'projetos com problema, solução e resultado, destacados primeiro',
};

/**
 * output/ fica no servidor, fora do alcance de quem conversa com o agente. Sem
 * essa instrução o agente responde "gerado em /app/output/resume.md" e o
 * usuário fica sem o arquivo.
 */
export function localCopyHint(field: string): string {
  return `O arquivo gravado fica no servidor, onde o usuário não tem acesso.
Depois de gerar, mostre o conteúdo (campo ${field}) ao usuário e
pergunte se ele quer uma cópia local. Só salve no filesystem dele se ele aceitar.`;
}

export function registerGeneratorTools(server: McpServer, config: Config): void {
  for (const channel of CHANNELS) {
    server.registerTool(
      `generate_${channel}`,
      {
        title: `Gerar ${channel}`,
        description: `Renderiza ${DESCRIPTION[channel]} a partir do career.yml e grava em
output/${channel}.md, sobrescrevendo a geração anterior.

Só usa o que está no career.yml — não completa lacuna. O que falta aparece
marcado como pendência.

Não pede confirm: output/ é derivado e descartável, dá para regerar a
qualquer momento. O canônico é data/career.yml.

${localCopyHint('content')}`,
        inputSchema: {},
        outputSchema: {
          channel: z.string(),
          path: z.string(),
          characters: z.number().int(),
          content: z.string(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const career = await loadCareer(config.paths.career);
        const content = render(career, channel);
        const file = outputPath(config.paths.output, channel);

        await mkdir(config.paths.output, { recursive: true });
        await writeFile(file, content);

        const payload = { channel, path: file, characters: content.length, content };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      },
    );
  }

  server.registerTool(
    'diff_channels',
    {
      title: 'Conferir se os canais estão em dia',
      description: `Compara cada arquivo em output/ com o que sairia do career.yml agora.

Os três canais saem da mesma fonte, então entre si são coerentes por
construção. O que desencontra é arquivo gerado antes de uma edição.

Por canal:
  - missing: nunca gerado
  - stale: o career.yml mudou depois da geração; added[] e removed[] mostram
    as linhas que entrariam e sairiam (até 20 de cada)
  - current: em dia

coherent é true só quando os três estão current. Não escreve nada.`,
      inputSchema: {},
      outputSchema: {
        coherent: z.boolean(),
        channels: z.array(
          z.object({
            channel: z.string(),
            status: z.enum(['missing', 'stale', 'current']),
            added: z.array(z.string()),
            removed: z.array(z.string()),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const career = await loadCareer(config.paths.career);

      const channels = await Promise.all(
        CHANNELS.map((channel) => compareChannel(career, config.paths.output, channel)),
      );

      const payload = {
        coherent: channels.every((item) => item.status === 'current'),
        channels,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    },
  );
}
