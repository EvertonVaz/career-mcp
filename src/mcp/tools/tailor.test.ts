import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../../test/harness.js';

const CAREER = `
profile:
  name: Everton
  headline: Desenvolvedor Backend
experiences:
  - id: acme-2023
    company: Acme
    role: Backend Dev
    start: 01/03/2023
    bullets:
      - Migrou a API para TypeScript
    tech: [TypeScript, Postgres]
  - id: beta-2021
    company: Beta
    role: Dev Pleno
    start: 01/02/2021
    end: 28/02/2023
    bullets:
      - Automação de deploy com Docker
    tech: [Go]
projects:
  - id: career-mcp
    name: career-mcp
    problem: Canais desencontrados
    stack: [TypeScript, Node]
  - id: portfolio
    name: Portfólio
    stack: [Astro]
skills:
  - name: TypeScript
    category: language
  - name: Go
    category: language
`;

type Match = {
  term: string;
  evidence: { type: string; ref: string; where: string }[];
};

type TailorResult = {
  matched: Match[];
  without_evidence: string[];
  emphasis: { experiences: string[]; projects: string[] };
  path: string;
  resume: string;
};

let h: Harness;

beforeAll(async () => {
  h = await startHarness(CAREER);
});

afterAll(() => h.close());

beforeEach(async () => {
  await h.writeCareer(CAREER);
  await rm(h.outputDir, { recursive: true, force: true });
});

const tailor = (terms: string[], args: Record<string, unknown> = {}): Promise<TailorResult> =>
  h.callTool<TailorResult>('tailor_for_job', { terms, ...args });

const termsOf = (result: TailorResult): string[] => result.matched.map((m) => m.term);

describe('tailor_for_job', () => {
  it('acha evidência de skill, tech de experiência e stack de projeto', async () => {
    const result = await tailor(['TypeScript']);

    const evidence = result.matched[0]?.evidence ?? [];
    expect(evidence).toContainEqual({ type: 'skill', ref: 'TypeScript', where: 'skills' });
    expect(evidence).toContainEqual({ type: 'experience', ref: 'acme-2023', where: 'tech' });
    expect(evidence).toContainEqual({ type: 'project', ref: 'career-mcp', where: 'stack' });
  });

  it('acha o termo citado dentro de um bullet', async () => {
    const result = await tailor(['Docker']);

    expect(result.matched[0]?.evidence).toContainEqual({
      type: 'experience',
      ref: 'beta-2021',
      where: 'bullets',
    });
  });

  it('separa o que não tem evidência nenhuma', async () => {
    const result = await tailor(['TypeScript', 'Kubernetes']);

    expect(termsOf(result)).toEqual(['TypeScript']);
    expect(result.without_evidence).toEqual(['Kubernetes']);
  });

  it('ignora caixa e acento ao cruzar', async () => {
    expect(termsOf(await tailor(['typescript']))).toEqual(['typescript']);
  });

  it('não casa termo curto dentro de outra palavra', async () => {
    // "Go" não pode casar com "Postgres" nem com "Migrou".
    const result = await tailor(['Go']);
    const refs = result.matched[0]?.evidence.map((e) => e.ref) ?? [];

    expect(refs).toContain('beta-2021');
    expect(refs).not.toContain('acme-2023');
    expect(refs).not.toContain('career-mcp');
  });

  it('ordena as experiências pelas que mais casam', async () => {
    const result = await tailor(['TypeScript', 'Postgres']);

    expect(result.emphasis.experiences).toEqual(['acme-2023', 'beta-2021']);
  });

  it('ordena os projetos pelas que mais casam', async () => {
    const result = await tailor(['Node']);

    expect(result.emphasis.projects[0]).toBe('career-mcp');
  });

  it('gera o currículo com a ordem enfatizada', async () => {
    const result = await tailor(['Go']);

    expect(result.resume.indexOf('Beta')).toBeLessThan(result.resume.indexOf('Acme'));
  });

  it('grava em output/resume-tailored.md', async () => {
    const result = await tailor(['Go']);

    expect(result.path).toBe(path.join(h.outputDir, 'resume-tailored.md'));
    expect(await readFile(result.path, 'utf8')).toBe(result.resume);
  });

  it('não sobrescreve o resume.md normal', async () => {
    await h.callTool('generate_resume');
    const antes = await readFile(path.join(h.outputDir, 'resume.md'), 'utf8');

    await tailor(['Go']);

    expect(await readFile(path.join(h.outputDir, 'resume.md'), 'utf8')).toBe(antes);
  });

  it('corta para os mais relevantes quando vem limit', async () => {
    const result = await tailor(['TypeScript'], { limitExperiences: 1, limitProjects: 1 });

    expect(result.emphasis.experiences).toEqual(['acme-2023']);
    expect(result.resume).not.toContain('Beta');
    expect(result.resume).not.toContain('Portfólio');
  });

  it('não inventa conteúdo: o currículo sai só com o que existe no career.yml', async () => {
    const result = await tailor(['Kubernetes', 'AWS', 'Terraform']);

    expect(result.resume).not.toMatch(/Kubernetes|AWS|Terraform/);
    expect(result.without_evidence).toEqual(['Kubernetes', 'AWS', 'Terraform']);
  });

  it('recusa lista de termos vazia', async () => {
    const result = await h.client.callTool({ name: 'tailor_for_job', arguments: { terms: [] } });

    expect(result.isError).toBe(true);
  });

  it('é escrita não destrutiva, como as outras gerações', async () => {
    const { tools } = await h.client.listTools();
    const tool = tools.find((t) => t.name === 'tailor_for_job');

    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(false);
  });
});
