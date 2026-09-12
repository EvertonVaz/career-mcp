import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../../test/harness.js';

const CAREER_YAML = `
profile:
  name: Everton
  headline: Desenvolvedor
experiences:
  - id: acme-2023
    company: Acme
    role: Backend Dev
    start: 01/03/2023
    bullets:
      - Migrou a API de PHP para TypeScript
    tech: [TypeScript, Postgres]
    provenance: { verified: true }
  - id: beta-2021
    company: Beta Tecnologia
    role: Desenvolvedor Pleno
    start: 01/02/2021
    end: 01/02/2023
    bullets:
      - Automação de deploy
    tech: [Go, Postgres]
  - id: gama-2019
    company: Gama
    role: Estagiário
    start: 01/01/2019
    end: 01/01/2021
    tech: [PHP]
projects:
  - id: career-mcp
    name: career-mcp
    problem: LinkedIn e currículo viviam desencontrados
    stack: [TypeScript, Node]
    provenance: { verified: true }
  - id: portfolio
    name: Portfólio
    solution: Site estático em Astro
    stack: [Astro]
skills:
  - name: TypeScript
    category: language
    provenance: { verified: true }
  - name: Go
    category: language
  - name: Docker
    category: tool
`;

type SearchResult = {
  total: number;
  count: number;
  results: Record<string, unknown>[];
};

let h: Harness;

beforeAll(async () => {
  h = await startHarness(CAREER_YAML);
});

afterAll(() => h.close());

const search = (name: string, args: Record<string, unknown> = {}): Promise<SearchResult> =>
  h.callTool<SearchResult>(name, args);

function ids(result: SearchResult): unknown[] {
  return result.results.map((item) => item.id ?? item.name);
}

describe('registro das tools', () => {
  it('expõe as três buscas com annotation de leitura', async () => {
    const names = ['search_experiences', 'search_projects', 'search_skills'];
    const { tools } = await h.client.listTools();
    const buscas = tools.filter((t) => names.includes(t.name));

    expect(buscas.map((t) => t.name).sort()).toEqual(names);
    expect(buscas.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });
});

describe('search_experiences', () => {
  it('sem filtro devolve tudo', async () => {
    const result = await search('search_experiences');

    expect(result.total).toBe(3);
    expect(result.count).toBe(3);
  });

  it('casa texto livre em company', async () => {
    expect(ids(await search('search_experiences', { query: 'beta' }))).toEqual(['beta-2021']);
  });

  it('casa texto livre em role', async () => {
    expect(ids(await search('search_experiences', { query: 'backend' }))).toEqual(['acme-2023']);
  });

  it('casa texto livre em bullets', async () => {
    expect(ids(await search('search_experiences', { query: 'deploy' }))).toEqual(['beta-2021']);
  });

  it('ignora caixa e acento', async () => {
    expect(ids(await search('search_experiences', { query: 'estagiario' }))).toEqual(['gama-2019']);
    expect(ids(await search('search_experiences', { query: 'AUTOMACAO' }))).toEqual(['beta-2021']);
  });

  it('filtra por tech', async () => {
    expect(ids(await search('search_experiences', { tech: ['postgres'] }))).toEqual([
      'acme-2023',
      'beta-2021',
    ]);
  });

  it('exige todas as techs quando vem mais de uma', async () => {
    expect(ids(await search('search_experiences', { tech: ['Go', 'Postgres'] }))).toEqual([
      'beta-2021',
    ]);
    expect(await search('search_experiences', { tech: ['Go', 'PHP'] })).toMatchObject({ total: 0 });
  });

  it('filtra por verified', async () => {
    expect(ids(await search('search_experiences', { verified: true }))).toEqual(['acme-2023']);
    expect(ids(await search('search_experiences', { verified: false }))).toEqual([
      'beta-2021',
      'gama-2019',
    ]);
  });

  it('combina filtros', async () => {
    expect(
      ids(await search('search_experiences', { query: 'postgres', tech: ['Go'] })),
    ).toEqual([]);
    expect(ids(await search('search_experiences', { tech: ['Postgres'], verified: true }))).toEqual(
      ['acme-2023'],
    );
  });

  it('limit corta os resultados mas total mantém o tamanho real', async () => {
    const result = await search('search_experiences', { limit: 2 });

    expect(result.total).toBe(3);
    expect(result.count).toBe(2);
    expect(result.results).toHaveLength(2);
  });

  it('devolve vazio quando nada casa', async () => {
    expect(await search('search_experiences', { query: 'cobol' })).toMatchObject({
      total: 0,
      count: 0,
      results: [],
    });
  });

  it('rejeita limit fora do intervalo', async () => {
    const result = await h.client.callTool({
      name: 'search_experiences',
      arguments: { limit: 0 },
    });

    expect(result.isError).toBe(true);
  });
});

describe('search_projects', () => {
  it('casa texto livre em problem e solution', async () => {
    expect(ids(await search('search_projects', { query: 'desencontrados' }))).toEqual([
      'career-mcp',
    ]);
    expect(ids(await search('search_projects', { query: 'astro' }))).toEqual(['portfolio']);
  });

  it('filtra por stack', async () => {
    expect(ids(await search('search_projects', { stack: ['typescript'] }))).toEqual(['career-mcp']);
  });

  it('filtra por verified', async () => {
    expect(ids(await search('search_projects', { verified: true }))).toEqual(['career-mcp']);
  });
});

describe('search_skills', () => {
  it('casa texto livre no nome', async () => {
    expect(ids(await search('search_skills', { query: 'docker' }))).toEqual(['Docker']);
  });

  it('filtra por category', async () => {
    expect(ids(await search('search_skills', { category: 'language' }))).toEqual([
      'TypeScript',
      'Go',
    ]);
  });

  it('filtra por verified', async () => {
    expect(ids(await search('search_skills', { verified: true }))).toEqual(['TypeScript']);
  });

  it('rejeita category fora do enum', async () => {
    const result = await h.client.callTool({
      name: 'search_skills',
      arguments: { category: 'inventada' },
    });

    expect(result.isError).toBe(true);
  });
});

describe('formato da resposta', () => {
  it('manda o mesmo conteúdo em texto e em structuredContent', async () => {
    const result = await h.client.callTool({
      name: 'search_experiences',
      arguments: { query: 'backend' },
    });
    const [content] = result.content as { type: string; text: string }[];

    expect(JSON.parse(content!.text)).toEqual(result.structuredContent);
  });
});
