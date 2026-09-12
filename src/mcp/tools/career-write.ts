import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { diffCareer, snapshotBeforeWrite, type Change } from '../../lib/history.js';
import { loadCareer, saveCareer } from '../../lib/loader.js';
import { BrDate, Id, type Career } from '../../lib/schema.js';

type Experience = Career['experiences'][number];

/**
 * Todo write passa por aqui: carrega, aplica a mutação, calcula o diff e só
 * então decide escrever. Sem confirm, para no diff — é o preview.
 */
async function runWrite(
  config: Config,
  confirm: boolean,
  mutate: (career: Career) => Career,
): Promise<{ applied: boolean; changes: Change[] }> {
  const career = await loadCareer(config.paths.career);
  const after = mutate(career);
  const changes = diffCareer(career, after);

  if (!confirm || changes.length === 0) return { applied: false, changes };

  await snapshotBeforeWrite(config.paths.history, config.paths.career, changes);
  await saveCareer(config.paths.career, after);

  return { applied: true, changes };
}

function respond(result: { applied: boolean; changes: Change[] }) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
}

const WRITE_OUTPUT = {
  applied: z.boolean(),
  changes: z.array(z.looseObject({ path: z.string(), kind: z.string() })),
};

const confirmInput = z
  .boolean()
  .default(false)
  .describe('true grava no career.yml. false devolve só o diff do que faria.');

/** Campos de experiência que você controla; provenance é do servidor. */
const experienceFields = {
  company: z.string().min(1),
  role: z.string().min(1),
  start: BrDate,
  end: BrDate.nullable(),
  location: z.string().min(1),
  employment_type: z.enum(['full-time', 'part-time', 'contract', 'freelance', 'internship']),
  bullets: z.array(z.string().min(1)),
  tech: z.array(z.string().min(1)),
};

function optional<T extends Record<string, z.ZodTypeAny>>(shape: T) {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [key, schema.optional()]),
  ) as { [K in keyof T]: z.ZodOptional<T[K]> };
}

function find<T extends { id: string }>(items: T[], id: string, collection: string): T {
  const found = items.find((item) => item.id === id);
  if (found === undefined) throw new Error(`${collection} "${id}" não existe no career.yml.`);

  return found;
}

function requireFreeId(items: { id: string }[], id: string, collection: string): void {
  if (items.some((item) => item.id === id)) {
    throw new Error(`Já existe ${collection} com id "${id}" — escolha outro.`);
  }
}

/** Remover algo que uma skill cita como evidência invalidaria o arquivo. */
function requireNoEvidence(career: Career, type: string, ref: string): void {
  const citing = career.skills
    .filter((skill) => skill.evidence.some((item) => item.type === type && item.ref === ref))
    .map((skill) => skill.name);

  if (citing.length > 0) {
    throw new Error(
      `"${ref}" é evidência das skills: ${citing.join(', ')}. Tire a evidência antes de remover.`,
    );
  }
}

export function registerCareerWriteTools(server: McpServer, config: Config): void {
  server.registerTool(
    'add_experience',
    {
      title: 'Adicionar experiência',
      description: `Adiciona uma experiência ao career.yml.

Datas em DD/MM/YYYY. end ausente ou null significa cargo atual.
Entra sempre com provenance.verified = false — use mark_verified depois de
conferir.

Sem confirm, devolve só o diff do que faria.`,
      inputSchema: {
        experience: z.object({ id: Id, ...optional(experienceFields) }).extend({
          company: experienceFields.company,
          role: experienceFields.role,
          start: experienceFields.start,
        }),
        confirm: confirmInput,
      },
      outputSchema: WRITE_OUTPUT,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ experience, confirm }) => {
      return respond(
        await runWrite(config, confirm, (career) => {
          requireFreeId(career.experiences, experience.id, 'experiência');

          const nova = {
            ...experience,
            end: experience.end ?? null,
            bullets: experience.bullets ?? [],
            tech: experience.tech ?? [],
            provenance: { verified: false, source: 'manual' as const },
          } as Experience;

          return { ...career, experiences: [...career.experiences, nova] };
        }),
      );
    },
  );

  server.registerTool(
    'update_experience',
    {
      title: 'Atualizar experiência',
      description: `Aplica um patch parcial numa experiência existente.

Só os campos enviados mudam. Arrays (bullets, tech) são substituídos
inteiros, não mesclados. provenance.verified é preservado.

Sem confirm, devolve só o diff. Patch que não muda nada não escreve nem
versiona.`,
      inputSchema: {
        id: Id.describe('Id da experiência a atualizar.'),
        patch: z.object(optional(experienceFields)),
        confirm: confirmInput,
      },
      outputSchema: WRITE_OUTPUT,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, patch, confirm }) => {
      return respond(
        await runWrite(config, confirm, (career) => {
          find(career.experiences, id, 'Experiência');

          return {
            ...career,
            experiences: career.experiences.map((experience) =>
              experience.id === id ? ({ ...experience, ...patch } as Experience) : experience,
            ),
          };
        }),
      );
    },
  );

  server.registerTool(
    'delete_experience',
    {
      title: 'Remover experiência',
      description: `Remove uma experiência do career.yml.

Recusa se alguma skill citar essa experiência como evidência — remover
deixaria o arquivo inválido. Tire a evidência primeiro.

Sem confirm, devolve só o diff. O conteúdo anterior fica em history/.`,
      inputSchema: {
        id: Id.describe('Id da experiência a remover.'),
        confirm: confirmInput,
      },
      outputSchema: WRITE_OUTPUT,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, confirm }) => {
      return respond(
        await runWrite(config, confirm, (career) => {
          find(career.experiences, id, 'Experiência');
          requireNoEvidence(career, 'experience', id);

          return {
            ...career,
            experiences: career.experiences.filter((experience) => experience.id !== id),
          };
        }),
      );
    },
  );
}
