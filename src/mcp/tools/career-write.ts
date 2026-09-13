import { access } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { diffCareer, snapshotBeforeWrite, type Change } from '../../lib/history.js';
import { loadCareer, saveCareer, validateCareer, withCareerLock } from '../../lib/loader.js';
import {
  BrDate,
  Evidence,
  Id,
  Language as LanguageSchema,
  RepoSlug,
  SkillCategory,
  type Career,
} from '../../lib/schema.js';

type Experience = Career['experiences'][number];
type Project = Career['projects'][number];
type Education = Career['education'][number];
type Certification = Career['certifications'][number];
type Language = Career['languages'][number];
type Skill = Career['skills'][number];

/**
 * Todo write passa por aqui: carrega, aplica a mutação, calcula o diff e só
 * então decide escrever. Sem confirm, para no diff — é o preview.
 */
async function runWrite(
  config: Config,
  confirm: boolean,
  mutate: (career: Career) => Career,
  load: (filePath: string) => Promise<Career> = loadCareer,
): Promise<{ applied: boolean; changes: Change[] }> {
  return withCareerLock(config.paths.career, async () => {
    const career = await load(config.paths.career);
    // Valida antes de decidir escrever: senão o preview diria "ok" e o confirm
    // falharia depois. Também aplica os defaults, então o diff mostra o estado final.
    const after = validateCareer(config.paths.career, mutate(career));
    const changes = diffCareer(career, after);

    if (!confirm || changes.length === 0) return { applied: false, changes };

    await snapshotBeforeWrite(config.paths.history, config.paths.career, changes);
    await saveCareer(config.paths.career, after);

    return { applied: true, changes };
  });
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

/** Campos de projeto que você controla; provenance é do servidor. */
const projectFields = {
  name: z.string().min(1),
  github_repo: RepoSlug,
  problem: z.string().min(1),
  solution: z.string().min(1),
  result: z.string().min(1),
  stack: z.array(z.string().min(1)),
  links: z.object({ repo: z.url().optional(), demo: z.url().optional() }),
  images: z.array(z.object({ url: z.url(), alt: z.string().min(1) })),
  highlight: z.boolean(),
};

/** Campos de formação que você controla; provenance é do servidor. */
const educationFields = {
  institution: z.string().min(1),
  degree: z.string().min(1),
  field: z.string().min(1),
  start: BrDate,
  end: BrDate.nullable(),
};

/** Campos de certificação que você controla; provenance é do servidor. */
const certificationFields = {
  name: z.string().min(1),
  issuer: z.string().min(1),
  issued_at: BrDate,
  expires_at: BrDate.nullable(),
  credential_url: z.url(),
};

/** Idioma não tem id nem provenance: o nome é a chave. */
const languageFields = {
  level: LanguageSchema.shape.level,
};

function findLanguage(career: Career, name: string): Language {
  const found = career.languages.find(
    (language) => language.name.toLowerCase() === name.toLowerCase(),
  );
  if (found === undefined) throw new Error(`Idioma "${name}" não existe no career.yml.`);

  return found;
}

const skillFields = {
  category: SkillCategory,
  evidence: z.array(Evidence),
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

/** where aponta o item do lote, ex.: experiences[2]. */
function requireFreeId(items: { id: string }[], id: string, where: string, collection: string): void {
  if (items.some((item) => item.id === id)) {
    throw new Error(`${where}: já existe ${collection} com id "${id}" — escolha outro.`);
  }
}

/** Teto por chamada: preview de diff maior que isso não cabe numa revisão. */
const MAX_LOTE = 50;

const LOTE_DESCRIPTION = `Recebe de 1 a ${MAX_LOTE} itens e grava numa escrita só, com um snapshot.
Tudo ou nada: se um item for inválido, nenhum é gravado e o erro aponta a posição.`;

function findSkill(career: Career, name: string): Skill {
  const found = career.skills.find(
    (skill) => skill.name.toLowerCase() === name.toLowerCase(),
  );
  if (found === undefined) throw new Error(`Skill "${name}" não existe no career.yml.`);

  return found;
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

/** Campos do profile. Os limites de headline e summary são os do LinkedIn. */
const profileFields = {
  name: z.string().min(1),
  headline: z.string().min(1).max(220),
  summary: z.string().max(2600),
  location: z.string().min(1),
  email: z.email(),
  links: z.object({
    github: z.url().optional(),
    linkedin: z.url().optional(),
    site: z.url().optional(),
  }),
};

/**
 * Documento sem profile: o ponto de partida quando o career.yml ainda não
 * existe. Diffar contra ele faz o preview mostrar só "profile added".
 */
function emptyCareer(): Career {
  return {
    meta: { schema_version: 1 },
    experiences: [],
    projects: [],
    skills: [],
    education: [],
    certifications: [],
    languages: [],
  } as unknown as Career;
}

/** Só o update_profile cria o arquivo; as demais tools seguem exigindo que ele exista. */
async function loadCareerOrEmpty(filePath: string): Promise<Career> {
  try {
    await access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCareer();
    throw error;
  }

  return loadCareer(filePath);
}

export function registerCareerWriteTools(server: McpServer, config: Config): void {
  server.registerTool(
    'update_profile',
    {
      title: 'Atualizar profile',
      description: `Aplica um patch parcial no profile do career.yml.

Se o career.yml ainda não existe, cria o arquivo — nesse caso name e headline
são obrigatórios. É o primeiro passo num data dir vazio.

Só os campos enviados mudam. links é substituído inteiro, não mesclado.

Sem confirm, devolve só o diff.`,
      inputSchema: {
        patch: z.object(optional(profileFields)),
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
    async ({ patch, confirm }) => {
      return respond(
        await runWrite(
          config,
          confirm,
          (career) => ({ ...career, profile: { ...career.profile, ...patch } as Career['profile'] }),
          loadCareerOrEmpty,
        ),
      );
    },
  );

  server.registerTool(
    'add_experience',
    {
      title: 'Adicionar experiência',
      description: `Adiciona experiências ao career.yml.

${LOTE_DESCRIPTION}

Datas em DD/MM/YYYY. end ausente ou null significa cargo atual.
Entra sempre com provenance.verified = false — use mark_verified depois de
conferir.

Sem confirm, devolve só o diff do que faria.`,
      inputSchema: {
        experiences: z
          .array(
            z.object({ id: Id, ...optional(experienceFields) }).extend({
              company: experienceFields.company,
              role: experienceFields.role,
              start: experienceFields.start,
            }),
          )
          .min(1)
          .max(MAX_LOTE),
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
    async ({ experiences, confirm }) => {
      return respond(
        await runWrite(config, confirm, (career) => {
          const novas = experiences.map((experience, i) => {
            requireFreeId(
              [...career.experiences, ...experiences.slice(0, i)],
              experience.id,
              `experiences[${i}]`,
              'experiência',
            );

            return {
              ...experience,
              end: experience.end ?? null,
              bullets: experience.bullets ?? [],
              tech: experience.tech ?? [],
              provenance: { verified: false, source: 'manual' as const },
            } as Experience;
          });

          return { ...career, experiences: [...career.experiences, ...novas] };
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

  server.registerTool(
    'add_education',
    {
      title: 'Adicionar formação',
      description: `Adiciona formações ao career.yml.

${LOTE_DESCRIPTION}

Datas em DD/MM/YYYY. end ausente ou null significa em andamento.
Entra sempre com provenance.verified = false — use mark_verified depois de
conferir.

Sem confirm, devolve só o diff do que faria.`,
      inputSchema: {
        education: z
          .array(
            z.object({ id: Id, ...optional(educationFields) }).extend({
              institution: educationFields.institution,
              degree: educationFields.degree,
              start: educationFields.start,
            }),
          )
          .min(1)
          .max(MAX_LOTE),
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
    async ({ education, confirm }) => {
      return respond(
        await runWrite(config, confirm, (career) => {
          const novas = education.map((item, i) => {
            requireFreeId(
              [...career.education, ...education.slice(0, i)],
              item.id,
              `education[${i}]`,
              'formação',
            );

            return {
              ...item,
              end: item.end ?? null,
              provenance: { verified: false, source: 'manual' as const },
            } as Education;
          });

          return { ...career, education: [...career.education, ...novas] };
        }),
      );
    },
  );

  server.registerTool(
    'update_education',
    {
      title: 'Atualizar formação',
      description: `Aplica um patch parcial numa formação existente.

Só os campos enviados mudam. provenance.verified é preservado.

Sem confirm, devolve só o diff.`,
      inputSchema: {
        id: Id.describe('Id da formação a atualizar.'),
        patch: z.object(optional(educationFields)),
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
          find(career.education, id, 'Formação');

          return {
            ...career,
            education: career.education.map((item) =>
              item.id === id ? ({ ...item, ...patch } as Education) : item,
            ),
          };
        }),
      );
    },
  );

  server.registerTool(
    'delete_education',
    {
      title: 'Remover formação',
      description: `Remove uma formação do career.yml.

Recusa se alguma skill citar essa formação como evidência. Tire a evidência
primeiro.

Sem confirm, devolve só o diff. O conteúdo anterior fica em history/.`,
      inputSchema: { id: Id.describe('Id da formação a remover.'), confirm: confirmInput },
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
          find(career.education, id, 'Formação');
          requireNoEvidence(career, 'education', id);

          return { ...career, education: career.education.filter((item) => item.id !== id) };
        }),
      );
    },
  );

  server.registerTool(
    'add_certification',
    {
      title: 'Adicionar certificação',
      description: `Adiciona certificações ao career.yml.

${LOTE_DESCRIPTION}

Datas em DD/MM/YYYY. expires_at ausente ou null significa que não expira.
Entra sempre com provenance.verified = false — use mark_verified depois de
conferir.

Sem confirm, devolve só o diff do que faria.`,
      inputSchema: {
        certifications: z
          .array(
            z.object({ id: Id, ...optional(certificationFields) }).extend({
              name: certificationFields.name,
              issuer: certificationFields.issuer,
              issued_at: certificationFields.issued_at,
            }),
          )
          .min(1)
          .max(MAX_LOTE),
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
    async ({ certifications, confirm }) => {
      return respond(
        await runWrite(config, confirm, (career) => {
          const novas = certifications.map((certification, i) => {
            requireFreeId(
              [...career.certifications, ...certifications.slice(0, i)],
              certification.id,
              `certifications[${i}]`,
              'certificação',
            );

            return {
              ...certification,
              expires_at: certification.expires_at ?? null,
              provenance: { verified: false, source: 'manual' as const },
            } as Certification;
          });

          return { ...career, certifications: [...career.certifications, ...novas] };
        }),
      );
    },
  );

  server.registerTool(
    'update_certification',
    {
      title: 'Atualizar certificação',
      description: `Aplica um patch parcial numa certificação existente.

Só os campos enviados mudam. provenance.verified é preservado.

Sem confirm, devolve só o diff.`,
      inputSchema: {
        id: Id.describe('Id da certificação a atualizar.'),
        patch: z.object(optional(certificationFields)),
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
          find(career.certifications, id, 'Certificação');

          return {
            ...career,
            certifications: career.certifications.map((item) =>
              item.id === id ? ({ ...item, ...patch } as Certification) : item,
            ),
          };
        }),
      );
    },
  );

  server.registerTool(
    'delete_certification',
    {
      title: 'Remover certificação',
      description: `Remove uma certificação do career.yml.

Recusa se alguma skill citar essa certificação como evidência. Tire a
evidência primeiro.

Sem confirm, devolve só o diff. O conteúdo anterior fica em history/.`,
      inputSchema: { id: Id.describe('Id da certificação a remover.'), confirm: confirmInput },
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
          find(career.certifications, id, 'Certificação');
          requireNoEvidence(career, 'certification', id);

          return {
            ...career,
            certifications: career.certifications.filter((item) => item.id !== id),
          };
        }),
      );
    },
  );

  server.registerTool(
    'add_language',
    {
      title: 'Adicionar idioma',
      description: `Adiciona idiomas ao career.yml. O nome é a chave: não há id.

${LOTE_DESCRIPTION}

level segue o CEFR: A1, A2, B1, B2, C1, C2 ou native.

Sem confirm, devolve só o diff do que faria.`,
      inputSchema: {
        languages: z
          .array(z.object({ name: z.string().min(1), level: languageFields.level }))
          .min(1)
          .max(MAX_LOTE),
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
    async ({ languages, confirm }) => {
      return respond(
        await runWrite(config, confirm, (career) => {
          languages.forEach((language, i) => {
            const taken = [...career.languages, ...languages.slice(0, i)];
            if (taken.some((item) => item.name.toLowerCase() === language.name.toLowerCase())) {
              throw new Error(
                `languages[${i}]: já existe idioma "${language.name}" — use update_language.`,
              );
            }
          });

          return { ...career, languages: [...career.languages, ...languages] };
        }),
      );
    },
  );

  server.registerTool(
    'update_language',
    {
      title: 'Atualizar idioma',
      description: `Muda o level de um idioma existente, achado pelo nome (ignorando
maiúsculas).

Sem confirm, devolve só o diff.`,
      inputSchema: {
        name: z.string().min(1).describe('Nome do idioma a atualizar.'),
        patch: z.object(optional(languageFields)),
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
    async ({ name, patch, confirm }) => {
      return respond(
        await runWrite(config, confirm, (career) => {
          const alvo = findLanguage(career, name);

          return {
            ...career,
            languages: career.languages.map((item) =>
              item.name === alvo.name ? ({ ...item, ...patch } as Language) : item,
            ),
          };
        }),
      );
    },
  );

  server.registerTool(
    'delete_language',
    {
      title: 'Remover idioma',
      description: `Remove um idioma do career.yml, achado pelo nome (ignorando maiúsculas).

Sem confirm, devolve só o diff. O conteúdo anterior fica em history/.`,
      inputSchema: {
        name: z.string().min(1).describe('Nome do idioma a remover.'),
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
    async ({ name, confirm }) => {
      return respond(
        await runWrite(config, confirm, (career) => {
          const alvo = findLanguage(career, name);

          return {
            ...career,
            languages: career.languages.filter((item) => item.name !== alvo.name),
          };
        }),
      );
    },
  );

  server.registerTool(
    'add_project',
    {
      title: 'Adicionar projeto',
      description: `Adiciona projetos ao career.yml.

${LOTE_DESCRIPTION}

problem, solution e result são o que transforma repositório em case — o
validate_all cobra os três. Entra com provenance.verified = false.

Sem confirm, devolve só o diff do que faria.`,
      inputSchema: {
        projects: z
          .array(
            z.object({ id: Id, ...optional(projectFields) }).extend({ name: projectFields.name }),
          )
          .min(1)
          .max(MAX_LOTE),
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
    async ({ projects, confirm }) => {
      return respond(
        await runWrite(config, confirm, (career) => {
          const novos = projects.map((project, i) => {
            requireFreeId(
              [...career.projects, ...projects.slice(0, i)],
              project.id,
              `projects[${i}]`,
              'projeto',
            );

            return {
              ...project,
              stack: project.stack ?? [],
              links: project.links ?? {},
              images: project.images ?? [],
              highlight: project.highlight ?? false,
              provenance: { verified: false, source: 'manual' as const },
            } as Project;
          });

          return { ...career, projects: [...career.projects, ...novos] };
        }),
      );
    },
  );

  server.registerTool(
    'update_project',
    {
      title: 'Atualizar projeto',
      description: `Aplica um patch parcial num projeto existente.

Só os campos enviados mudam. Arrays (stack, images) são substituídos
inteiros. provenance.verified é preservado.

Sem confirm, devolve só o diff.`,
      inputSchema: {
        id: Id.describe('Id do projeto a atualizar.'),
        patch: z.object(optional(projectFields)),
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
          find(career.projects, id, 'Projeto');

          return {
            ...career,
            projects: career.projects.map((project) =>
              project.id === id ? ({ ...project, ...patch } as Project) : project,
            ),
          };
        }),
      );
    },
  );

  server.registerTool(
    'delete_project',
    {
      title: 'Remover projeto',
      description: `Remove um projeto do career.yml.

Recusa se alguma skill citar esse projeto como evidência. Tire a evidência
primeiro.

Sem confirm, devolve só o diff. O conteúdo anterior fica em history/.`,
      inputSchema: { id: Id.describe('Id do projeto a remover.'), confirm: confirmInput },
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
          find(career.projects, id, 'Projeto');
          requireNoEvidence(career, 'project', id);

          return { ...career, projects: career.projects.filter((project) => project.id !== id) };
        }),
      );
    },
  );

  server.registerTool(
    'add_skill',
    {
      title: 'Adicionar skill',
      description: `Adiciona skills ao career.yml. O nome é a chave: não há id.

${LOTE_DESCRIPTION}

evidence aponta para o que sustenta a skill. Os tipos experience, project,
education e certification precisam apontar para um id que existe; repo e
external não são checados aqui.

Skill sem evidência é aceita, mas o validate_all vai cobrar.
Entra com provenance.verified = false.`,
      inputSchema: {
        skills: z
          .array(
            z
              .object({ name: z.string().min(1), ...optional(skillFields) })
              .extend({ category: skillFields.category }),
          )
          .min(1)
          .max(MAX_LOTE),
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
    async ({ skills, confirm }) => {
      return respond(
        await runWrite(config, confirm, (career) => {
          const novas = skills.map((skill, i) => {
            const taken = [...career.skills, ...skills.slice(0, i)];
            if (taken.some((item) => item.name.toLowerCase() === skill.name.toLowerCase())) {
              throw new Error(`skills[${i}]: já existe skill "${skill.name}" — use update_skill.`);
            }

            return {
              ...skill,
              evidence: skill.evidence ?? [],
              provenance: { verified: false, source: 'manual' as const },
            } as Skill;
          });

          return { ...career, skills: [...career.skills, ...novas] };
        }),
      );
    },
  );

  server.registerTool(
    'update_skill',
    {
      title: 'Atualizar skill',
      description: `Aplica um patch parcial numa skill existente, achada pelo nome
(ignorando maiúsculas).

evidence é substituída inteira, não mesclada. provenance.verified é
preservado.

Sem confirm, devolve só o diff.`,
      inputSchema: {
        name: z.string().min(1).describe('Nome da skill a atualizar.'),
        patch: z.object(optional(skillFields)),
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
    async ({ name, patch, confirm }) => {
      return respond(
        await runWrite(config, confirm, (career) => {
          const alvo = findSkill(career, name);

          return {
            ...career,
            skills: career.skills.map((skill) =>
              skill.name === alvo.name ? ({ ...skill, ...patch } as Skill) : skill,
            ),
          };
        }),
      );
    },
  );

  server.registerTool(
    'mark_verified',
    {
      title: 'Marcar como verificado',
      description: `Vira o provenance.verified de uma entidade.

É o passo que separa sugestão de fato: tudo entra como false, inclusive o que
você digita, e só vira true aqui, depois de você conferir.

kind: experience, project, skill, education ou certification.
id: o id da entidade; para skill, o nome.
verified: padrão true; mande false para desmarcar.

Não versiona quando a entidade já está no estado pedido.`,
      inputSchema: {
        kind: z.enum(['experience', 'project', 'skill', 'education', 'certification']),
        id: z.string().min(1).describe('Id da entidade. Para skill, o nome.'),
        verified: z.boolean().default(true),
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
    async ({ kind, id, verified, confirm }) => {
      return respond(
        await runWrite(config, confirm, (career) => {
          const stamp = <T extends { provenance: { verified: boolean } }>(item: T): T => ({
            ...item,
            provenance: { ...item.provenance, verified },
          });

          // Switch explícito em vez de montar o nome da coleção: cada ramo é
          // uma linha e o tipo fica óbvio.
          switch (kind) {
            case 'skill': {
              const alvo = findSkill(career, id);
              return {
                ...career,
                skills: career.skills.map((item) =>
                  item.name === alvo.name ? stamp(item) : item,
                ),
              };
            }
            case 'experience':
              find(career.experiences, id, 'Experiência');
              return {
                ...career,
                experiences: career.experiences.map((item) =>
                  item.id === id ? stamp(item) : item,
                ),
              };
            case 'project':
              find(career.projects, id, 'Projeto');
              return {
                ...career,
                projects: career.projects.map((item) => (item.id === id ? stamp(item) : item)),
              };
            case 'education':
              find(career.education, id, 'Formação');
              return {
                ...career,
                education: career.education.map((item) => (item.id === id ? stamp(item) : item)),
              };
            case 'certification':
              find(career.certifications, id, 'Certificação');
              return {
                ...career,
                certifications: career.certifications.map((item) =>
                  item.id === id ? stamp(item) : item,
                ),
              };
          }
        }),
      );
    },
  );
}

