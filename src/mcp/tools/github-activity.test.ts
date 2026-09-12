import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeGithub, type FakeGithub } from '../../test/github-fake.js';
import { startHarness, type Harness } from '../../test/harness.js';

/** Duas experiências com janelas que não se sobrepõem. */
const CAREER = `
profile:
  name: Everton
  headline: Desenvolvedor
experiences:
  - id: acme-2023
    company: Acme
    role: Backend Dev
    start: 01/01/2023
    end: 31/12/2023
  - id: beta-2021
    company: Beta
    role: Dev Pleno
    start: 01/01/2021
    end: 31/12/2021
`;

const SEM_EXPERIENCIA = `
profile:
  name: Everton
  headline: Desenvolvedor
`;

type Candidate = {
  repo: string;
  commits: number;
  first_commit: string;
  last_commit: string;
  language: string | null;
  capped: boolean;
  evidence: { type: string; ref: string };
};

type ActivityReport = {
  scanned_repos: number;
  experiences: {
    experience_id: string;
    company: string;
    period: string;
    candidates: Candidate[];
  }[];
  orphan_repos: Candidate[];
  needs_human_input: string;
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

const activity = (args: Record<string, unknown> = {}): Promise<ActivityReport> =>
  h.callTool<ActivityReport>('suggest_experience_from_activity', args);

function candidatesOf(report: ActivityReport, experienceId: string): Candidate[] {
  return report.experiences.find((e) => e.experience_id === experienceId)?.candidates ?? [];
}

describe('suggest_experience_from_activity', () => {
  it('é read-only: não escreve no career.yml', async () => {
    const { tools } = await h.client.listTools();
    const tool = tools.find((t) => t.name === 'suggest_experience_from_activity');

    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it('amarra o repo à experiência cuja janela ele cobre', async () => {
    github.setRepos([{ name: 'api-acme', language: 'TypeScript' }]);
    github.setCommits('etovaz/api-acme', [
      '2023-03-01T10:00:00Z',
      '2023-06-15T10:00:00Z',
      '2023-09-20T10:00:00Z',
    ]);

    const report = await activity();

    expect(candidatesOf(report, 'acme-2023')).toEqual([
      {
        repo: 'etovaz/api-acme',
        commits: 3,
        first_commit: '2023-03-01T10:00:00Z',
        last_commit: '2023-09-20T10:00:00Z',
        language: 'TypeScript',
        capped: false,
        evidence: { type: 'repo', ref: 'etovaz/api-acme' },
      },
    ]);
    expect(candidatesOf(report, 'beta-2021')).toEqual([]);
  });

  it('não escreve bullet nenhum, só entrega as fontes', async () => {
    github.setRepos([{ name: 'api-acme' }]);
    github.setCommits('etovaz/api-acme', ['2023-03-01T10:00:00Z']);

    const [candidate] = candidatesOf(await activity(), 'acme-2023');

    expect(candidate).not.toHaveProperty('bullet');
    expect((await activity()).needs_human_input).toMatch(/bullet/i);
  });

  it('separa em duas experiências os commits de janelas diferentes', async () => {
    github.setRepos([{ name: 'legado' }]);
    github.setCommits('etovaz/legado', ['2021-05-01T10:00:00Z', '2023-05-01T10:00:00Z']);

    const report = await activity();

    expect(candidatesOf(report, 'acme-2023')[0]?.commits).toBe(1);
    expect(candidatesOf(report, 'beta-2021')[0]?.commits).toBe(1);
  });

  it('reporta como orphan o repo que nenhuma experiência cobre', async () => {
    github.setRepos([{ name: 'lacuna' }]);
    github.setCommits('etovaz/lacuna', ['2019-05-01T10:00:00Z', '2019-06-01T10:00:00Z']);

    const report = await activity();

    expect(report.experiences.every((e) => e.candidates.length === 0)).toBe(true);
    expect(report.orphan_repos.map((r) => r.repo)).toEqual(['etovaz/lacuna']);
    expect(report.orphan_repos[0]?.commits).toBe(2);
  });

  it('sem experiência nenhuma, tudo vira orphan', async () => {
    await h.writeCareer(SEM_EXPERIENCIA);
    github.setRepos([{ name: 'solto' }]);
    github.setCommits('etovaz/solto', ['2023-05-01T10:00:00Z']);

    const report = await activity();

    expect(report.experiences).toEqual([]);
    expect(report.orphan_repos.map((r) => r.repo)).toEqual(['etovaz/solto']);
  });

  it('usa "até agora" como fim de experiência sem end', async () => {
    await h.writeCareer(CAREER.replace('    end: 31/12/2023\n', ''));
    github.setRepos([{ name: 'atual' }]);
    github.setCommits('etovaz/atual', ['2026-01-15T10:00:00Z']);

    expect(candidatesOf(await activity(), 'acme-2023')[0]?.commits).toBe(1);
  });

  it('respeita minCommits em candidates e em orphans', async () => {
    github.setRepos([{ name: 'pouco' }, { name: 'muito' }]);
    github.setCommits('etovaz/pouco', ['2023-05-01T10:00:00Z']);
    github.setCommits('etovaz/muito', [
      '2023-05-01T10:00:00Z',
      '2023-05-02T10:00:00Z',
      '2023-05-03T10:00:00Z',
    ]);

    const report = await activity({ minCommits: 2 });

    expect(candidatesOf(report, 'acme-2023').map((c) => c.repo)).toEqual(['etovaz/muito']);
  });

  it('ordena candidates por volume de commits', async () => {
    github.setRepos([{ name: 'pouco' }, { name: 'muito' }]);
    github.setCommits('etovaz/pouco', ['2023-05-01T10:00:00Z']);
    github.setCommits('etovaz/muito', ['2023-05-01T10:00:00Z', '2023-05-02T10:00:00Z']);

    expect(candidatesOf(await activity(), 'acme-2023').map((c) => c.repo)).toEqual([
      'etovaz/muito',
      'etovaz/pouco',
    ]);
  });

  it('filtra para uma experiência com experienceId', async () => {
    github.setRepos([{ name: 'legado' }]);
    github.setCommits('etovaz/legado', ['2021-05-01T10:00:00Z', '2023-05-01T10:00:00Z']);

    const report = await activity({ experienceId: 'beta-2021' });

    expect(report.experiences.map((e) => e.experience_id)).toEqual(['beta-2021']);
  });

  it('recusa experienceId que não existe', async () => {
    const result = await h.client.callTool({
      name: 'suggest_experience_from_activity',
      arguments: { experienceId: 'nao-existe' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/nao-existe/);
  });

  it('marca capped quando bate no teto de páginas', async () => {
    github.setPageSize(100);
    github.setRepos([{ name: 'gigante' }]);
    github.setCommits(
      'etovaz/gigante',
      Array.from({ length: 350 }, (_, i) => `2023-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`),
    );

    const [candidate] = candidatesOf(await activity(), 'acme-2023');

    expect(candidate?.capped).toBe(true);
    expect(candidate?.commits).toBe(300);
  });
});

describe('github://activity', () => {
  // O cache é compartilhado no harness; as tools acima já escreveram nele.
  beforeEach(() => rm(h.cacheDir, { recursive: true, force: true }));

  it('orienta a rodar a tool quando não há cache', async () => {
    const view = (await h.readResource('github://activity')) as Record<string, unknown>;

    expect(view.cached_at).toBeNull();
    expect(view.hint).toMatch(/suggest_experience_from_activity/);
  });

  it('serve o último relatório depois da tool rodar', async () => {
    github.setRepos([{ name: 'api-acme' }]);
    github.setCommits('etovaz/api-acme', ['2023-03-01T10:00:00Z']);
    await activity();

    const view = (await h.readResource('github://activity')) as ActivityReport & {
      cached_at: string;
    };

    expect(view.scanned_repos).toBe(1);
    expect(view.experiences[0]?.candidates[0]?.repo).toBe('etovaz/api-acme');
    expect(Date.now() - Date.parse(view.cached_at)).toBeLessThan(5000);
  });
});
