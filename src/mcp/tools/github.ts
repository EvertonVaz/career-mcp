import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../../config.js';
import {
  createGithub,
  fetchRepo,
  fetchRepos,
  writeRepoCache,
  type Repo,
} from '../../lib/github.js';
import { diffCareer, snapshotBeforeWrite, type Change } from '../../lib/history.js';
import { loadCareer, saveCareer } from '../../lib/loader.js';
import { Project as ProjectSchema, type Career } from '../../lib/schema.js';

type Project = Career['projects'][number];

type Proposal = {
  repo: string;
  project_id: string;
  name: string;
  description: string | null;
  stack: string[];
  links: { repo: string; demo?: string };
};

type FieldDivergence = {
  field: string;
  career: string | string[] | null;
  github: string | string[] | null;
};

type Divergence = FieldDivergence & { repo: string; project_id: string };

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
function findDivergences(project: Project, repo: Repo): FieldDivergence[] {
  const divergences: FieldDivergence[] = [];

  if (project.links.repo !== repo.html_url) {
    divergences.push({
      field: 'links.repo',
      career: project.links.repo ?? null,
      github: repo.html_url,
    });
  }

  const demo = homepageOf(repo);
  if (demo !== undefined && project.links.demo !== demo) {
    divergences.push({ field: 'links.demo', career: project.links.demo ?? null, github: demo });
  }

  if (!hasLanguage(project, repo)) {
    divergences.push({ field: 'stack', career: project.stack, github: repo.language });
  }

  return divergences;
}

function hasLanguage(project: Project, repo: Repo): boolean {
  const language = repo.language;
  if (language === null) return true;

  return project.stack.some((item) => item.toLowerCase() === language.toLowerCase());
}

/**
 * O GitHub manda nos metadados do repo (link, linguagem). O texto — problem,
 * solution, result — é seu e não é tocado. stack só cresce: remover o que você
 * curou à mão porque o GitHub só reporta a linguagem principal seria perda.
 */
function mergeProject(existing: Project, repo: Repo, syncedAt: string, name?: string): Project {
  const demo = homepageOf(repo) ?? existing.links.demo;

  return {
    ...existing,
    ...(name === undefined ? {} : { name }),
    github_repo: repo.full_name,
    stack: hasLanguage(existing, repo)
      ? existing.stack
      : [...existing.stack, repo.language as string],
    links: {
      ...existing.links,
      repo: repo.html_url,
      ...(demo === undefined ? {} : { demo }),
    },
    provenance: {
      ...existing.provenance,
      source_ref: `github:${repo.full_name}`,
      last_synced_at: syncedAt,
    },
  };
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

const fieldDivergenceShape = z.object({
  field: z.string(),
  career: divergenceValue,
  github: divergenceValue,
});

const divergenceShape = fieldDivergenceShape.extend({
  repo: z.string(),
  project_id: z.string(),
});

const changeShape = z.looseObject({ path: z.string(), kind: z.string() });

function requireToken(config: Config): string {
  if (config.githubToken === undefined || config.githubToken === '') {
    throw new Error('GITHUB_TOKEN não configurado — defina no .env antes de sincronizar.');
  }
  return config.githubToken;
}

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
        changes: z.array(changeShape).optional(),
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
      const octokit = createGithub(requireToken(config), config.githubApiUrl);
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
        else {
          divergences.push(
            ...findDivergences(existing, repo).map((item) => ({
              ...item,
              repo: repo.full_name,
              project_id: existing.id,
            })),
          );
        }
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

  server.registerTool(
    'import_github_repo',
    {
      title: 'Importar um repositório do GitHub',
      description: `Importa um repositório específico como projeto, pelo full_name.

Diferente do sync_github, aqui o repo é escolhido por você: fork e arquivado
entram normalmente.

Se o projeto ainda não existe (mode: "create"), cria a partir do repo.
Se já existe (mode: "update"), sobrescreve os campos que são do GitHub e
lista em divergences[] o que mudou:
  - links.repo recebe a URL do repo
  - links.demo recebe a homepage, se houver (homepage vazia não apaga a sua)
  - stack ganha a linguagem principal, sem perder o que você curou à mão
Seu texto — problem, solution, result — nunca é tocado, e provenance.verified
continua como estava.

Sem confirm não escreve: devolve divergences[] e o projeto como ficaria.
Com confirm: true, tira snapshot em history/ e grava. Se nada mudaria, não
escreve nem versiona.

asProject: { id, name } ajusta como o projeto entra. O id só vale na criação e
falha se colidir com projeto existente.`,
      inputSchema: {
        repo: z.string().min(1).describe('full_name do repositório, ex: "etovaz/career-mcp".'),
        asProject: z
          .object({
            id: z.string().min(1).optional().describe('Id do projeto. Só na criação.'),
            name: z.string().min(1).optional().describe('Nome do projeto no portfólio.'),
          })
          .optional(),
        confirm: z
          .boolean()
          .default(false)
          .describe('true grava no career.yml. false só devolve o que faria.'),
      },
      outputSchema: {
        applied: z.boolean(),
        mode: z.enum(['create', 'update']),
        repo: z.string(),
        project_id: z.string(),
        divergences: z.array(fieldDivergenceShape),
        project: ProjectSchema,
        changes: z.array(changeShape).optional(),
      },
      annotations: {
        readOnlyHint: false,
        // Em update sobrescreve campo já gravado, e isso não é reversível
        // sem o history/.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ repo: fullName, asProject, confirm }) => {
      const octokit = createGithub(requireToken(config), config.githubApiUrl);
      const repo = await fetchRepo(octokit, fullName);
      const syncedAt = new Date().toISOString();

      const career = await loadCareer(config.paths.career);
      const existing = career.projects.find((project) => project.github_repo === repo.full_name);

      let project: Project;
      let divergences: FieldDivergence[] = [];

      if (existing === undefined) {
        const taken = new Set(career.projects.map((item) => item.id));
        const wanted = asProject?.id;

        if (wanted !== undefined && taken.has(wanted)) {
          throw new Error(`Já existe projeto com id "${wanted}" — escolha outro id.`);
        }

        project = toProject(
          {
            ...toProposal(repo, taken),
            ...(wanted === undefined ? {} : { project_id: wanted }),
            ...(asProject?.name === undefined ? {} : { name: asProject.name }),
          },
          syncedAt,
        );
      } else {
        if (asProject?.id !== undefined && asProject.id !== existing.id) {
          throw new Error(
            `${repo.full_name} já é o projeto "${existing.id}" — renomear id quebraria as evidências que apontam para ele.`,
          );
        }
        divergences = findDivergences(existing, repo);
        project = mergeProject(existing, repo, syncedAt, asProject?.name);
      }

      const mode = existing === undefined ? ('create' as const) : ('update' as const);
      const base = { applied: false, mode, repo: repo.full_name, project_id: project.id, divergences, project };

      if (!confirm) return respond(base);

      const after: Career = {
        ...career,
        projects:
          existing === undefined
            ? [...career.projects, project]
            : career.projects.map((item) => (item.id === project.id ? project : item)),
      };
      const changes: Change[] = diffCareer(career, after);
      if (changes.length === 0) return respond({ ...base, applied: true, changes });

      // Carimbo de sync sozinho não vira snapshot: history serve para recuperar
      // conteúdo, e não há conteúdo a recuperar de um last_synced_at.
      const substantive = changes.filter(
        (change) => !change.path.endsWith('.provenance.last_synced_at'),
      );
      if (substantive.length > 0) {
        await snapshotBeforeWrite(config.paths.history, config.paths.career, changes);
      }

      await saveCareer(config.paths.career, after);

      return respond({ ...base, applied: true, changes });
    },
  );
}

function respond<T>(payload: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}
