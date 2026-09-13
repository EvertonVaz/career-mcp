import { readdir, rm } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../../test/harness.js';

const CAREER = `
profile:
  name: Everton
  headline: Desenvolvedor
experiences:
  - id: acme-2023
    company: Acme
    role: Backend Dev
    start: 01/03/2023
projects:
  - id: career-mcp
    name: career-mcp
    problem: Canais desencontrados
    stack: [TypeScript]
    provenance: { verified: true }
skills:
  - name: TypeScript
    category: language
    evidence:
      - type: project
        ref: career-mcp
`;

type WriteResult = { applied: boolean; changes: { path: string; kind: string }[] };

let h: Harness;

beforeAll(async () => {
  h = await startHarness(CAREER);
});

afterAll(() => h.close());

beforeEach(async () => {
  await h.writeCareer(CAREER);
  await rm(h.historyDir, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown>): Promise<WriteResult> =>
  h.callTool<WriteResult>(name, args);

const raw = (name: string, args: Record<string, unknown>) =>
  h.client.callTool({ name, arguments: args });

const projects = async (): Promise<Record<string, unknown>[]> =>
  (await h.readResource('career://projects')) as Record<string, unknown>[];

const skills = async (): Promise<Record<string, unknown>[]> =>
  (await h.readResource('career://skills')) as Record<string, unknown>[];

describe('add_project', () => {
  it('sem confirm não escreve', async () => {
    const antes = await h.readCareer();

    const result = await call('add_project', { project: { id: 'novo', name: 'Novo' } });

    expect(result.applied).toBe(false);
    expect(await h.readCareer()).toBe(antes);
  });

  it('com confirm grava como não verificado', async () => {
    await call('add_project', {
      project: { id: 'portfolio', name: 'Portfólio', stack: ['Astro'] },
      confirm: true,
    });

    const novo = (await projects()).find((p) => p.id === 'portfolio');
    expect(novo).toMatchObject({
      name: 'Portfólio',
      stack: ['Astro'],
      provenance: { verified: false, source: 'manual' },
    });
  });

  it('recusa id duplicado', async () => {
    const result = await raw('add_project', {
      project: { id: 'career-mcp', name: 'X' },
      confirm: true,
    });

    expect(result.isError).toBe(true);
  });

  it('recusa link que não é URL', async () => {
    const result = await raw('add_project', {
      project: { id: 'novo', name: 'Novo', links: { repo: 'nao-e-url' } },
      confirm: true,
    });

    expect(result.isError).toBe(true);
  });
});

describe('update_project', () => {
  it('aplica patch parcial e preserva o resto', async () => {
    await call('update_project', {
      id: 'career-mcp',
      patch: { result: 'Canais coerentes' },
      confirm: true,
    });

    expect((await projects())[0]).toMatchObject({
      problem: 'Canais desencontrados',
      result: 'Canais coerentes',
      provenance: { verified: true },
    });
  });

  it('recusa id inexistente', async () => {
    const result = await raw('update_project', { id: 'fantasma', patch: {}, confirm: true });

    expect(result.isError).toBe(true);
  });
});

describe('delete_project', () => {
  it('recusa remover projeto citado como evidência', async () => {
    const result = await raw('delete_project', { id: 'career-mcp', confirm: true });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/TypeScript/);
  });

  it('remove quando ninguém cita', async () => {
    await h.writeCareer(CAREER.replace(/skills:[\s\S]*$/, ''));

    await call('delete_project', { id: 'career-mcp', confirm: true });

    expect(await projects()).toEqual([]);
    expect(await readdir(h.historyDir)).toHaveLength(2);
  });
});

describe('add_skill', () => {
  it('grava skill nova como não verificada', async () => {
    await call('add_skill', {
      skill: { name: 'Go', category: 'language' },
      confirm: true,
    });

    const go = (await skills()).find((s) => s.name === 'Go');
    expect(go).toMatchObject({
      category: 'language',
      evidence: [],
      provenance: { verified: false, source: 'manual' },
    });
  });

  it('recusa nome repetido ignorando caixa', async () => {
    const result = await raw('add_skill', {
      skill: { name: 'typescript', category: 'language' },
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/typescript/i);
  });

  it('recusa evidência que aponta para id inexistente', async () => {
    const result = await raw('add_skill', {
      skill: {
        name: 'Go',
        category: 'language',
        evidence: [{ type: 'project', ref: 'nao-existe' }],
      },
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/não existe/);
  });

  it('aceita evidência do tipo repo sem checar', async () => {
    await call('add_skill', {
      skill: {
        name: 'Go',
        category: 'language',
        evidence: [{ type: 'repo', ref: 'etovaz/algo' }],
      },
      confirm: true,
    });

    expect((await skills()).find((s) => s.name === 'Go')?.evidence).toEqual([
      { type: 'repo', ref: 'etovaz/algo' },
    ]);
  });

  it('recusa categoria fora do enum', async () => {
    const result = await raw('add_skill', {
      skill: { name: 'Go', category: 'inventada' },
      confirm: true,
    });

    expect(result.isError).toBe(true);
  });
});

describe('update_skill', () => {
  it('troca a categoria', async () => {
    await call('update_skill', {
      name: 'TypeScript',
      patch: { category: 'tool' },
      confirm: true,
    });

    expect((await skills())[0]?.category).toBe('tool');
  });

  it('substitui a lista de evidências inteira', async () => {
    await call('update_skill', {
      name: 'TypeScript',
      patch: { evidence: [{ type: 'experience', ref: 'acme-2023' }] },
      confirm: true,
    });

    expect((await skills())[0]?.evidence).toEqual([{ type: 'experience', ref: 'acme-2023' }]);
  });

  it('acha a skill ignorando caixa', async () => {
    const result = await call('update_skill', {
      name: 'typescript',
      patch: { category: 'tool' },
      confirm: true,
    });

    expect(result.applied).toBe(true);
  });

  it('recusa skill inexistente', async () => {
    const result = await raw('update_skill', { name: 'Cobol', patch: {}, confirm: true });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Cobol/);
  });
});

describe('mark_verified', () => {
  it('marca uma experiência como verificada', async () => {
    const result = await call('mark_verified', {
      kind: 'experience',
      id: 'acme-2023',
      confirm: true,
    });

    expect(result.changes).toEqual([
      {
        path: 'experiences[acme-2023].provenance.verified',
        kind: 'changed',
        before: false,
        after: true,
      },
    ]);
  });

  it('desmarca quando verified é false', async () => {
    await call('mark_verified', {
      kind: 'project',
      id: 'career-mcp',
      verified: false,
      confirm: true,
    });

    expect((await projects())[0]?.provenance).toMatchObject({ verified: false });
  });

  it('marca skill pelo nome', async () => {
    await call('mark_verified', { kind: 'skill', id: 'TypeScript', confirm: true });

    expect((await skills())[0]?.provenance).toMatchObject({ verified: true });
  });

  it('não versiona quando já estava no estado pedido', async () => {
    const result = await call('mark_verified', {
      kind: 'project',
      id: 'career-mcp',
      confirm: true,
    });

    expect(result.changes).toEqual([]);
    await expect(readdir(h.historyDir)).rejects.toThrow();
  });

  it('recusa id inexistente', async () => {
    const result = await raw('mark_verified', {
      kind: 'experience',
      id: 'fantasma',
      confirm: true,
    });

    expect(result.isError).toBe(true);
  });

  it('recusa kind fora do enum', async () => {
    const result = await raw('mark_verified', { kind: 'idioma', id: 'x', confirm: true });

    expect(result.isError).toBe(true);
  });
});

describe('update_profile', () => {
  it('sem confirm mostra o diff e não escreve', async () => {
    const antes = await h.readCareer();

    const result = await call('update_profile', { patch: { headline: 'Tech Lead' } });

    expect(result.changes).toEqual([
      { path: 'profile.headline', kind: 'changed', before: 'Desenvolvedor', after: 'Tech Lead' },
    ]);
    expect(await h.readCareer()).toBe(antes);
  });

  it('com confirm aplica patch parcial preservando o resto e versiona', async () => {
    const result = await call('update_profile', {
      patch: { headline: 'Tech Lead', links: { github: 'https://github.com/etovaz' } },
      confirm: true,
    });

    expect(result.applied).toBe(true);
    expect(await h.readResource('career://profile')).toMatchObject({
      name: 'Everton',
      headline: 'Tech Lead',
      links: { github: 'https://github.com/etovaz' },
    });
    expect(await readdir(h.historyDir)).toHaveLength(2);
  });

  it('recusa headline acima do limite do LinkedIn', async () => {
    const result = await raw('update_profile', {
      patch: { headline: 'x'.repeat(221) },
      confirm: true,
    });

    expect(result.isError).toBe(true);
  });

  describe('sem career.yml', () => {
    beforeEach(() => h.removeCareer());

    it('sem confirm mostra o profile que criaria e não cria o arquivo', async () => {
      const result = await call('update_profile', {
        patch: { name: 'Everton', headline: 'Desenvolvedor' },
      });

      expect(result.applied).toBe(false);
      expect(result.changes).toEqual([
        expect.objectContaining({ path: 'profile', kind: 'added' }),
      ]);
      await expect(h.readCareer()).rejects.toThrow();
    });

    it('com confirm cria o career.yml a partir do profile', async () => {
      const result = await call('update_profile', {
        patch: { name: 'Everton', headline: 'Desenvolvedor' },
        confirm: true,
      });

      expect(result.applied).toBe(true);
      expect(await h.readResource('career://profile')).toMatchObject({
        name: 'Everton',
        headline: 'Desenvolvedor',
      });
      expect(await projects()).toEqual([]);
      expect(await readdir(h.historyDir)).toEqual([]);
    });

    it('recusa criar sem name e headline', async () => {
      const result = await raw('update_profile', { patch: { name: 'Everton' }, confirm: true });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/profile\.headline/);
      await expect(h.readCareer()).rejects.toThrow();
    });
  });
});
