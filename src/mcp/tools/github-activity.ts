import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../../config.js';
import {
  createGithub,
  fetchCommitDates,
  fetchLogin,
  fetchRepos,
  writeActivityCache,
  type Repo,
} from '../../lib/github.js';
import { loadCareer } from '../../lib/loader.js';
import { toIsoDate, type Career } from '../../lib/schema.js';

type Experience = Career['experiences'][number];

type Candidate = {
  repo: string;
  commits: number;
  first_commit: string | null;
  last_commit: string | null;
  language: string | null;
  capped: boolean;
  /** Rascunho factual. Descreve atividade, não impacto. */
  suggested_bullet: string;
  evidence: { type: 'repo'; ref: string };
};

const NEEDS_HUMAN =
  'suggested_bullet é rascunho: descreve atividade (repo, linguagem, volume, período), não impacto. Revise e reescreva antes de usar — o GitHub não sabe o que você resolveu.';

/** "2023-03-01T10:00:00Z" -> "03/2023". */
function monthYear(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

/**
 * Monta a frase só com o que a evidência sustenta. Nada de verbo de impacto
 * ("reduziu", "liderou"): isso o GitHub não sabe e seria invenção.
 */
function suggestBullet(repo: Repo, dates: string[], capped: boolean): string {
  const first = dates[0] as string;
  const last = dates[dates.length - 1] as string;

  const volume = capped
    ? `${dates.length}+ commits`
    : `${dates.length} commit${dates.length === 1 ? '' : 's'}`;

  const period =
    monthYear(first) === monthYear(last)
      ? `em ${monthYear(first)}`
      : `entre ${monthYear(first)} e ${monthYear(last)}`;

  const what =
    repo.language === null
      ? `Contribuições no repositório ${repo.full_name}`
      : `Desenvolvimento em ${repo.language} no repositório ${repo.full_name}`;

  return `${what} — ${volume} ${period}.`;
}

function toCandidate(repo: Repo, dates: string[], capped: boolean): Candidate {
  return {
    repo: repo.full_name,
    commits: dates.length,
    first_commit: dates[0] ?? null,
    last_commit: dates[dates.length - 1] ?? null,
    language: repo.language,
    capped,
    suggested_bullet: suggestBullet(repo, dates, capped),
    evidence: { type: 'repo', ref: repo.full_name },
  };
}

function within(dates: string[], window: { since: string; until: string }): string[] {
  return dates.filter((date) => date >= window.since && date <= window.until);
}

/** Janela da experiência em ISO. Sem end, vale até agora. */
function windowOf(experience: Experience): { since: string; until: string } {
  return {
    since: `${toIsoDate(experience.start)}T00:00:00Z`,
    until:
      experience.end === null
        ? new Date().toISOString()
        : `${toIsoDate(experience.end)}T23:59:59Z`,
  };
}

function periodOf(experience: Experience): string {
  return `${experience.start} – ${experience.end ?? 'atual'}`;
}

const candidateShape = z.object({
  repo: z.string(),
  commits: z.number().int(),
  first_commit: z.string().nullable(),
  last_commit: z.string().nullable(),
  language: z.string().nullable(),
  capped: z.boolean(),
  suggested_bullet: z.string(),
  evidence: z.object({ type: z.literal('repo'), ref: z.string() }),
});

export function registerGithubActivityTool(
  server: McpServer,
  config: Config,
  requireToken: (config: Config) => string,
): void {
  server.registerTool(
    'suggest_experience_from_activity',
    {
      title: 'Cruzar atividade do GitHub com as experiências',
      description: `Para cada experiência do career.yml, acha os repositórios em que você
commitou dentro daquela janela de datas.

Cada candidato vem com suggested_bullet: um rascunho montado só com o que a
evidência sustenta — repo, linguagem, volume de commits e período. É descrição
de atividade, não de impacto, e precisa ser reescrito antes de entrar no
currículo. O GitHub sabe quanto e quando, não sabe o que você resolveu.

Retorna:
  - experiences[]: cada uma com candidates[] ordenados por volume de commits
  - orphan_repos[]: repos em que você commitou e que nenhuma experiência cobre.
    Pode ser experiência faltando no career.yml, ou projeto pessoal.
  - capped: true quando a contagem bateu no teto de 300 commits por repo;
    aí commits é piso, não total.

Parâmetros: experienceId (limita a uma experiência), minCommits (padrão 1),
limit (candidates por experiência), since/includeForks/includeArchived
(mesma semântica do sync_github).

Não escreve no career.yml: os bullets voltam como sugestão. O relatório fica
em github://activity.`,
      inputSchema: {
        experienceId: z.string().min(1).optional().describe('Id da experiência a analisar.'),
        minCommits: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe('Commits mínimos para o repo ser considerado.'),
        limit: z.number().int().min(1).max(100).default(20),
        since: z.string().optional(),
        includeForks: z.boolean().default(false),
        includeArchived: z.boolean().default(false),
      },
      outputSchema: {
        scanned_repos: z.number().int(),
        experiences: z.array(
          z.object({
            experience_id: z.string(),
            company: z.string(),
            role: z.string(),
            period: z.string(),
            candidates: z.array(candidateShape),
          }),
        ),
        orphan_repos: z.array(candidateShape),
        needs_human_input: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ experienceId, minCommits, limit, since, includeForks, includeArchived }) => {
      const career = await loadCareer(config.paths.career);

      if (experienceId !== undefined && !career.experiences.some((e) => e.id === experienceId)) {
        throw new Error(`Experiência "${experienceId}" não existe no career.yml.`);
      }

      const octokit = createGithub(requireToken(config), config.githubApiUrl);
      const login = await fetchLogin(octokit);
      const repos = await fetchRepos(octokit, { since, includeForks, includeArchived });

      // Uma chamada por repo, não por repo × experiência: as janelas são
      // recortadas em memória depois.
      const history = new Map(
        await Promise.all(
          repos.map(
            async (repo) =>
              [
                repo.full_name,
                await fetchCommitDates(octokit, repo.full_name, {
                  author: login,
                  since: '1970-01-01T00:00:00Z',
                  until: new Date().toISOString(),
                }),
              ] as const,
          ),
        ),
      );

      const covered = new Set<string>();

      const buildCandidates = (window: { since: string; until: string }): Candidate[] =>
        repos
          .map((repo) => {
            const commits = history.get(repo.full_name);
            if (commits === undefined) return null;

            const dates = within(commits.dates, window);
            return dates.length === 0 ? null : toCandidate(repo, dates, commits.capped);
          })
          .filter((candidate): candidate is Candidate => candidate !== null)
          .sort((a, b) => b.commits - a.commits);

      // covered é medido contra TODAS as experiências, mesmo quando o relatório
      // foi filtrado por experienceId — senão "órfão" mentiria.
      for (const experience of career.experiences) {
        for (const candidate of buildCandidates(windowOf(experience))) {
          covered.add(candidate.repo);
        }
      }

      const experiences = career.experiences
        .filter((experience) => experienceId === undefined || experience.id === experienceId)
        .map((experience) => ({
          experience_id: experience.id,
          company: experience.company,
          role: experience.role,
          period: periodOf(experience),
          candidates: buildCandidates(windowOf(experience))
            .filter((candidate) => candidate.commits >= minCommits)
            .slice(0, limit),
        }));

      const orphan_repos = repos
        .filter((repo) => !covered.has(repo.full_name))
        .map((repo) => {
          const commits = history.get(repo.full_name);
          return commits === undefined || commits.dates.length === 0
            ? null
            : toCandidate(repo, commits.dates, commits.capped);
        })
        .filter((candidate): candidate is Candidate => candidate !== null)
        .filter((candidate) => candidate.commits >= minCommits)
        .sort((a, b) => b.commits - a.commits);

      const report = {
        scanned_repos: repos.length,
        experiences,
        orphan_repos,
        needs_human_input: NEEDS_HUMAN,
      };

      await writeActivityCache(config.paths.cache, report);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
        structuredContent: report,
      };
    },
  );
}
