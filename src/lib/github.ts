import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Octokit } from 'octokit';

/** Subconjunto do repo que vira evidência. O payload do GitHub é enorme. */
export type Repo = {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  homepage: string | null;
  language: string | null;
  topics: string[];
  fork: boolean;
  archived: boolean;
  pushed_at: string;
  stargazers_count: number;
};

export type RepoFilter = {
  /** Data ISO; só repos com push a partir dela. */
  since?: string;
  includeForks?: boolean;
  includeArchived?: boolean;
};

export type RepoCache = {
  synced_at: string;
  repos: Repo[];
};

const CACHE_FILE = 'github-repos.json';

export function createGithub(token: string, baseUrl?: string): Octokit {
  return new Octokit({ auth: token, ...(baseUrl === undefined ? {} : { baseUrl }) });
}

type RawRepo = {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  homepage?: string | null;
  language?: string | null;
  topics?: string[];
  fork: boolean;
  archived?: boolean;
  pushed_at?: string | null;
  stargazers_count?: number;
};

function toRepo(raw: RawRepo): Repo {
  return {
    name: raw.name,
    full_name: raw.full_name,
    description: raw.description,
    html_url: raw.html_url,
    homepage: raw.homepage ?? null,
    language: raw.language ?? null,
    topics: raw.topics ?? [],
    fork: raw.fork,
    archived: raw.archived ?? false,
    pushed_at: raw.pushed_at ?? '',
    stargazers_count: raw.stargazers_count ?? 0,
  };
}

function hasStatus(error: unknown): error is { status: number; message: string } {
  return typeof error === 'object' && error !== null && 'status' in error;
}

/**
 * Traduz o erro do Octokit para algo acionável. O erro cru não diz o que
 * fazer, e a mensagem vai parar na resposta de uma tool.
 */
function describe(error: unknown): Error {
  if (!hasStatus(error)) return error instanceof Error ? error : new Error(String(error));

  if (error.status === 401) {
    return new Error('GITHUB_TOKEN inválido ou expirado — gere um novo PAT e atualize o .env.');
  }
  if (error.status === 403) {
    return new Error(`GitHub recusou: rate limit ou escopo insuficiente (${error.message})`);
  }
  if (error.status === 404) {
    return new Error(`Não encontrado no GitHub (${error.message})`);
  }
  return new Error(`GitHub respondeu ${error.status}: ${error.message}`);
}

export async function fetchRepos(octokit: Octokit, filter: RepoFilter = {}): Promise<Repo[]> {
  let raw: RawRepo[];

  try {
    raw = (await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
      per_page: 100,
      sort: 'pushed',
    })) as RawRepo[];
  } catch (error) {
    throw describe(error);
  }

  const since = filter.since === undefined ? null : Date.parse(filter.since);

  return raw.map(toRepo).filter((repo) => {
    if (!filter.includeForks && repo.fork) return false;
    if (!filter.includeArchived && repo.archived) return false;
    if (since !== null && Date.parse(repo.pushed_at) < since) return false;
    return true;
  });
}

export async function fetchLanguages(
  octokit: Octokit,
  fullName: string,
): Promise<Record<string, number>> {
  const [owner, repo] = fullName.split('/');
  if (owner === undefined || repo === undefined) throw new Error(`Repo inválido: "${fullName}"`);

  try {
    const { data } = await octokit.rest.repos.listLanguages({ owner, repo });
    return data;
  } catch (error) {
    throw describe(error);
  }
}

/** O cache é descartável: perder é só rodar sync_github de novo. */
export async function writeRepoCache(cacheDir: string, repos: Repo[]): Promise<RepoCache> {
  const cache: RepoCache = { synced_at: new Date().toISOString(), repos };

  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, CACHE_FILE), `${JSON.stringify(cache, null, 2)}\n`);

  return cache;
}

export async function readRepoCache(cacheDir: string): Promise<RepoCache | null> {
  try {
    return JSON.parse(await readFile(path.join(cacheDir, CACHE_FILE), 'utf8')) as RepoCache;
  } catch {
    // Sem cache ainda, ou cache corrompido: nos dois casos é rodar sync de novo.
    return null;
  }
}
