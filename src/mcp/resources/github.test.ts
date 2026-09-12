import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeGithub, type FakeGithub } from '../../test/github-fake.js';
import { startHarness, type Harness } from '../../test/harness.js';

const CAREER = `
profile:
  name: Everton
  headline: Desenvolvedor
`;

type RepoCacheView = {
  synced_at: string | null;
  count: number;
  repos: { full_name: string }[];
  hint?: string;
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
});

describe('github://repos', () => {
  it('aparece na lista de resources', async () => {
    const { resources } = await h.client.listResources();

    expect(resources.map((r) => r.uri)).toContain('github://repos');
  });

  it('orienta a rodar sync_github quando não há cache', async () => {
    const view = (await h.readResource('github://repos')) as RepoCacheView;

    expect(view).toMatchObject({ synced_at: null, count: 0, repos: [] });
    expect(view.hint).toMatch(/sync_github/);
  });

  it('serve o cache depois do sync', async () => {
    github.setRepos([{ name: 'career-mcp' }, { name: 'portfolio' }]);
    await h.callTool('sync_github');

    const view = (await h.readResource('github://repos')) as RepoCacheView;

    expect(view.count).toBe(2);
    expect(view.repos.map((r) => r.full_name)).toEqual([
      'etovaz/career-mcp',
      'etovaz/portfolio',
    ]);
    expect(Date.now() - Date.parse(view.synced_at as string)).toBeLessThan(5000);
  });

  it('não faz chamada ao GitHub para servir o resource', async () => {
    github.setRepos([{ name: 'career-mcp' }]);
    await h.callTool('sync_github');
    const antes = github.requests.length;

    await h.readResource('github://repos');

    expect(github.requests.length).toBe(antes);
  });
});
