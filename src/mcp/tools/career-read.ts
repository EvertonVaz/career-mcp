import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { loadCareer } from '../../lib/loader.js';
import { Experience, Project, Skill, SkillCategory } from '../../lib/schema.js';

/** Minúsculas e sem acento: "estagiário" tem que casar com "estagiario". */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function matchesQuery(fields: (string | undefined)[], query: string | undefined): boolean {
  if (query === undefined) return true;

  const needle = normalize(query);
  return fields.some((field) => field !== undefined && normalize(field).includes(needle));
}

/** Todas as entradas pedidas precisam estar presentes (AND, não OR). */
function matchesAll(available: string[], wanted: string[] | undefined): boolean {
  if (wanted === undefined) return true;

  const have = new Set(available.map(normalize));
  return wanted.every((item) => have.has(normalize(item)));
}

function matchesVerified(actual: boolean, wanted: boolean | undefined): boolean {
  return wanted === undefined || actual === wanted;
}

function respond<T>(matched: T[], limit: number) {
  const results = matched.slice(0, limit);
  // total é o tamanho real do casamento; count é o que coube no limit.
  const payload = { total: matched.length, count: results.length, results };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

const COMMON_INPUT = {
  query: z
    .string()
    .min(1)
    .optional()
    .describe('Texto livre, sem diferenciar maiúscula nem acento.'),
  verified: z
    .boolean()
    .optional()
    .describe('true traz só o que foi confirmado por você; false, só o que ainda é sugestão.'),
  limit: z.number().int().min(1).max(100).default(20).describe('Máximo de itens retornados.'),
};

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const counters = { total: z.number().int(), count: z.number().int() };

export function registerCareerReadTools(server: McpServer, config: Config): void {
  server.registerTool(
    'search_experiences',
    {
      title: 'Buscar experiências',
      description: `Busca experiências profissionais no career.yml.

Filtros (todos opcionais, combinados com AND):
  - query: casa em company, role e bullets
  - tech: lista de tecnologias; a experiência precisa ter TODAS
  - verified: true = confirmado por humano, false = ainda é sugestão
  - limit: máximo de itens (1-100, padrão 20)

Retorna { total, count, results[] }. total é quantas casaram antes do limit,
count é quantas voltaram. Sem filtro, devolve todas.`,
      inputSchema: {
        ...COMMON_INPUT,
        tech: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Tecnologias que a experiência precisa ter, todas elas.'),
      },
      outputSchema: { ...counters, results: z.array(Experience) },
      annotations: READ_ONLY,
    },
    async ({ query, tech, verified, limit }) => {
      const career = await loadCareer(config.paths.career);

      return respond(
        career.experiences.filter(
          (item) =>
            matchesQuery([item.company, item.role, ...item.bullets], query) &&
            matchesAll(item.tech, tech) &&
            matchesVerified(item.provenance.verified, verified),
        ),
        limit,
      );
    },
  );

  server.registerTool(
    'search_projects',
    {
      title: 'Buscar projetos',
      description: `Busca projetos no career.yml.

Filtros (todos opcionais, combinados com AND):
  - query: casa em name, problem, solution e result
  - stack: lista de tecnologias; o projeto precisa ter TODAS
  - verified: true = confirmado por humano, false = ainda é sugestão
  - limit: máximo de itens (1-100, padrão 20)

Retorna { total, count, results[] }.`,
      inputSchema: {
        ...COMMON_INPUT,
        stack: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Tecnologias que o projeto precisa ter, todas elas.'),
      },
      outputSchema: { ...counters, results: z.array(Project) },
      annotations: READ_ONLY,
    },
    async ({ query, stack, verified, limit }) => {
      const career = await loadCareer(config.paths.career);

      return respond(
        career.projects.filter(
          (item) =>
            matchesQuery([item.name, item.problem, item.solution, item.result], query) &&
            matchesAll(item.stack, stack) &&
            matchesVerified(item.provenance.verified, verified),
        ),
        limit,
      );
    },
  );

  server.registerTool(
    'search_skills',
    {
      title: 'Buscar skills',
      description: `Busca skills no career.yml.

Filtros (todos opcionais, combinados com AND):
  - query: casa no nome da skill
  - category: language, framework, tool, platform, practice ou soft
  - verified: true = confirmado por humano, false = ainda é sugestão
  - limit: máximo de itens (1-100, padrão 20)

Retorna { total, count, results[] }. Cada skill traz evidence[], que aponta
para os ids que sustentam ela.`,
      inputSchema: {
        ...COMMON_INPUT,
        category: SkillCategory.optional().describe('Categoria da skill.'),
      },
      outputSchema: { ...counters, results: z.array(Skill) },
      annotations: READ_ONLY,
    },
    async ({ query, category, verified, limit }) => {
      const career = await loadCareer(config.paths.career);

      return respond(
        career.skills.filter(
          (item) =>
            matchesQuery([item.name], query) &&
            (category === undefined || item.category === category) &&
            matchesVerified(item.provenance.verified, verified),
        ),
        limit,
      );
    },
  );
}
