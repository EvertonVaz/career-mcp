import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config.js';
import { loadCareer } from '../../lib/loader.js';
import type { Career } from '../../lib/schema.js';

type Slice = {
  name: string;
  description: string;
  select: (career: Career) => unknown;
};

/** As cinco fatias de leitura previstas no plano. */
const SLICES: Slice[] = [
  {
    name: 'profile',
    description: 'Nome, headline, resumo, localização e links públicos.',
    select: (career) => career.profile,
  },
  {
    name: 'experiences',
    description: 'Cargos, período, bullets e stack de cada experiência.',
    select: (career) => career.experiences,
  },
  {
    name: 'projects',
    description: 'Projetos com problema, solução, resultado, stack e links.',
    select: (career) => career.projects,
  },
  {
    name: 'skills',
    description: 'Skills por categoria, com as evidências que sustentam cada uma.',
    select: (career) => career.skills,
  },
  {
    name: 'education',
    description: 'Formação acadêmica.',
    select: (career) => career.education,
  },
];

export function registerCareerResources(server: McpServer, config: Config): void {
  for (const slice of SLICES) {
    const uri = `career://${slice.name}`;

    server.registerResource(
      slice.name,
      uri,
      { description: slice.description, mimeType: 'application/json' },
      async () => {
        // Lê do disco a cada requisição: o servidor é stateless e o YAML é a
        // fonte de verdade, então edição no arquivo aparece sem restart.
        const career = await loadCareer(config.paths.career);

        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(slice.select(career), null, 2),
            },
          ],
        };
      },
    );
  }
}
