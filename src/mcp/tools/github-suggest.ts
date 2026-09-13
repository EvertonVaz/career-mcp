import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { createGithub, fetchLanguages, fetchRepos } from '../../lib/github.js';
import { diffCareer, snapshotBeforeWrite, type Change } from '../../lib/history.js';
import { loadCareer, saveCareer, withCareerLock } from '../../lib/loader.js';
import type { Career } from '../../lib/schema.js';

type Skill = Career['skills'][number];

type Suggestion = {
  name: string;
  category: 'language';
  repos: string[];
  bytes: number;
  evidence: { type: 'repo'; ref: string }[];
};

export function registerGithubSuggestTools(
  server: McpServer,
  config: Config,
  requireToken: (config: Config) => string,
): void {
  server.registerTool(
    'suggest_skills_from_github',
    {
      title: 'Sugerir skills a partir do GitHub',
      description: `Lê as linguagens dos seus repositórios e propõe as que ainda não
estão em skills[].

Cada sugestão vem com evidence apontando para os repos que a sustentam, e com
bytes e repos[] para você julgar se é skill de verdade ou um arquivo solto.

Só linguagens detectadas pelo GitHub — topics não entram, porque virariam
palpite sobre categoria.

Sem confirm não escreve. Com confirm: true, tira snapshot em history/ e grava
como category "language" e provenance.verified = false. Use accept para
escolher: accept: ["Go"]. Sem accept, aplica todas as sugestões listadas.

Filtros: since, includeForks, includeArchived (mesma semântica do
sync_github), minRepos (mínimo de repos por linguagem) e limit.`,
      inputSchema: {
        since: z.string().optional().describe('Data ISO; só repos com push a partir dela.'),
        includeForks: z.boolean().default(false),
        includeArchived: z.boolean().default(false),
        minRepos: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe('Quantos repos a linguagem precisa aparecer para ser sugerida.'),
        limit: z.number().int().min(1).max(100).default(20),
        confirm: z.boolean().default(false).describe('true grava as sugestões no career.yml.'),
        accept: z
          .array(z.string().min(1))
          .optional()
          .describe('Nomes das linguagens a aplicar. Vazio = todas as listadas.'),
      },
      outputSchema: {
        applied: z.boolean(),
        scanned: z.number().int(),
        suggestions: z.array(
          z.object({
            name: z.string(),
            category: z.literal('language'),
            repos: z.array(z.string()),
            bytes: z.number().int(),
            evidence: z.array(z.object({ type: z.literal('repo'), ref: z.string() })),
          }),
        ),
        added: z.array(z.string()).optional(),
        changes: z.array(z.looseObject({ path: z.string(), kind: z.string() })).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ since, includeForks, includeArchived, minRepos, limit, confirm, accept }) => {
      const octokit = createGithub(requireToken(config), config.githubApiUrl);
      const repos = await fetchRepos(octokit, { since, includeForks, includeArchived });

      const totals = new Map<string, { name: string; repos: string[]; bytes: number }>();

      for (const repo of repos) {
        const languages = await fetchLanguages(octokit, repo.full_name);

        for (const [name, bytes] of Object.entries(languages)) {
          const key = name.toLowerCase();
          const entry = totals.get(key) ?? { name, repos: [], bytes: 0 };
          entry.repos.push(repo.full_name);
          entry.bytes += bytes;
          totals.set(key, entry);
        }
      }

      return withCareerLock(config.paths.career, async () => {
        const career = await loadCareer(config.paths.career);
        const known = new Set(career.skills.map((skill) => skill.name.toLowerCase()));

        const suggestions: Suggestion[] = [...totals.entries()]
          .filter(([key, entry]) => !known.has(key) && entry.repos.length >= minRepos)
          .map(([, entry]) => ({
            name: entry.name,
            category: 'language' as const,
            repos: entry.repos,
            bytes: entry.bytes,
            evidence: entry.repos.map((ref) => ({ type: 'repo' as const, ref })),
          }))
          // Mais repos vence mais bytes: linguagem usada em três projetos diz
          // mais que um arquivo gigante gerado num só.
          .sort((a, b) => b.repos.length - a.repos.length || b.bytes - a.bytes)
          .slice(0, limit);

        const base = { applied: false, scanned: repos.length, suggestions };
        if (!confirm) return respond(base);

        const chosen =
          accept === undefined
            ? suggestions
            : suggestions.filter((suggestion) =>
                accept.some((name) => name.toLowerCase() === suggestion.name.toLowerCase()),
              );

        if (chosen.length === 0) return respond({ ...base, applied: true, added: [], changes: [] });

        const novas: Skill[] = chosen.map((suggestion) => ({
          name: suggestion.name,
          category: 'language',
          evidence: suggestion.evidence,
          provenance: {
            verified: false,
            source: 'github',
            source_ref: suggestion.repos.map((repo) => `github:${repo}`).join(', '),
            last_synced_at: new Date().toISOString(),
          },
        }));

        const after: Career = { ...career, skills: [...career.skills, ...novas] };
        const changes: Change[] = diffCareer(career, after);

        await snapshotBeforeWrite(config.paths.history, config.paths.career, changes);
        await saveCareer(config.paths.career, after);

        return respond({
          ...base,
          applied: true,
          added: chosen.map((suggestion) => suggestion.name),
          changes,
        });
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
