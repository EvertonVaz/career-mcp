import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OUTSIDE_CHANGES } from '../../lib/history.js';
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
  await h.resetHistory();
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

    const result = await call('add_project', { projects: [{ id: 'novo', name: 'Novo' }] });

    expect(result.applied).toBe(false);
    expect(await h.readCareer()).toBe(antes);
  });

  it('com confirm grava como não verificado', async () => {
    await call('add_project', {
      projects: [{ id: 'portfolio', name: 'Portfólio', stack: ['Astro'] }],
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
      projects: [{ id: 'career-mcp', name: 'X' }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
  });

  it('recusa link que não é URL', async () => {
    const result = await raw('add_project', {
      projects: [{ id: 'novo', name: 'Novo', links: { repo: 'nao-e-url' } }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
  });

  it('grava vários numa chamada', async () => {
    await call('add_project', {
      projects: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      confirm: true,
    });

    expect((await projects()).map((p) => p.id)).toEqual(['career-mcp', 'a', 'b']);
    expect(await h.commits()).toEqual([expect.stringMatching(/^\w+: /), OUTSIDE_CHANGES]);
  });

  it('recusa id repetido dentro do próprio lote', async () => {
    const result = await raw('add_project', {
      projects: [
        { id: 'a', name: 'A' },
        { id: 'a', name: 'B' },
      ],
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/projects\[1\]/);
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
    expect(await h.commits()).toEqual([expect.stringMatching(/^\w+: /), OUTSIDE_CHANGES]);
  });
});

describe('add_skill', () => {
  it('grava skill nova como não verificada', async () => {
    await call('add_skill', {
      skills: [{ name: 'Go', category: 'language' }],
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
      skills: [{ name: 'typescript', category: 'language' }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/typescript/i);
  });

  it('recusa evidência que aponta para id inexistente', async () => {
    const result = await raw('add_skill', {
      skills: [{
        name: 'Go',
        category: 'language',
        evidence: [{ type: 'project', ref: 'nao-existe' }],
      }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/não existe/);
  });

  it('aceita evidência do tipo repo sem checar', async () => {
    await call('add_skill', {
      skills: [{
        name: 'Go',
        category: 'language',
        evidence: [{ type: 'repo', ref: 'etovaz/algo' }],
      }],
      confirm: true,
    });

    expect((await skills()).find((s) => s.name === 'Go')?.evidence).toEqual([
      { type: 'repo', ref: 'etovaz/algo' },
    ]);
  });

  it('recusa categoria fora do enum', async () => {
    const result = await raw('add_skill', {
      skills: [{ name: 'Go', category: 'inventada' }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
  });

  it('grava 20 skills numa escrita só, com um commit', async () => {
    const vinte = Array.from({ length: 20 }, (_, i) => ({ name: `Skill ${i}`, category: 'tool' }));

    const result = await call('add_skill', { skills: vinte, confirm: true });

    expect(result.changes).toHaveLength(20);
    expect(await skills()).toHaveLength(21);
    expect(await h.commits()).toEqual([expect.stringMatching(/^\w+: /), OUTSIDE_CHANGES]);
  });

  it('recusa nome repetido dentro do próprio lote, ignorando caixa', async () => {
    const result = await raw('add_skill', {
      skills: [
        { name: 'Go', category: 'language' },
        { name: 'go', category: 'language' },
      ],
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/skills\[1\]/);
  });

  it('aceita evidência que aponta para experiência já existente junto com outras skills', async () => {
    await call('add_skill', {
      skills: [
        { name: 'Go', category: 'language', evidence: [{ type: 'experience', ref: 'acme-2023' }] },
        { name: 'Rust', category: 'language' },
      ],
      confirm: true,
    });

    expect((await skills()).map((s) => s.name)).toEqual(['TypeScript', 'Go', 'Rust']);
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
    expect(await h.commits()).toEqual([]);
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

const COM_FORMACAO = `
profile:
  name: Everton
  headline: Desenvolvedor
education:
  - id: usp-2015
    institution: USP
    degree: Bacharelado
    field: Ciência da Computação
    start: 01/02/2015
    end: 01/12/2019
    provenance: { verified: true }
skills:
  - name: Algoritmos
    category: practice
    evidence:
      - type: education
        ref: usp-2015
`;

const SEM_SKILLS = COM_FORMACAO.replace(/skills:[\s\S]*$/, '');

const education = async (): Promise<Record<string, unknown>[]> =>
  (await h.readResource('career://education')) as Record<string, unknown>[];

const FORMACAO = {
  id: 'fiap-2020',
  institution: 'FIAP',
  degree: 'MBA',
  start: '01/03/2020',
};

describe('add_education', () => {
  beforeEach(() => h.writeCareer(COM_FORMACAO));

  it('sem confirm mostra o que faria e não escreve', async () => {
    const antes = await h.readCareer();

    const result = await call('add_education', { education: [FORMACAO] });

    expect(result.applied).toBe(false);
    expect(result.changes).toEqual([
      expect.objectContaining({ path: 'education[fiap-2020]', kind: 'added' }),
    ]);
    expect(await h.readCareer()).toBe(antes);
  });

  it('com confirm grava não verificada, com end null por padrão', async () => {
    const result = await call('add_education', { education: [FORMACAO], confirm: true });

    expect(result.applied).toBe(true);
    expect((await education()).find((e) => e.id === 'fiap-2020')).toMatchObject({
      end: null,
      provenance: { verified: false, source: 'manual' },
    });
    expect(await h.commits()).toEqual([expect.stringMatching(/^\w+: /), OUTSIDE_CHANGES]);
  });

  it('recusa id que já existe', async () => {
    const result = await raw('add_education', {
      education: [{ ...FORMACAO, id: 'usp-2015' }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/usp-2015/);
  });

  it('recusa end anterior a start', async () => {
    const result = await raw('add_education', {
      education: [{ ...FORMACAO, end: '01/01/2019' }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
  });

  it('grava várias numa chamada', async () => {
    await call('add_education', {
      education: [FORMACAO, { ...FORMACAO, id: 'fiap-2022', degree: 'Pós' }],
      confirm: true,
    });

    expect((await education()).map((e) => e.id)).toEqual(['usp-2015', 'fiap-2020', 'fiap-2022']);
  });
});

describe('update_education', () => {
  beforeEach(() => h.writeCareer(COM_FORMACAO));

  it('aplica patch parcial preservando o resto e o verified', async () => {
    const result = await call('update_education', {
      id: 'usp-2015',
      patch: { degree: 'Licenciatura' },
      confirm: true,
    });

    expect(result.changes).toEqual([
      {
        path: 'education[usp-2015].degree',
        kind: 'changed',
        before: 'Bacharelado',
        after: 'Licenciatura',
      },
    ]);
    expect((await education())[0]).toMatchObject({
      institution: 'USP',
      degree: 'Licenciatura',
      provenance: { verified: true },
    });
  });

  it('recusa id inexistente', async () => {
    const result = await raw('update_education', {
      id: 'fantasma',
      patch: { degree: 'X' },
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/fantasma/);
  });
});

describe('delete_education', () => {
  it('é marcada como destrutiva', async () => {
    const { tools } = await h.client.listTools();

    expect(tools.find((t) => t.name === 'delete_education')?.annotations?.destructiveHint).toBe(
      true,
    );
  });

  it('com confirm remove e versiona', async () => {
    await h.writeCareer(SEM_SKILLS);

    await call('delete_education', { id: 'usp-2015', confirm: true });

    expect(await education()).toEqual([]);
    expect(await h.commits()).toEqual([expect.stringMatching(/^\w+: /), OUTSIDE_CHANGES]);
  });

  it('recusa remover formação citada como evidência de uma skill', async () => {
    await h.writeCareer(COM_FORMACAO);

    const result = await raw('delete_education', { id: 'usp-2015', confirm: true });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Algoritmos/);
  });
});

const COM_CERTIFICACAO = `
profile:
  name: Everton
  headline: Desenvolvedor
certifications:
  - id: aws-saa
    name: AWS Solutions Architect
    issuer: AWS
    issued_at: 01/06/2024
    provenance: { verified: true }
skills:
  - name: AWS
    category: platform
    evidence:
      - type: certification
        ref: aws-saa
`;

const certifications = async (): Promise<Record<string, unknown>[]> =>
  (await h.readResource('career://certifications')) as Record<string, unknown>[];

const CERTIFICACAO = {
  id: 'cka',
  name: 'Certified Kubernetes Administrator',
  issuer: 'CNCF',
  issued_at: '01/02/2025',
};

describe('add_certification', () => {
  beforeEach(() => h.writeCareer(COM_CERTIFICACAO));

  it('sem confirm mostra o que faria e não escreve', async () => {
    const antes = await h.readCareer();

    const result = await call('add_certification', { certifications: [CERTIFICACAO] });

    expect(result.changes).toEqual([
      expect.objectContaining({ path: 'certifications[cka]', kind: 'added' }),
    ]);
    expect(await h.readCareer()).toBe(antes);
  });

  it('com confirm grava não verificada, com expires_at null por padrão', async () => {
    const result = await call('add_certification', {
      certifications: [CERTIFICACAO],
      confirm: true,
    });

    expect(result.applied).toBe(true);
    expect((await certifications()).find((c) => c.id === 'cka')).toMatchObject({
      expires_at: null,
      provenance: { verified: false, source: 'manual' },
    });
  });

  it('recusa id que já existe', async () => {
    const result = await raw('add_certification', {
      certifications: [{ ...CERTIFICACAO, id: 'aws-saa' }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/aws-saa/);
  });

  it('recusa expires_at anterior a issued_at', async () => {
    const result = await raw('add_certification', {
      certifications: [{ ...CERTIFICACAO, expires_at: '01/01/2025' }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
  });

  it('grava várias numa chamada', async () => {
    await call('add_certification', {
      certifications: [CERTIFICACAO, { ...CERTIFICACAO, id: 'ckad', name: 'CKAD' }],
      confirm: true,
    });

    expect((await certifications()).map((c) => c.id)).toEqual(['aws-saa', 'cka', 'ckad']);
  });
});

describe('update_certification', () => {
  beforeEach(() => h.writeCareer(COM_CERTIFICACAO));

  it('aplica patch parcial preservando o resto e o verified', async () => {
    await call('update_certification', {
      id: 'aws-saa',
      patch: { expires_at: '01/06/2027' },
      confirm: true,
    });

    expect((await certifications())[0]).toMatchObject({
      name: 'AWS Solutions Architect',
      expires_at: '01/06/2027',
      provenance: { verified: true },
    });
  });

  it('recusa id inexistente', async () => {
    const result = await raw('update_certification', {
      id: 'fantasma',
      patch: { issuer: 'X' },
      confirm: true,
    });

    expect(result.isError).toBe(true);
  });
});

describe('delete_certification', () => {
  it('é marcada como destrutiva', async () => {
    const { tools } = await h.client.listTools();

    expect(
      tools.find((t) => t.name === 'delete_certification')?.annotations?.destructiveHint,
    ).toBe(true);
  });

  it('com confirm remove e versiona', async () => {
    await h.writeCareer(COM_CERTIFICACAO.replace(/skills:[\s\S]*$/, ''));

    await call('delete_certification', { id: 'aws-saa', confirm: true });

    expect(await certifications()).toEqual([]);
    expect(await h.commits()).toEqual([expect.stringMatching(/^\w+: /), OUTSIDE_CHANGES]);
  });

  it('recusa remover certificação citada como evidência de uma skill', async () => {
    await h.writeCareer(COM_CERTIFICACAO);

    const result = await raw('delete_certification', { id: 'aws-saa', confirm: true });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/AWS/);
  });
});

const COM_IDIOMA = `
profile:
  name: Everton
  headline: Desenvolvedor
languages:
  - name: Inglês
    level: B2
`;

const languages = async (): Promise<Record<string, unknown>[]> =>
  (await h.readResource('career://languages')) as Record<string, unknown>[];

describe('add_language', () => {
  beforeEach(() => h.writeCareer(COM_IDIOMA));

  it('sem confirm mostra o que faria e não escreve', async () => {
    const antes = await h.readCareer();

    const result = await call('add_language', { languages: [{ name: 'Espanhol', level: 'A2' }] });

    expect(result.changes).toEqual([
      expect.objectContaining({ path: 'languages[Espanhol]', kind: 'added' }),
    ]);
    expect(await h.readCareer()).toBe(antes);
  });

  it('com confirm grava e versiona', async () => {
    await call('add_language', { languages: [{ name: 'Espanhol', level: 'A2' }], confirm: true });

    expect(await languages()).toEqual([
      { name: 'Inglês', level: 'B2' },
      { name: 'Espanhol', level: 'A2' },
    ]);
    expect(await h.commits()).toEqual([expect.stringMatching(/^\w+: /), OUTSIDE_CHANGES]);
  });

  it('recusa idioma que já existe, ignorando maiúsculas', async () => {
    const result = await raw('add_language', {
      languages: [{ name: 'inglês', level: 'C1' }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/update_language/);
  });

  it('recusa level fora do CEFR', async () => {
    const result = await raw('add_language', {
      languages: [{ name: 'Francês', level: 'fluente' }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
  });

  it('grava vários numa chamada', async () => {
    await call('add_language', {
      languages: [
        { name: 'Espanhol', level: 'A2' },
        { name: 'Francês', level: 'A1' },
      ],
      confirm: true,
    });

    expect((await languages()).map((l) => l.name)).toEqual(['Inglês', 'Espanhol', 'Francês']);
  });

  it('recusa idioma repetido dentro do próprio lote', async () => {
    const result = await raw('add_language', {
      languages: [
        { name: 'Espanhol', level: 'A2' },
        { name: 'ESPANHOL', level: 'B1' },
      ],
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/languages\[1\]/);
  });
});

describe('update_language', () => {
  beforeEach(() => h.writeCareer(COM_IDIOMA));

  it('muda o level achando o idioma pelo nome, ignorando maiúsculas', async () => {
    const result = await call('update_language', {
      name: 'INGLÊS',
      patch: { level: 'C1' },
      confirm: true,
    });

    expect(result.changes).toEqual([
      { path: 'languages[Inglês].level', kind: 'changed', before: 'B2', after: 'C1' },
    ]);
  });

  it('recusa idioma inexistente', async () => {
    const result = await raw('update_language', {
      name: 'Alemão',
      patch: { level: 'A1' },
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Alemão/);
  });
});

describe('delete_language', () => {
  beforeEach(() => h.writeCareer(COM_IDIOMA));

  it('é marcada como destrutiva', async () => {
    const { tools } = await h.client.listTools();

    expect(tools.find((t) => t.name === 'delete_language')?.annotations?.destructiveHint).toBe(
      true,
    );
  });

  it('com confirm remove pelo nome e versiona', async () => {
    await call('delete_language', { name: 'inglês', confirm: true });

    expect(await languages()).toEqual([]);
    expect(await h.commits()).toEqual([expect.stringMatching(/^\w+: /), OUTSIDE_CHANGES]);
  });

  it('recusa idioma inexistente', async () => {
    const result = await raw('delete_language', { name: 'Alemão', confirm: true });

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
    expect(await h.commits()).toEqual([expect.stringMatching(/^\w+: /), OUTSIDE_CHANGES]);
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
      // Não havia arquivo antes: a criação é o primeiro commit, sem mudança externa.
      expect(await h.commits()).toEqual(['update_profile: profile']);
    });

    it('recusa criar sem name e headline', async () => {
      const result = await raw('update_profile', { patch: { name: 'Everton' }, confirm: true });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/profile\.headline/);
      await expect(h.readCareer()).rejects.toThrow();
    });
  });
});
