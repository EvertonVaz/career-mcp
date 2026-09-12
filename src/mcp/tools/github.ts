import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { createGithub, fetchRepos, writeRepoCache, type Repo } from '../../lib/github.js';
import { diffCareer, snapshotBeforeWrite, type Change } from '../../lib/history.js';
import { loadCareer, saveCareer } from '../../lib/loader.js';
import type { Career } from '../../lib/schema.js';

type Project = Career['projects'][number];

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
  career: string | string[] | null;
  github: string | string[] | null;
};

/** Nome de repo vira id kebab-case: "Meu.App_2025" -> "meu-app-2025". */
function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug === '' ? 'repo' : slug;
}

/** Dois repos podem gerar o mesmo slug; id duplicado o schema recusa. */
function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (taken.has(id)) id = `${base}-${suffix++}`;

  taken.add(id);
  return id;
}

function homepageOf(repo: Repo): string | undefined {
  const homepage = repo.homepage?.trim();
  return homepage === undefined || homepage === '' ? undefined : homepage;
}

function toProposal(repo: Repo, taken: Set<string>): Proposal {
  const demo = homepageOf(repo);

  return {
    repo: repo.full_name,
    project_id: uniqueId(slugify(repo.name), taken),
    name: repo.name,
    description: repo.description,
    stack: repo.language === null ? [] : [repo.language],
    links: { repo: repo.html_url, ...(demo === undefined ? {} : { demo }) },
  };
}

/**
 * problem, solution e result ficam de fora de propósito: o GitHub não sabe
 * disso e inventar seria o oposto do ponto do projeto. O validate_all cobra.
 */
function toProject(proposal: Proposal, syncedAt: string): Project {
  return {
    id: proposal.project_id,
    name: proposal.name,
    github_repo: proposal.repo,
    stack: proposal.stack,
    links: proposal.links,
    images: [],
    highlight: false,
    provenance: {
      verified: false,
      source: 'github',
      source_ref: `github:${proposal.repo}`,
      last_synced_at: syncedAt,
    },
  };
}

/**
 * Para projeto que já existe, o GitHub não propõe escrita — o texto que você
 * escreveu vale mais que os metadados do repo. Só aponta o desencontro.
 */
function findDivergences(project: Project, repo: Repo): Divergence[] {
  const base = { repo: repo.full_name, project_id: project.id };
  const divergences: Divergence[] = [];

  if (project.links.repo !== repo.html_url) {
    divergences.push({
      ...base,
      field: 'links.repo',
      career: project.links.repo ?? null,
      github: repo.html_url,
    });
  }

  const demo = homepageOf(repo);
  if (demo !== undefined && project.links.demo !== demo) {
    divergences.push({
      ...base,
      field: 'links.demo',
      career: project.links.demo ?? null,
      github: demo,
    });
  }

  const language = repo.language;
  if (language !== null && !project.stack.some((item) => item.toLowerCase() === language.toLowerCase())) {
    divergences.push({ ...base, field: 'stack', career: project.stack, github: language });
  }

  return divergences;
}

const proposalShape = z.object({
  repo: z.string(),
  project_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  stack: z.array(z.string()),
  links: z.object({ repo: z.string(), demo: z.string().optional() }),
});

const divergenceValue = z.union([z.string(), z.array(z.string()), z.null()]);

const divergenceShape = z.object({
  repo: z.string(),
  project_id: z.string(),
  field: z.string(),
  career: divergenceValue,
  github: divergenceValue,
});

export function registerGithubTools(server: McpServer, config: Config): void {
  server.registerTool(
    'sync_github',
    {
      title: 'Sincronizar com o GitHub',
      description: `Compara seus repositórios do GitHub com o career.yml.

Sem confirm, não escreve nada: devolve o que faria.
  - proposals[]: repos que ainda não existem como projeto
  - divergences[]: projetos que já existem e destoam do repo (link, stack).
    Não viram proposta de escrita — o que você escreveu vale mais que o
    metadado do repo. Corrija à mão se concordar.

Com confirm: true, tira snapshot em history/ e grava as propostas como
projetos novos, sempre com provenance.verified = false. Use accept para
escolher quais: accept: ["etovaz/repo-a"]. Sem accept, aplica todas.

Nunca preenche problem, solution nem result — o GitHub não sabe disso.

Filtros: since (data ISO, corta por último push), includeForks,
includeArchived. Por padrão ignora fork e arquivado.`,
      inputSchema: {
        since: z.string().optional().describe('Data ISO; só repos com push a partir dela.'),
        includeForks: z.boolean().default(false).describe('Incluir repos que são fork.'),
        includeArchived: z.boolean().default(false).describe('Incluir repos arquivados.'),
        confirm: z
          .boolean()
          .default(false)
          .describe('true grava no career.yml. false só devolve as propostas.'),
        accept: z
          .array(z.string().min(1))
          .optional()
          .describe('full_name dos repos a aplicar, ex: ["etovaz/career-mcp"]. Vazio = todos.'),
      },
      outputSchema: {
        applied: z.boolean(),
        synced_at: z.string(),
        scanned: z.number().int(),
        proposals: z.array(proposalShape),
        divergences: z.array(divergenceShape),
        added: z.array(z.string()).optional(),
        changes: z.array(z.looseObject({ path: z.string(), kind: z.string() })).optional(),
      },
      annotations: {
        readOnlyHint: false,
        // Só adiciona projeto novo; nunca sobrescreve o que já existe.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ since, includeForks, includeArchived, confirm, accept }) => {
      if (config.githubToken === undefined || config.githubToken === '') {
        throw new Error('GITHUB_TOKEN não configurado — defina no .env antes de sincronizar.');
      }

      const octokit = createGithub(config.githubToken, config.githubApiUrl);
      const repos = await fetchRepos(octokit, { since, includeForks, includeArchived });
      const { synced_at } = await writeRepoCache(config.paths.cache, repos);

      const career = await loadCareer(config.paths.career);
      const byRepo = new Map(
        career.projects
          .filter((project) => project.github_repo !== undefined)
          .map((project) => [project.github_repo as string, project]),
      );
      const taken = new Set(career.projects.map((project) => project.id));

      const proposals: Proposal[] = [];
      const divergences: Divergence[] = [];

      for (const repo of repos) {
        const existing = byRepo.get(repo.full_name);
        if (existing === undefined) proposals.push(toProposal(repo, taken));
        else divergences.push(...findDivergences(existing, repo));
      }

      const base = { applied: false, synced_at, scanned: repos.length, proposals, divergences };

      if (!confirm) return respond(base);

      const chosen =
        accept === undefined
          ? proposals
          : proposals.filter((proposal) => accept.includes(proposal.repo));

      if (chosen.length === 0) {
        return respond({ ...base, applied: true, added: [], changes: [] });
      }

      const after: Career = {
        ...career,
        projects: [...career.projects, ...chosen.map((p) => toProject(p, synced_at))],
      };
      const changes: Change[] = diffCareer(career, after);

      await snapshotBeforeWrite(config.paths.history, config.paths.career, changes);
      await saveCareer(config.paths.career, after);

      return respond({
        ...base,
        applied: true,
        added: chosen.map((proposal) => proposal.project_id),
        changes,
      });
    },
  );
}

function respond<T>(payload: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}
