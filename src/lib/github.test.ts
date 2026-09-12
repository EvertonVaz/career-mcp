import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createGithub,
  fetchLanguages,
  fetchRepo,
  fetchRepos,
  readRepoCache,
  writeRepoCache,
} from './github.js';
import { startFakeGithub, type FakeGithub } from '../test/github-fake.js';

let github: FakeGithub;

beforeAll(async () => {
  github = await startFakeGithub();
});

afterAll(() => github.close());

beforeEach(() => github.reset());

function client() {
  return createGithub('fake-token', github.baseUrl);
}

describe('fetchRepos', () => {
  it('segue o header Link até a última página', async () => {
    github.setPageSize(3);
    github.setRepos(Array.from({ length: 7 }, (_, i) => ({ name: `repo-${i}` })));

    const repos = await fetchRepos(client());

    expect(repos.map((r) => r.name)).toEqual([
      'repo-0',
      'repo-1',
      'repo-2',
      'repo-3',
      'repo-4',
      'repo-5',
      'repo-6',
    ]);
    expect(github.requests.filter((r) => r.path === '/user/repos')).toHaveLength(3);
  });

  it('manda o token em toda requisição', async () => {
    github.setRepos([{ name: 'a' }]);

    await fetchRepos(client());

    expect(github.requests.every((r) => r.authorization === 'token fake-token')).toBe(true);
  });

  it('guarda só os campos que viram evidência', async () => {
    github.setRepos([
      { name: 'career-mcp', description: 'Servidor MCP', language: 'TypeScript', topics: ['mcp'] },
    ]);

    const [repo] = await fetchRepos(client());

    expect(repo).toEqual({
      name: 'career-mcp',
      full_name: 'etovaz/career-mcp',
      description: 'Servidor MCP',
      html_url: 'https://github.com/etovaz/career-mcp',
      homepage: null,
      language: 'TypeScript',
      topics: ['mcp'],
      fork: false,
      archived: false,
      pushed_at: '2026-09-01T00:00:00Z',
      stargazers_count: 0,
    });
  });

  it('exclui fork por padrão', async () => {
    github.setRepos([{ name: 'meu' }, { name: 'forkado', fork: true }]);

    expect((await fetchRepos(client())).map((r) => r.name)).toEqual(['meu']);
  });

  it('inclui fork quando pedido', async () => {
    github.setRepos([{ name: 'meu' }, { name: 'forkado', fork: true }]);

    expect((await fetchRepos(client(), { includeForks: true })).map((r) => r.name)).toEqual([
      'meu',
      'forkado',
    ]);
  });

  it('exclui archived por padrão', async () => {
    github.setRepos([{ name: 'vivo' }, { name: 'morto', archived: true }]);

    expect((await fetchRepos(client())).map((r) => r.name)).toEqual(['vivo']);
  });

  it('inclui archived quando pedido', async () => {
    github.setRepos([{ name: 'vivo' }, { name: 'morto', archived: true }]);

    expect((await fetchRepos(client(), { includeArchived: true })).map((r) => r.name)).toEqual([
      'vivo',
      'morto',
    ]);
  });

  it('filtra por since usando pushed_at', async () => {
    github.setRepos([
      { name: 'recente', pushed_at: '2026-08-01T00:00:00Z' },
      { name: 'antigo', pushed_at: '2024-01-01T00:00:00Z' },
    ]);

    expect((await fetchRepos(client(), { since: '2026-01-01' })).map((r) => r.name)).toEqual([
      'recente',
    ]);
  });

  it('explica token inválido em vez de vazar o erro cru', async () => {
    github.failWith(401, { message: 'Bad credentials' });

    await expect(fetchRepos(client())).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('explica rate limit', async () => {
    github.failWith(403, { message: 'API rate limit exceeded' });

    await expect(fetchRepos(client())).rejects.toThrow(/rate limit/i);
  });
});

describe('fetchRepo', () => {
  it('busca um repo pelo full_name', async () => {
    github.setRepos([{ name: 'career-mcp', language: 'TypeScript' }]);

    expect(await fetchRepo(client(), 'etovaz/career-mcp')).toMatchObject({
      full_name: 'etovaz/career-mcp',
      language: 'TypeScript',
    });
  });

  it('traz fork e archived sem filtrar, porque o pedido foi explícito', async () => {
    github.setRepos([{ name: 'forkado', fork: true, archived: true }]);

    expect(await fetchRepo(client(), 'etovaz/forkado')).toMatchObject({
      fork: true,
      archived: true,
    });
  });

  it('explica repo inexistente', async () => {
    await expect(fetchRepo(client(), 'etovaz/nao-existe')).rejects.toThrow(/não encontrado/i);
  });

  it('recusa full_name mal formado', async () => {
    await expect(fetchRepo(client(), 'career-mcp')).rejects.toThrow(/owner\/repo/);
  });
});

describe('fetchLanguages', () => {
  it('devolve o mapa de linguagens do repo', async () => {
    github.setLanguages('etovaz/career-mcp', { TypeScript: 9000, Dockerfile: 300 });

    expect(await fetchLanguages(client(), 'etovaz/career-mcp')).toEqual({
      TypeScript: 9000,
      Dockerfile: 300,
    });
  });

  it('devolve vazio para repo sem linguagem detectada', async () => {
    expect(await fetchLanguages(client(), 'etovaz/vazio')).toEqual({});
  });
});

describe('cache de repos', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'career-cache-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('devolve null quando ainda não houve sync', async () => {
    expect(await readRepoCache(dir)).toBeNull();
  });

  it('faz round-trip e carimba synced_at', async () => {
    github.setRepos([{ name: 'career-mcp' }]);
    const repos = await fetchRepos(client());

    const written = await writeRepoCache(dir, repos);
    const read = await readRepoCache(dir);

    expect(read?.repos).toEqual(repos);
    expect(read?.synced_at).toBe(written.synced_at);
    expect(Date.now() - Date.parse(written.synced_at)).toBeLessThan(5000);
  });

  it('cria o diretório de cache se não existir', async () => {
    const nested = path.join(dir, 'fundo', 'do', 'poco');

    await writeRepoCache(nested, []);

    expect((await readRepoCache(nested))?.repos).toEqual([]);
  });
});
