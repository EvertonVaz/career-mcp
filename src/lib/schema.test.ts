import { describe, expect, it } from 'vitest';
import { CareerFile, toIsoDate, toSortable } from './schema.js';

/** Career mínimo válido; cada teste sobrescreve só o que interessa. */
function career(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profile: { name: 'Everton', headline: 'Dev' },
    experiences: [
      {
        id: 'acme-2023',
        company: 'Acme',
        role: 'Backend Dev',
        start: '01/03/2023',
      },
    ],
    ...overrides,
  };
}

describe('toSortable', () => {
  it('converte DD/MM/YYYY em chave ordenável', () => {
    expect(toSortable('01/03/2023')).toBe('20230301');
  });

  it('ordena datas que a comparação de string erraria', () => {
    // "01/02/2024" < "03/01/2023" como string crua — aqui não.
    expect(toSortable('01/02/2024') > toSortable('03/01/2023')).toBe(true);
  });
});

describe('toIsoDate', () => {
  it('converte para o formato que a API do GitHub entende', () => {
    expect(toIsoDate('01/03/2023')).toBe('2023-03-01');
    expect(toIsoDate('31/12/2020')).toBe('2020-12-31');
  });
});

describe('CareerFile', () => {
  it('aceita o documento mínimo e preenche os defaults', () => {
    const parsed = CareerFile.parse(career());

    expect(parsed.meta.schema_version).toBe(1);
    expect(parsed.projects).toEqual([]);
    expect(parsed.experiences[0]?.end).toBeNull();
    expect(parsed.experiences[0]?.provenance).toEqual({ verified: false, source: 'manual' });
  });

  it('mantém o email no profile', () => {
    const parsed = CareerFile.parse(
      career({ profile: { name: 'Everton', headline: 'Dev', email: 'etovaz.web@gmail.com' } }),
    );

    expect(parsed.profile.email).toBe('etovaz.web@gmail.com');
  });

  it('rejeita data fora de DD/MM/YYYY', () => {
    const result = CareerFile.safeParse(
      career({ experiences: [{ id: 'a', company: 'A', role: 'R', start: '2023-03' }] }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('DD/MM/YYYY');
  });

  it('rejeita dia inexistente', () => {
    const result = CareerFile.safeParse(
      career({ experiences: [{ id: 'a', company: 'A', role: 'R', start: '32/01/2023' }] }),
    );

    expect(result.success).toBe(false);
  });

  it('rejeita end anterior a start', () => {
    const result = CareerFile.safeParse(
      career({
        experiences: [
          { id: 'a', company: 'A', role: 'R', start: '01/03/2023', end: '01/02/2023' },
        ],
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['experiences', 0, 'end']);
  });

  it('aceita end null como cargo atual', () => {
    const parsed = CareerFile.parse(
      career({
        experiences: [{ id: 'a', company: 'A', role: 'R', start: '01/03/2023', end: null }],
      }),
    );

    expect(parsed.experiences[0]?.end).toBeNull();
  });

  it('rejeita id duplicado em experiences', () => {
    const result = CareerFile.safeParse(
      career({
        experiences: [
          { id: 'acme', company: 'A', role: 'R', start: '01/01/2020' },
          { id: 'acme', company: 'B', role: 'R', start: '01/01/2022' },
        ],
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('duplicado');
  });

  it('rejeita skill com evidência apontando para projeto inexistente', () => {
    const result = CareerFile.safeParse(
      career({
        skills: [
          {
            name: 'TypeScript',
            category: 'language',
            evidence: [{ type: 'project', ref: 'nao-existe' }],
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('não existe');
  });

  it('resolve evidência que aponta para experiência existente', () => {
    const parsed = CareerFile.parse(
      career({
        skills: [
          {
            name: 'TypeScript',
            category: 'language',
            evidence: [{ type: 'experience', ref: 'acme-2023' }],
          },
        ],
      }),
    );

    expect(parsed.skills[0]?.evidence).toHaveLength(1);
  });

  it('não tenta resolver evidência do tipo repo localmente', () => {
    const result = CareerFile.safeParse(
      career({
        skills: [
          {
            name: 'TypeScript',
            category: 'language',
            evidence: [{ type: 'repo', ref: 'etovaz/career-mcp' }],
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
  });

  it('rejeita campo desconhecido', () => {
    const result = CareerFile.safeParse(
      career({
        experiences: [
          { id: 'a', company: 'A', role: 'R', start: '01/01/2020', salario: 9000 },
        ],
      }),
    );

    expect(result.success).toBe(false);
  });

  it('rejeita headline acima do limite do LinkedIn', () => {
    const result = CareerFile.safeParse(
      career({ profile: { name: 'Everton', headline: 'x'.repeat(221) } }),
    );

    expect(result.success).toBe(false);
  });

  it('rejeita id fora de kebab-case', () => {
    const result = CareerFile.safeParse(
      career({ experiences: [{ id: 'Acme 2023', company: 'A', role: 'R', start: '01/01/2020' }] }),
    );

    expect(result.success).toBe(false);
  });

  it('rejeita nome de skill duplicado ignorando caixa', () => {
    const result = CareerFile.safeParse(
      career({
        skills: [
          { name: 'TypeScript', category: 'language' },
          { name: 'typescript', category: 'language' },
        ],
      }),
    );

    expect(result.success).toBe(false);
  });
});
