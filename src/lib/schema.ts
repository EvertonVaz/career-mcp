import { z } from 'zod';

// ── Primitivos ───────────────────────────────────────────────────────────────

/** Id estável em kebab-case. Âncora de evidência entre entidades. */
export const Id = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id deve ser kebab-case, ex: "acme-backend-2023"');

const DATE_PATTERN = /^(0[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2])\/(\d{4})$/;

/** Rejeita 31/02 e afins, que o regex sozinho deixa passar. */
function isRealDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;

  const [, day, month, year] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime());
}

/**
 * Data em DD/MM/YYYY, sempre string — `Date` no YAML vira objeto e quebra o
 * round-trip da escrita.
 */
export const BrDate = z
  .string()
  .regex(DATE_PATTERN, 'data deve estar em DD/MM/YYYY, ex: "01/03/2023"')
  .refine(isRealDate, 'data inexistente no calendário');

/**
 * Converte para YYYYMMDD. DD/MM/YYYY não é ordenável como string crua, então
 * toda comparação de data passa por aqui.
 */
export function toSortable(date: string): string {
  const [day, month, year] = date.split('/');
  return `${year}${month}${day}`;
}

/** "01/03/2023" -> "2023-03-01", para montar janela de data em API. */
export function toIsoDate(date: string): string {
  const [day, month, year] = date.split('/');
  return `${year}-${month}-${day}`;
}

/** "owner/repo" */
export const RepoSlug = z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'use "owner/repo"');

// ── Proveniência ─────────────────────────────────────────────────────────────

export const SourceKind = z.enum(['manual', 'github', 'inferred']);

/**
 * Tudo que a LLM pode inferir carrega isto. `verified: false` com `source_ref`
 * é o que separa sugestão de fato.
 */
export const Provenance = z.strictObject({
  verified: z.boolean().default(false),
  source: SourceKind.default('manual'),
  /** Ex: "github:etovaz/career-mcp", "experience:acme-2023". */
  source_ref: z.string().min(1).optional(),
  last_synced_at: z.iso.datetime().optional(),
});

export const EvidenceType = z.enum([
  'experience',
  'project',
  'repo',
  'education',
  'certification',
  'external',
]);

export const Evidence = z.strictObject({
  type: EvidenceType,
  ref: z.string().min(1),
  note: z.string().optional(),
});

// ── Entidades ────────────────────────────────────────────────────────────────

export const Profile = z.strictObject({
  name: z.string().min(1),
  // 220 e 2600 são os limites reais do LinkedIn. Falha aqui, não na publicação.
  headline: z.string().min(1).max(220),
  summary: z.string().max(2600).optional(),
  location: z.string().optional(),
  email: z.email().optional(),
  links: z
    .strictObject({
      github: z.url().optional(),
      linkedin: z.url().optional(),
      site: z.url().optional(),
    })
    .prefault({}),
});

export const Experience = z.strictObject({
  id: Id,
  company: z.string().min(1),
  role: z.string().min(1),
  start: BrDate,
  /** null = cargo atual. */
  end: BrDate.nullable().default(null),
  location: z.string().optional(),
  employment_type: z
    .enum(['full-time', 'part-time', 'contract', 'freelance', 'internship'])
    .optional(),
  bullets: z.array(z.string().min(1)).default([]),
  tech: z.array(z.string().min(1)).default([]),
  provenance: Provenance.prefault({}),
});

export const Project = z.strictObject({
  id: Id,
  name: z.string().min(1),
  github_repo: RepoSlug.optional(),
  problem: z.string().optional(),
  solution: z.string().optional(),
  result: z.string().optional(),
  stack: z.array(z.string().min(1)).default([]),
  links: z.strictObject({ repo: z.url().optional(), demo: z.url().optional() }).prefault({}),
  // alt obrigatório: imagem sem alt no portfólio é bug de acessibilidade.
  images: z.array(z.strictObject({ url: z.url(), alt: z.string().min(1) })).default([]),
  highlight: z.boolean().default(false),
  provenance: Provenance.prefault({}),
});

export const SkillCategory = z.enum([
  'language',
  'framework',
  'tool',
  'platform',
  'practice',
  'soft',
]);

export const Skill = z.strictObject({
  /** O nome é a chave — skills não têm id próprio. */
  name: z.string().min(1),
  category: SkillCategory,
  evidence: z.array(Evidence).default([]),
  provenance: Provenance.prefault({}),
});

export const Education = z.strictObject({
  id: Id,
  institution: z.string().min(1),
  degree: z.string().min(1),
  field: z.string().optional(),
  start: BrDate,
  end: BrDate.nullable().default(null),
  provenance: Provenance.prefault({}),
});

export const Certification = z.strictObject({
  id: Id,
  name: z.string().min(1),
  issuer: z.string().min(1),
  issued_at: BrDate,
  expires_at: BrDate.nullable().default(null),
  credential_url: z.url().optional(),
  provenance: Provenance.prefault({}),
});

export const Language = z.strictObject({
  name: z.string().min(1),
  level: z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native']),
});

// ── Documento ────────────────────────────────────────────────────────────────

export const Meta = z.strictObject({
  schema_version: z.literal(1),
  updated_at: z.iso.datetime().optional(),
});

const CareerShape = z.strictObject({
  meta: Meta.prefault({ schema_version: 1 }),
  profile: Profile,
  experiences: z.array(Experience).default([]),
  projects: z.array(Project).default([]),
  skills: z.array(Skill).default([]),
  education: z.array(Education).default([]),
  certifications: z.array(Certification).default([]),
  languages: z.array(Language).default([]),
});

type CareerShapeOut = z.infer<typeof CareerShape>;

function reportDuplicates(keys: string[], collection: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();

  keys.forEach((key, index) => {
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [collection, index],
        message: `"${key}" duplicado em ${collection}`,
      });
    }
    seen.add(key);
  });
}

function reportBadRange(
  start: string,
  end: string | null,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  if (end && toSortable(end) < toSortable(start)) {
    ctx.addIssue({ code: 'custom', path, message: `end (${end}) é anterior a start (${start})` });
  }
}

/** Checagens que não cabem numa entidade isolada. */
function checkIntegrity(doc: CareerShapeOut, ctx: z.RefinementCtx): void {
  reportDuplicates(doc.experiences.map((e) => e.id), 'experiences', ctx);
  reportDuplicates(doc.projects.map((p) => p.id), 'projects', ctx);
  reportDuplicates(doc.education.map((e) => e.id), 'education', ctx);
  reportDuplicates(doc.certifications.map((c) => c.id), 'certifications', ctx);
  reportDuplicates(doc.skills.map((s) => s.name.toLowerCase()), 'skills', ctx);
  reportDuplicates(doc.languages.map((l) => l.name.toLowerCase()), 'languages', ctx);

  doc.experiences.forEach((e, i) => reportBadRange(e.start, e.end, ['experiences', i, 'end'], ctx));
  doc.education.forEach((e, i) => reportBadRange(e.start, e.end, ['education', i, 'end'], ctx));
  doc.certifications.forEach((c, i) =>
    reportBadRange(c.issued_at, c.expires_at, ['certifications', i, 'expires_at'], ctx),
  );

  // Evidência precisa apontar para algo que existe; sem isso a regra "nunca
  // invente dados" vira decoração. 'repo' e 'external' não são resolvíveis aqui.
  const known: Partial<Record<z.infer<typeof EvidenceType>, Set<string>>> = {
    experience: new Set(doc.experiences.map((e) => e.id)),
    project: new Set(doc.projects.map((p) => p.id)),
    education: new Set(doc.education.map((e) => e.id)),
    certification: new Set(doc.certifications.map((c) => c.id)),
  };

  doc.skills.forEach((skill, si) => {
    skill.evidence.forEach((ev, ei) => {
      const pool = known[ev.type];
      if (pool && !pool.has(ev.ref)) {
        ctx.addIssue({
          code: 'custom',
          path: ['skills', si, 'evidence', ei, 'ref'],
          message: `${ev.type} "${ev.ref}" não existe no career.yml`,
        });
      }
    });
  });
}

export const CareerFile = CareerShape.superRefine(checkIntegrity);

/** data/private.yml — gitignored. Só o que não pode vazar em output gerado. */
export const PrivateFile = z.strictObject({
  phone: z.string().optional(),
  address: z.string().optional(),
});

export type Career = z.infer<typeof CareerFile>;
export type Private = z.infer<typeof PrivateFile>;
