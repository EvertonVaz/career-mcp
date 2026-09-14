import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeGithub, type FakeGithub } from '../../test/github-fake.js';
import { startHarness, type Harness } from '../../test/harness.js';

const CAREER = `
profile:
  name: Everton
  headline: Desenvolvedor
projects:
  - id: career-mcp
    name: career-mcp
    github_repo: etovaz/career-mcp
skills:
  - name: TypeScript
    category: language
`;

type Suggestion = {
  name: string;
  category: string;
  repos: string[];
  bytes: number;
  evidence: { type: string; ref: string }[];
};

type SuggestResult = {
  applied: boolean;
  scanned: number;
  suggestions: Suggestion[];
  added?: string[];
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

const suggest = (args: Record<string, unknown> = {}): Promise<SuggestResult> =>
  h.callTool<SuggestResult>('suggest_skills_from_github', args);

describe('suggest_skills_from_github', () => {
  it('propõe linguagem que ainda não está nas skills', async () => {
    github.setRepos([{ name: 'career-mcp' }]);
    github.setLanguages('etovaz/career-mcp', { TypeScript: 9000, Go: 4000 });

    const result = await suggest();

    expect(result.applied).toBe(false);
    expect(result.suggestions.map((s) => s.name)).toEqual(['Go']);
  });

  it('cada sugestão aponta o repo como evidência', async () => {
    github.setRepos([{ name: 'career-mcp' }]);
    github.setLanguages('etovaz/career-mcp', { Go: 4000 });

    const [suggestion] = (await suggest()).suggestions;

    expect(suggestion).toMatchObject({
      name: 'Go',
      category: 'language',
      repos: ['etovaz/career-mcp'],
      bytes: 4000,
      evidence: [{ type: 'repo', ref: 'etovaz/career-mcp' }],
    });
  });

  it('ignora caixa ao comparar com as skills que já existem', async () => {
    github.setRepos([{ name: 'career-mcp' }]);
    github.setLanguages('etovaz/career-mcp', { typescript: 9000 });

    expect((await suggest()).suggestions).toEqual([]);
  });

  it('soma bytes e repos da mesma linguagem', async () => {
    github.setRepos([{ name: 'a' }, { name: 'b' }]);
    github.setLanguages('etovaz/a', { Go: 1000 });
    github.setLanguages('etovaz/b', { Go: 2000 });

    const [suggestion] = (await suggest()).suggestions;

    expect(suggestion?.bytes).toBe(3000);
    expect(suggestion?.repos).toEqual(['etovaz/a', 'etovaz/b']);
  });

  it('ordena por número de repos e depois por bytes', async () => {
    github.setRepos([{ name: 'a' }, { name: 'b' }]);
    github.setLanguages('etovaz/a', { Go: 100, Rust: 50_000 });
    github.setLanguages('etovaz/b', { Go: 100 });

    expect((await suggest()).suggestions.map((s) => s.name)).toEqual(['Go', 'Rust']);
  });

  it('respeita minRepos', async () => {
    github.setRepos([{ name: 'a' }, { name: 'b' }]);
    github.setLanguages('etovaz/a', { Go: 100, Rust: 50_000 });
    github.setLanguages('etovaz/b', { Go: 100 });

    expect((await suggest({ minRepos: 2 })).suggestions.map((s) => s.name)).toEqual(['Go']);
  });

  it('respeita limit', async () => {
    github.setRepos([{ name: 'a' }]);
    github.setLanguages('etovaz/a', { Go: 300, Rust: 200, Zig: 100 });

    expect((await suggest({ limit: 2 })).suggestions).toHaveLength(2);
  });

  it('não propõe nada quando não há repo', async () => {
    expect(await suggest()).toMatchObject({ scanned: 0, suggestions: [] });
  });
});

describe('suggest_skills_from_github com confirm', () => {
  it('grava as skills propostas como não verificadas', async () => {
    github.setRepos([{ name: 'career-mcp' }]);
    github.setLanguages('etovaz/career-mcp', { Go: 4000 });

    const result = await suggest({ confirm: true });

    expect(result.added).toEqual(['Go']);

    const skills = (await h.readResource('career://skills')) as Record<string, unknown>[];
    const go = skills.find((s) => s.name === 'Go');
    expect(go).toMatchObject({
      category: 'language',
      evidence: [{ type: 'repo', ref: 'etovaz/career-mcp' }],
      provenance: { verified: false, source: 'github' },
    });
  });

  it('aplica só o que veio em accept', async () => {
    github.setRepos([{ name: 'a' }]);
    github.setLanguages('etovaz/a', { Go: 300, Rust: 200 });

    expect((await suggest({ confirm: true, accept: ['Rust'] })).added).toEqual(['Rust']);
  });

  it('grava sugestões que passam na validação', async () => {
    github.setRepos([{ name: 'a' }]);
    github.setLanguages('etovaz/a', { Go: 300 });

    await suggest({ confirm: true });

    expect((await h.callTool<{ valid: boolean }>('validate_all')).valid).toBe(true);
  });

  it('não duplica em execução repetida', async () => {
    github.setRepos([{ name: 'a' }]);
    github.setLanguages('etovaz/a', { Go: 300 });

    await suggest({ confirm: true });
    const segundo = await suggest({ confirm: true });

    expect(segundo.suggestions).toEqual([]);
    expect(segundo.added).toEqual([]);
  });
});
