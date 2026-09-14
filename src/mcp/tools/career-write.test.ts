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
    bullets:
      - Migrou a API para TypeScript
    tech: [TypeScript]
    provenance: { verified: true }
skills:
  - name: TypeScript
    category: language
    evidence:
      - type: experience
        ref: acme-2023
`;

type WriteResult = {
  applied: boolean;
  changes: { path: string; kind: string }[];
};

type Experience = {
  id: string;
  company: string;
  role: string;
  start: string;
  end: string | null;
  bullets: string[];
  tech: string[];
  location?: string;
  provenance: { verified: boolean; source: string };
};

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

async function experiences(): Promise<Experience[]> {
  return (await h.readResource('career://experiences')) as Experience[];
}

const NOVA = {
  id: 'beta-2021',
  company: 'Beta',
  role: 'Dev Pleno',
  start: '01/02/2021',
  end: '01/02/2023',
};

describe('add_experience', () => {
  it('sem confirm mostra o que faria e não escreve', async () => {
    const antes = await h.readCareer();

    const result = await call('add_experience', { experiences: [NOVA] });

    expect(result.applied).toBe(false);
    expect(result.changes).toEqual([
      expect.objectContaining({ path: 'experiences[beta-2021]', kind: 'added' }),
    ]);
    expect(await h.readCareer()).toBe(antes);
    expect(await h.commits()).toEqual([]);
  });

  it('com confirm escreve e versiona', async () => {
    const result = await call('add_experience', { experiences: [NOVA], confirm: true });

    expect(result.applied).toBe(true);
    expect((await experiences()).map((e) => e.id)).toEqual(['acme-2023', 'beta-2021']);
    expect(await h.commits()).toEqual([expect.stringMatching(/^\w+: /), OUTSIDE_CHANGES]);
  });

  it('nasce como não verificada, de origem manual', async () => {
    await call('add_experience', { experiences: [NOVA], confirm: true });

    const nova = (await experiences()).find((e) => e.id === 'beta-2021');
    expect(nova?.provenance).toEqual({ verified: false, source: 'manual' });
  });

  it('aplica os defaults do schema', async () => {
    await call('add_experience', {
      experiences: [{ id: 'gama', company: 'Gama', role: 'Dev', start: '01/01/2019' }],
      confirm: true,
    });

    const gama = (await experiences()).find((e) => e.id === 'gama');
    expect(gama).toMatchObject({ end: null, bullets: [], tech: [] });
  });

  it('recusa id que já existe', async () => {
    const result = await raw('add_experience', {
      experiences: [{ ...NOVA, id: 'acme-2023' }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/acme-2023/);
  });

  it('recusa data fora do formato', async () => {
    const result = await raw('add_experience', {
      experiences: [{ ...NOVA, start: '2021-02' }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/DD\/MM\/YYYY/);
  });

  it('já recusa no preview, sem esperar o confirm', async () => {
    const result = await raw('add_experience', {
      experiences: [{ ...NOVA, id: 'acme-2023' }],
    });

    expect(result.isError).toBe(true);
  });

  it('recusa end anterior a start', async () => {
    const result = await raw('add_experience', {
      experiences: [{ ...NOVA, start: '01/02/2023', end: '01/02/2021' }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
  });

  describe('em lote', () => {
    const GAMA = { id: 'gama', company: 'Gama', role: 'Dev', start: '01/01/2019' };
    const DELTA = { id: 'delta', company: 'Delta', role: 'Dev', start: '01/01/2018' };

    it('grava todas numa escrita só, com um commit', async () => {
      const result = await call('add_experience', {
        experiences: [NOVA, GAMA, DELTA],
        confirm: true,
      });

      expect(result.changes).toHaveLength(3);
      expect((await experiences()).map((e) => e.id)).toEqual([
        'acme-2023',
        'beta-2021',
        'gama',
        'delta',
      ]);
      expect(await h.commits()).toEqual([expect.stringMatching(/^\w+: /), OUTSIDE_CHANGES]);
    });

    it('é tudo ou nada: um item inválido não grava nenhum', async () => {
      const antes = await h.readCareer();

      const result = await raw('add_experience', {
        experiences: [GAMA, { ...DELTA, id: 'acme-2023' }],
        confirm: true,
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/experiences\[1\]/);
      expect(await h.readCareer()).toBe(antes);
    });

    it('recusa id repetido dentro do próprio lote', async () => {
      const result = await raw('add_experience', {
        experiences: [GAMA, { ...DELTA, id: 'gama' }],
        confirm: true,
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/experiences\[1\].*gama/);
    });

    it('recusa lista vazia', async () => {
      const result = await raw('add_experience', { experiences: [], confirm: true });

      expect(result.isError).toBe(true);
    });

    it('recusa mais de 50 itens', async () => {
      const muitas = Array.from({ length: 51 }, (_, i) => ({ ...GAMA, id: `job-${i}` }));

      const result = await raw('add_experience', { experiences: muitas, confirm: true });

      expect(result.isError).toBe(true);
    });
  });
});

describe('update_experience', () => {
  it('sem confirm mostra o diff e não escreve', async () => {
    const antes = await h.readCareer();

    const result = await call('update_experience', {
      id: 'acme-2023',
      patch: { role: 'Tech Lead' },
    });

    expect(result.changes).toEqual([
      {
        path: 'experiences[acme-2023].role',
        kind: 'changed',
        before: 'Backend Dev',
        after: 'Tech Lead',
      },
    ]);
    expect(await h.readCareer()).toBe(antes);
  });

  it('aplica patch parcial preservando o resto', async () => {
    await call('update_experience', {
      id: 'acme-2023',
      patch: { role: 'Tech Lead' },
      confirm: true,
    });

    const acme = (await experiences())[0];
    expect(acme?.role).toBe('Tech Lead');
    expect(acme?.company).toBe('Acme');
    expect(acme?.bullets).toEqual(['Migrou a API para TypeScript']);
  });

  it('preserva o verified que já estava lá', async () => {
    await call('update_experience', {
      id: 'acme-2023',
      patch: { role: 'Tech Lead' },
      confirm: true,
    });

    expect((await experiences())[0]?.provenance.verified).toBe(true);
  });

  it('substitui array inteiro em vez de mesclar', async () => {
    await call('update_experience', {
      id: 'acme-2023',
      patch: { bullets: ['Outro bullet'] },
      confirm: true,
    });

    expect((await experiences())[0]?.bullets).toEqual(['Outro bullet']);
  });

  it('permite encerrar a experiência mandando end', async () => {
    await call('update_experience', {
      id: 'acme-2023',
      patch: { end: '01/06/2025' },
      confirm: true,
    });

    expect((await experiences())[0]?.end).toBe('01/06/2025');
  });

  it('não escreve nem versiona quando o patch não muda nada', async () => {
    const result = await call('update_experience', {
      id: 'acme-2023',
      patch: { role: 'Backend Dev' },
      confirm: true,
    });

    expect(result.changes).toEqual([]);
    expect(result.applied).toBe(false);
    expect(await h.commits()).toEqual([]);
  });

  it('recusa id inexistente', async () => {
    const result = await raw('update_experience', {
      id: 'fantasma',
      patch: { role: 'X' },
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/fantasma/);
  });
});

describe('delete_experience', () => {
  it('é marcada como destrutiva', async () => {
    const { tools } = await h.client.listTools();
    const tool = tools.find((t) => t.name === 'delete_experience');

    expect(tool?.annotations?.destructiveHint).toBe(true);
  });

  it('sem confirm mostra a remoção e não escreve', async () => {
    await h.writeCareer(CAREER.replace(/skills:[\s\S]*$/, ''));
    const antes = await h.readCareer();

    const result = await call('delete_experience', { id: 'acme-2023' });

    expect(result.changes).toEqual([
      expect.objectContaining({ path: 'experiences[acme-2023]', kind: 'removed' }),
    ]);
    expect(await h.readCareer()).toBe(antes);
  });

  it('com confirm remove e versiona', async () => {
    await h.writeCareer(CAREER.replace(/skills:[\s\S]*$/, ''));

    await call('delete_experience', { id: 'acme-2023', confirm: true });

    expect(await experiences()).toEqual([]);
    expect(await h.commits()).toEqual([expect.stringMatching(/^\w+: /), OUTSIDE_CHANGES]);
  });

  it('recusa remover experiência citada como evidência de uma skill', async () => {
    const result = await raw('delete_experience', { id: 'acme-2023', confirm: true });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/TypeScript/);
  });

  it('recusa id inexistente', async () => {
    const result = await raw('delete_experience', { id: 'fantasma', confirm: true });

    expect(result.isError).toBe(true);
  });
});

describe('escritas simultâneas', () => {
  it('não perdem dados', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `job-${i}`);

    await Promise.all(
      ids.map((id) =>
        call('add_experience', {
          experiences: [{ id, company: 'Acme', role: 'Dev', start: '01/01/2020' }],
          confirm: true,
        }),
      ),
    );

    expect((await experiences()).map((item) => item.id).sort()).toEqual(
      ['acme-2023', ...ids].sort(),
    );
  });
});
