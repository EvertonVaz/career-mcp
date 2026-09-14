import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OUTSIDE_CHANGES } from '../../lib/history.js';
import { startFakeGithub, type FakeGithub } from '../../test/github-fake.js';
import { startHarness, type Harness } from '../../test/harness.js';

const CAREER = `
profile:
  name: Everton
  headline: Desenvolvedor
`;

/** Projeto com texto escrito à mão, que o import não pode atropelar. */
const CAREER_COM_PROJETO = `
profile:
  name: Everton
  headline: Desenvolvedor
projects:
  - id: career-mcp
    name: career-mcp
    github_repo: etovaz/career-mcp
    problem: LinkedIn e currículo desencontrados
    solution: Servidor MCP sobre YAML
    result: Canais coerentes
    stack: [TypeScript, Docker]
    links:
      repo: https://exemplo.com/link-velho
      demo: https://demo-antigo.exemplo.com
    provenance: { verified: true }
`;

type Project = {
  id: string;
  name: string;
  stack: string[];
  links: { repo?: string; demo?: string };
  problem?: string;
  solution?: string;
  result?: string;
  provenance: Record<string, unknown>;
};

type ImportResult = {
  applied: boolean;
  mode: 'create' | 'update';
  repo: string;
  project_id: string;
  divergences: { field: string; career: unknown; github: unknown }[];
  project: Project;
  changes?: { path: string; kind: string }[];
};

let github: FakeGithub;
let h: Harness;

beforeAll(async () => {
  github = await startFakeGithub();
  h = await startHarness(CAREER, { GITHUB_TOKEN: 'fake-token', GITHUB_API_URL: github.baseUrl });
});

afterAll(async () => {
  await h.close();
  await github.close();
});

beforeEach(async () => {
  github.reset();
  await h.writeCareer(CAREER);
  await h.resetHistory();
});

const importRepo = (args: Record<string, unknown>): Promise<ImportResult> =>
  h.callTool<ImportResult>('import_github_repo', args);

async function projects(): Promise<Project[]> {
  return (await h.readResource('career://projects')) as Project[];
}

describe('import_github_repo — criação', () => {
  it('propõe sem escrever quando não tem confirm', async () => {
    github.setRepos([{ name: 'career-mcp', language: 'TypeScript' }]);
    const antes = await h.readCareer();

    const result = await importRepo({ repo: 'etovaz/career-mcp' });

    expect(result).toMatchObject({ applied: false, mode: 'create', project_id: 'career-mcp' });
    expect(result.project.stack).toEqual(['TypeScript']);
    expect(await h.readCareer()).toBe(antes);
  });

  it('grava com confirm', async () => {
    github.setRepos([{ name: 'career-mcp', language: 'TypeScript' }]);

    const result = await importRepo({ repo: 'etovaz/career-mcp', confirm: true });

    expect(result.applied).toBe(true);
    expect((await projects()).map((p) => p.id)).toEqual(['career-mcp']);
  });

  it('aceita id e name customizados em asProject', async () => {
    github.setRepos([{ name: 'career-mcp' }]);

    const result = await importRepo({
      repo: 'etovaz/career-mcp',
      asProject: { id: 'meu-mcp', name: 'Meu MCP' },
      confirm: true,
    });

    expect(result.project).toMatchObject({ id: 'meu-mcp', name: 'Meu MCP' });
  });

  it('importa fork e arquivado, porque o pedido foi explícito', async () => {
    github.setRepos([{ name: 'forkado', fork: true, archived: true }]);

    expect((await importRepo({ repo: 'etovaz/forkado' })).mode).toBe('create');
  });
});

describe('import_github_repo — atualização', () => {
  beforeEach(() => h.writeCareer(CAREER_COM_PROJETO));

  it('mostra as divergências que vai sobrescrever', async () => {
    github.setRepos([{ name: 'career-mcp', language: 'Go', homepage: 'https://demo.exemplo.com' }]);

    const result = await importRepo({ repo: 'etovaz/career-mcp' });

    expect(result.mode).toBe('update');
    expect(result.divergences).toContainEqual({
      field: 'links.repo',
      career: 'https://exemplo.com/link-velho',
      github: 'https://github.com/etovaz/career-mcp',
    });
    expect(result.divergences).toContainEqual({
      field: 'links.demo',
      career: 'https://demo-antigo.exemplo.com',
      github: 'https://demo.exemplo.com',
    });
  });

  it('sobrescreve os campos do GitHub e preserva o texto escrito à mão', async () => {
    github.setRepos([{ name: 'career-mcp', language: 'Go' }]);

    await importRepo({ repo: 'etovaz/career-mcp', confirm: true });
    const [project] = await projects();

    expect(project?.links.repo).toBe('https://github.com/etovaz/career-mcp');
    expect(project?.problem).toBe('LinkedIn e currículo desencontrados');
    expect(project?.solution).toBe('Servidor MCP sobre YAML');
    expect(project?.result).toBe('Canais coerentes');
  });

  it('acrescenta a linguagem ao stack sem remover o que já estava', async () => {
    github.setRepos([{ name: 'career-mcp', language: 'Go' }]);

    await importRepo({ repo: 'etovaz/career-mcp', confirm: true });

    expect((await projects())[0]?.stack).toEqual(['TypeScript', 'Docker', 'Go']);
  });

  it('não apaga o demo quando o GitHub não tem homepage', async () => {
    github.setRepos([{ name: 'career-mcp' }]);

    await importRepo({ repo: 'etovaz/career-mcp', confirm: true });

    expect((await projects())[0]?.links.demo).toBe('https://demo-antigo.exemplo.com');
  });

  it('preserva verified do que já foi confirmado por você', async () => {
    github.setRepos([{ name: 'career-mcp' }]);

    await importRepo({ repo: 'etovaz/career-mcp', confirm: true });

    expect((await projects())[0]?.provenance).toMatchObject({ verified: true });
  });

  it('carimba last_synced_at', async () => {
    github.setRepos([{ name: 'career-mcp' }]);

    await importRepo({ repo: 'etovaz/career-mcp', confirm: true });

    const synced = (await projects())[0]?.provenance.last_synced_at as string;
    expect(Date.now() - Date.parse(synced)).toBeLessThan(5000);
  });

  it('commita o estado anterior e a sobrescrita', async () => {
    github.setRepos([{ name: 'career-mcp', language: 'Go' }]);

    await importRepo({ repo: 'etovaz/career-mcp', confirm: true });

    expect(await h.commits()).toEqual([
      expect.stringMatching(/^import_github_repo: projects\[career-mcp\]/),
      OUTSIDE_CHANGES,
    ]);
  });

  it('re-importar sem mudança só move o carimbo de sync, e isso também é commitado', async () => {
    github.setRepos([{ name: 'career-mcp', language: 'TypeScript' }]);
    await h.writeCareer(
      CAREER_COM_PROJETO.replace(
        'https://exemplo.com/link-velho',
        'https://github.com/etovaz/career-mcp',
      ).replace(
        'provenance: { verified: true }',
        'provenance: { verified: true, source_ref: "github:etovaz/career-mcp" }',
      ),
    );

    const result = await importRepo({ repo: 'etovaz/career-mcp', confirm: true });

    expect(result.divergences).toEqual([]);
    expect(result.changes?.map((c) => c.path)).toEqual([
      'projects[career-mcp].provenance.last_synced_at',
    ]);
    // Sem commit, o carimbo ficaria pendente e seria atribuído à próxima escrita
    // como mudança externa.
    expect(await h.commits()).toEqual([
      'import_github_repo: projects[career-mcp].provenance.last_synced_at',
      OUTSIDE_CHANGES,
    ]);
  });
});

describe('import_github_repo — erros', () => {
  it('explica repo que não existe', async () => {
    const result = await h.client.callTool({
      name: 'import_github_repo',
      arguments: { repo: 'etovaz/fantasma' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/não encontrado/i);
  });

  it('recusa id customizado que colide com projeto existente', async () => {
    await h.writeCareer(CAREER_COM_PROJETO);
    github.setRepos([{ name: 'outro' }]);

    const result = await h.client.callTool({
      name: 'import_github_repo',
      arguments: { repo: 'etovaz/outro', asProject: { id: 'career-mcp' }, confirm: true },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/career-mcp/);
  });
});
