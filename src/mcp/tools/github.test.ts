import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OUTSIDE_CHANGES } from '../../lib/history.js';
import { startFakeGithub, type FakeGithub } from '../../test/github-fake.js';
import { startHarness, type Harness } from '../../test/harness.js';

const CAREER = `
profile:
  name: Everton
  headline: Desenvolvedor
`;

/** career.yml que já tem o career-mcp importado do GitHub. */
const CAREER_COM_PROJETO = `
profile:
  name: Everton
  headline: Desenvolvedor
projects:
  - id: career-mcp
    name: career-mcp
    github_repo: etovaz/career-mcp
    problem: Canais desencontrados
    stack: [TypeScript]
    links:
      repo: https://github.com/etovaz/career-mcp
`;

type Proposal = {
  repo: string;
  project_id: string;
  name: string;
  description: string | null;
  stack: string[];
  links: { repo: string; demo?: string };
};

type Divergence = {
  repo: string;
  project_id: string;
  field: string;
  career: unknown;
  github: unknown;
};

type SyncResult = {
  applied: boolean;
  synced_at: string;
  scanned: number;
  proposals: Proposal[];
  divergences: Divergence[];
  added?: string[];
  changes?: { path: string; kind: string }[];
};

let github: FakeGithub;
let h: Harness;

beforeAll(async () => {
  github = await startFakeGithub();
  h = await startHarness(CAREER, {
    GITHUB_TOKEN: 'fake-token',
    GITHUB_API_URL: github.baseUrl,
  });
});

afterAll(async () => {
  await h.close();
  await github.close();
});

beforeEach(async () => {
  github.reset();
  await h.writeCareer(CAREER);
  // O repo acumula commits entre testes; cada um precisa começar do zero.
  await h.resetHistory();
});

const sync = (args: Record<string, unknown> = {}): Promise<SyncResult> =>
  h.callTool<SyncResult>('sync_github', args);

describe('sync_github', () => {
  it('não é marcada como readOnly, porque pode escrever', async () => {
    const { tools } = await h.client.listTools();
    const tool = tools.find((t) => t.name === 'sync_github');

    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(false);
  });

  it('propõe repo novo sem tocar no career.yml', async () => {
    github.setRepos([{ name: 'career-mcp', description: 'Servidor MCP', language: 'TypeScript' }]);
    const antes = await h.readCareer();

    const result = await sync();

    expect(result.applied).toBe(false);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      repo: 'etovaz/career-mcp',
      project_id: 'career-mcp',
      description: 'Servidor MCP',
      stack: ['TypeScript'],
      links: { repo: 'https://github.com/etovaz/career-mcp' },
    });
    expect(await h.readCareer()).toBe(antes);
  });

  it('não inventa problema, solução nem resultado', async () => {
    github.setRepos([{ name: 'career-mcp', description: 'Servidor MCP' }]);

    const [proposal] = (await sync()).proposals;

    expect(proposal).not.toHaveProperty('problem');
    expect(proposal).not.toHaveProperty('solution');
    expect(proposal).not.toHaveProperty('result');
  });

  it('não propõe repo que já está no career', async () => {
    await h.writeCareer(CAREER_COM_PROJETO);
    github.setRepos([{ name: 'career-mcp', language: 'TypeScript' }]);

    expect((await sync()).proposals).toEqual([]);
  });

  it('reporta divergência de link sem propor escrita', async () => {
    await h.writeCareer(CAREER_COM_PROJETO.replace('https://github.com/etovaz/career-mcp', 'https://exemplo.com/errado'));
    github.setRepos([{ name: 'career-mcp', language: 'TypeScript' }]);

    const result = await sync();

    expect(result.proposals).toEqual([]);
    expect(result.divergences).toContainEqual({
      repo: 'etovaz/career-mcp',
      project_id: 'career-mcp',
      field: 'links.repo',
      career: 'https://exemplo.com/errado',
      github: 'https://github.com/etovaz/career-mcp',
    });
  });

  it('reporta linguagem que não está no stack', async () => {
    await h.writeCareer(CAREER_COM_PROJETO);
    github.setRepos([{ name: 'career-mcp', language: 'Go' }]);

    expect((await sync()).divergences).toContainEqual(
      expect.objectContaining({ field: 'stack', github: 'Go' }),
    );
  });

  it('repassa since, includeForks e includeArchived para o GitHub', async () => {
    github.setRepos([
      { name: 'vivo' },
      { name: 'forkado', fork: true },
      { name: 'morto', archived: true },
      { name: 'antigo', pushed_at: '2020-01-01T00:00:00Z' },
    ]);

    // Sem filtro: fora fork e arquivado, sobram vivo e antigo.
    expect((await sync()).scanned).toBe(2);
    expect((await sync({ includeForks: true, includeArchived: true })).scanned).toBe(4);
    expect((await sync({ includeForks: true, since: '2021-01-01' })).scanned).toBe(2);
  });

  it('grava o cache mesmo sem confirmar', async () => {
    github.setRepos([{ name: 'career-mcp' }]);

    await sync();

    expect(await readdir(h.cacheDir)).toContain('github-repos.json');
  });
});

describe('sync_github com confirm', () => {
  it('escreve os projetos propostos no career.yml', async () => {
    github.setRepos([{ name: 'career-mcp', language: 'TypeScript' }, { name: 'portfolio' }]);

    const result = await sync({ confirm: true });

    expect(result.applied).toBe(true);
    expect(result.added?.sort()).toEqual(['career-mcp', 'portfolio']);

    const projects = (await h.readResource('career://projects')) as Record<string, unknown>[];
    expect(projects.map((p) => p.id).sort()).toEqual(['career-mcp', 'portfolio']);
  });

  it('marca o que entrou como sugestão do GitHub, não como verificado', async () => {
    github.setRepos([{ name: 'career-mcp' }]);

    await sync({ confirm: true });

    const [project] = (await h.readResource('career://projects')) as Record<string, unknown>[];
    expect(project?.provenance).toMatchObject({
      verified: false,
      source: 'github',
      source_ref: 'github:etovaz/career-mcp',
    });
  });

  it('aplica só o que veio em accept', async () => {
    github.setRepos([{ name: 'career-mcp' }, { name: 'portfolio' }]);

    const result = await sync({ confirm: true, accept: ['etovaz/portfolio'] });

    expect(result.added).toEqual(['portfolio']);
    expect((await h.readResource('career://projects')) as unknown[]).toHaveLength(1);
  });

  it('commita o estado anterior e o que entrou', async () => {
    github.setRepos([{ name: 'career-mcp' }]);

    await sync({ confirm: true });

    expect(await h.commits()).toEqual(['sync_github: projects[career-mcp]', OUTSIDE_CHANGES]);
  });

  it('devolve o diff do que entrou', async () => {
    github.setRepos([{ name: 'career-mcp' }]);

    const result = await sync({ confirm: true });

    expect(result.changes).toEqual([
      expect.objectContaining({ path: 'projects[career-mcp]', kind: 'added' }),
    ]);
  });

  it('não duplica projeto em sync repetido', async () => {
    github.setRepos([{ name: 'career-mcp' }]);

    await sync({ confirm: true });
    const segundo = await sync({ confirm: true });

    expect(segundo.proposals).toEqual([]);
    expect(segundo.added).toEqual([]);
    expect((await h.readResource('career://projects')) as unknown[]).toHaveLength(1);
  });

  it('gera id em kebab-case a partir do nome do repo', async () => {
    github.setRepos([{ name: 'Meu.App_2025' }]);

    expect((await sync({ confirm: true })).added).toEqual(['meu-app-2025']);
  });

  it('desambigua id quando dois repos colidem', async () => {
    github.setRepos([{ name: 'meu.app' }, { name: 'meu-app' }]);

    expect((await sync({ confirm: true })).added?.sort()).toEqual(['meu-app', 'meu-app-2']);
  });
});

describe('sync_github sem token', () => {
  it('explica que falta GITHUB_TOKEN', async () => {
    const semToken = await startHarness(CAREER, { GITHUB_API_URL: github.baseUrl });

    const result = await semToken.client.callTool({ name: 'sync_github', arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/GITHUB_TOKEN/);

    await semToken.close();
  });
});
