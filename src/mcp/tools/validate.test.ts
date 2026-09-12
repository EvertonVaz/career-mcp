import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../../test/harness.js';

/** Tudo preenchido e confirmado: a auditoria não deve ter o que reclamar. */
const CLEAN = `
profile:
  name: Everton
  headline: Desenvolvedor
experiences:
  - id: acme-2023
    company: Acme
    role: Backend Dev
    start: 01/03/2023
    bullets:
      - Migrou a API para TypeScript
    tech: [TypeScript]
    provenance: { verified: true }
projects:
  - id: career-mcp
    name: career-mcp
    problem: Canais desencontrados
    solution: Servidor MCP sobre YAML
    result: Currículo e LinkedIn coerentes
    stack: [TypeScript]
    provenance: { verified: true }
skills:
  - name: TypeScript
    category: language
    evidence:
      - type: experience
        ref: acme-2023
    provenance: { verified: true }
`;

type Report = {
  valid: boolean;
  schema_issues: { path: string; message: string }[];
  warnings: { code: string; path: string; message: string }[];
  unverified: string[];
  counts?: Record<string, number>;
};

let h: Harness;

beforeAll(async () => {
  h = await startHarness(CLEAN);
});

afterAll(() => h.close());

async function validate(yaml: string): Promise<Report> {
  await h.writeCareer(yaml);
  return h.callTool<Report>('validate_all');
}

function codes(report: Report): string[] {
  return report.warnings.map((w) => `${w.code} ${w.path}`);
}

describe('validate_all', () => {
  it('está registrada como leitura', async () => {
    const { tools } = await h.client.listTools();
    const tool = tools.find((t) => t.name === 'validate_all');

    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it('não reclama de um career completo e confirmado', async () => {
    const report = await validate(CLEAN);

    expect(report).toMatchObject({ valid: true, schema_issues: [], warnings: [], unverified: [] });
  });

  it('conta as entidades', async () => {
    const report = await validate(CLEAN);

    expect(report.counts).toMatchObject({ experiences: 1, projects: 1, skills: 1, education: 0 });
  });

  it('acusa skill sem evidência', async () => {
    const report = await validate(CLEAN.replace(/    evidence:\n.*\n.*\n/, ''));

    expect(codes(report)).toContain('skill_without_evidence skills[TypeScript]');
  });

  it('acusa experiência sem bullets', async () => {
    const report = await validate(CLEAN.replace(/    bullets:\n.*\n/, ''));

    expect(codes(report)).toContain('experience_without_bullets experiences[acme-2023]');
  });

  it('acusa projeto sem problema, solução ou resultado', async () => {
    const report = await validate(CLEAN.replace(/    result: .*\n/, ''));

    expect(codes(report)).toContain('project_incomplete projects[career-mcp]');
  });

  it('não acusa projeto que tem os três campos', async () => {
    const report = await validate(CLEAN);

    expect(codes(report).some((c) => c.startsWith('project_incomplete'))).toBe(false);
  });

  it('lista o que ainda não foi verificado, separado dos warnings', async () => {
    const report = await validate(CLEAN.replaceAll('    provenance: { verified: true }\n', ''));

    expect(report.unverified.sort()).toEqual([
      'experiences[acme-2023]',
      'projects[career-mcp]',
      'skills[TypeScript]',
    ]);
    expect(report.warnings).toEqual([]);
  });

  it('reporta erro de schema em vez de estourar', async () => {
    const report = await validate(CLEAN.replace('01/03/2023', '2023-03'));

    expect(report.valid).toBe(false);
    expect(report.schema_issues[0]).toMatchObject({ path: 'experiences.0.start' });
    expect(report.counts).toBeUndefined();
  });

  it('reporta evidência órfã como erro de schema', async () => {
    const report = await validate(CLEAN.replace('ref: acme-2023', 'ref: nao-existe'));

    expect(report.valid).toBe(false);
    expect(report.schema_issues[0]?.message).toContain('não existe');
  });

  it('falha de verdade quando o career.yml não existe', async () => {
    await h.removeCareer();
    const result = await h.client.callTool({ name: 'validate_all', arguments: {} });

    expect(result.isError).toBe(true);
  });
});
