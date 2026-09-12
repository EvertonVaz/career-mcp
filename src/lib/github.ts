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

export type CommitDates = {
  /** Datas ISO em ordem crescente. */
  dates: string[];
  /** true quando bateu no teto de páginas: a lista é parcial, a mais recente. */
  capped: boolean;
};

const CACHE_FILE = 'github-repos.json';
const ACTIVITY_FILE = 'github-activity.json';

/** Teto de páginas ao contar commits. 300 já responde "foi relevante?". */
const MAX_COMMIT_PAGES = 3;

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

export async function fetchRepo(octokit: Octokit, fullName: string): Promise<Repo> {
  const [owner, repo] = fullName.split('/');
  if (owner === undefined || repo === undefined || repo === '') {
    throw new Error(`Repo inválido: "${fullName}" — use o formato "owner/repo".`);
  }

  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return toRepo(data as unknown as RawRepo);
  } catch (error) {
    throw describe(error);
  }
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

export async function fetchLogin(octokit: Octokit): Promise<string> {
  try {
    const { data } = await octokit.rest.users.getAuthenticated();
    return data.login;
  } catch (error) {
    throw describe(error);
  }
}

type RawCommit = { commit?: { author?: { date?: string | null } | null } | null };

/**
 * Conta commits do autor numa janela. Para ao bater MAX_COMMIT_PAGES: repo
 * com milhares de commits custaria dezenas de requisições para responder algo
 * que 300 já responde.
 */
export async function fetchCommitDates(
  octokit: Octokit,
  fullName: string,
  window: { author: string; since: string; until: string },
): Promise<CommitDates> {
  const [owner, repo] = fullName.split('/');
  if (owner === undefined || repo === undefined) {
    throw new Error(`Repo inválido: "${fullName}" — use o formato "owner/repo".`);
  }

  const dates: string[] = [];
  let pages = 0;
  let capped = false;

  try {
    const iterator = octokit.paginate.iterator(octokit.rest.repos.listCommits, {
      owner,
      repo,
      author: window.author,
      since: window.since,
      until: window.until,
      per_page: 100,
    });

    for await (const { data } of iterator) {
      for (const commit of data as RawCommit[]) {
        const date = commit.commit?.author?.date;
        if (typeof date === 'string') dates.push(date);
      }

      if (++pages >= MAX_COMMIT_PAGES) {
        capped = data.length === 100;
        break;
      }
    }
  } catch (error) {
    throw describe(error);
  }

  dates.sort();

  return { dates, capped };
}

/** O cache é descartável: perder é só rodar sync_github de novo. */
export async function writeRepoCache(cacheDir: string, repos: Repo[]): Promise<RepoCache> {
  const cache: RepoCache = { synced_at: new Date().toISOString(), repos };

  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, CACHE_FILE), `${JSON.stringify(cache, null, 2)}\n`);

  return cache;
}

export async function readRepoCache(cacheDir: string): Promise<RepoCache | null> {
  return readJson<RepoCache>(path.join(cacheDir, CACHE_FILE));
}

export async function writeActivityCache<T>(cacheDir: string, report: T): Promise<string> {
  const cached_at = new Date().toISOString();

  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    path.join(cacheDir, ACTIVITY_FILE),
    `${JSON.stringify({ cached_at, ...report }, null, 2)}\n`,
  );

  return cached_at;
}

export async function readActivityCache<T>(cacheDir: string): Promise<T | null> {
  return readJson<T>(path.join(cacheDir, ACTIVITY_FILE));
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    // Sem cache ainda, ou cache corrompido: nos dois casos é rodar sync de novo.
    return null;
  }
}
