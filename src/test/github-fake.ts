import { createServer, type Server } from 'node:http';

/** Só os campos que o wrapper lê; o resto do payload do GitHub é ruído. */
export type FakeRepo = {
  name: string;
  fork?: boolean;
  archived?: boolean;
  pushed_at?: string;
  language?: string | null;
  topics?: string[];
  description?: string | null;
  homepage?: string | null;
  stargazers_count?: number;
};

export type FakeGithub = {
  baseUrl: string;
  /** Requisições recebidas, para checar token e query string. */
  requests: { method: string; path: string; search: string; authorization?: string }[];
  setRepos(repos: FakeRepo[]): void;
  setLanguages(fullName: string, languages: Record<string, number>): void;
  failWith(status: number, body?: unknown): void;
  /** Teto de itens por página, como o cap de 100 do GitHub. */
  setPageSize(size: number): void;
  /** Zera repos, falha programada e requisições registradas. */
  reset(): void;
  close(): Promise<void>;
};

function expand(repo: FakeRepo): Record<string, unknown> {
  const full_name = `etovaz/${repo.name}`;

  return {
    id: 1,
    node_id: 'MDEwOlJlcG9zaXRvcnk=',
    name: repo.name,
    full_name,
    private: false,
    owner: { login: 'etovaz', id: 1 },
    html_url: `https://github.com/${full_name}`,
    description: repo.description ?? null,
    homepage: repo.homepage ?? null,
    language: repo.language ?? null,
    topics: repo.topics ?? [],
    fork: repo.fork ?? false,
    archived: repo.archived ?? false,
    pushed_at: repo.pushed_at ?? '2026-09-01T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
    stargazers_count: repo.stargazers_count ?? 0,
    forks_count: 0,
    watchers_count: 0,
    default_branch: 'main',
  };
}

/** Servidor HTTP local no formato da API do GitHub, incluindo paginação. */
export async function startFakeGithub(): Promise<FakeGithub> {
  let repos: FakeRepo[] = [];
  let pageSize = 100;
  const languages = new Map<string, Record<string, number>>();
  let failure: { status: number; body: unknown } | null = null;
  const requests: FakeGithub['requests'] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      search: url.search,
      authorization: req.headers.authorization,
    });

    res.setHeader('content-type', 'application/json');

    if (failure) {
      res.statusCode = failure.status;
      res.end(JSON.stringify(failure.body));
      return;
    }

    if (url.pathname === '/user/repos') {
      const perPage = Math.min(Number(url.searchParams.get('per_page') ?? '30'), pageSize);
      const page = Number(url.searchParams.get('page') ?? '1');
      const slice = repos.slice((page - 1) * perPage, page * perPage);

      if (page * perPage < repos.length) {
        const { port } = server.address() as { port: number };
        res.setHeader(
          'link',
          `<http://127.0.0.1:${port}/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`,
        );
      }
      res.end(JSON.stringify(slice.map(expand)));
      return;
    }

    const match = /^\/repos\/([^/]+\/[^/]+)\/languages$/.exec(url.pathname);
    if (match) {
      res.end(JSON.stringify(languages.get(match[1] as string) ?? {}));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'Not Found' }));
  });

  server.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setRepos: (next) => {
      repos = next;
    },
    setLanguages: (fullName, next) => languages.set(fullName, next),
    failWith: (status, body = { message: 'erro' }) => {
      failure = { status, body };
    },
    setPageSize: (size) => {
      pageSize = size;
    },
    reset: () => {
      repos = [];
      pageSize = 100;
      languages.clear();
      failure = null;
      requests.length = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
