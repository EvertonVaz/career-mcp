import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffCareer, snapshotBeforeWrite, type Change } from './history.js';
import { CareerFile, type Career } from './schema.js';

function career(overrides: Partial<Career> = {}): Career {
  return CareerFile.parse({
    profile: { name: 'Everton', headline: 'Dev' },
    experiences: [
      { id: 'acme-2023', company: 'Acme', role: 'Backend Dev', start: '01/03/2023' },
    ],
    ...overrides,
  });
}

/** Experience derivada da fixture, com id e campos próprios. */
function exp(id: string, over: Partial<Career['experiences'][number]> = {}) {
  return {
    id,
    company: id.toUpperCase(),
    role: 'Dev',
    start: '01/03/2021',
    end: null,
    bullets: [],
    tech: [],
    provenance: { verified: false, source: 'manual' as const },
    ...over,
  };
}

function withExperiences(...ids: string[]): Career {
  return career({ experiences: ids.map((id) => exp(id)) } as Partial<Career>);
}

describe('diffCareer', () => {
  it('não acusa mudança quando nada mudou', () => {
    expect(diffCareer(career(), career())).toEqual([]);
  });

  it('detecta campo alterado, com a entidade identificada por id', () => {
    const before = career();
    const after = career();
    after.experiences[0]!.role = 'Tech Lead';

    expect(diffCareer(before, after)).toEqual<Change[]>([
      {
        path: 'experiences[acme-2023].role',
        kind: 'changed',
        before: 'Backend Dev',
        after: 'Tech Lead',
      },
    ]);
  });

  it('detecta campo adicionado', () => {
    const before = career();
    const after = career();
    after.profile.location = 'São Paulo';

    expect(diffCareer(before, after)).toEqual<Change[]>([
      { path: 'profile.location', kind: 'added', after: 'São Paulo' },
    ]);
  });

  it('detecta campo removido', () => {
    const before = career();
    before.profile.summary = 'Resumo';

    expect(diffCareer(before, career())).toEqual<Change[]>([
      { path: 'profile.summary', kind: 'removed', before: 'Resumo' },
    ]);
  });

  it('trata null como valor, não como ausência', () => {
    const before = career();
    const after = career();
    after.experiences[0]!.end = '01/06/2024';

    expect(diffCareer(before, after)).toEqual<Change[]>([
      { path: 'experiences[acme-2023].end', kind: 'changed', before: null, after: '01/06/2024' },
    ]);
  });

  it('acumula várias mudanças', () => {
    const before = career();
    const after = career();
    after.profile.headline = 'Tech Lead';
    after.experiences[0]!.tech.push('TypeScript');

    expect(diffCareer(before, after)).toHaveLength(2);
  });

  // ── Entidades casadas por id ────────────────────────────────────────────────

  it('item novo vira uma única adição identificada', () => {
    const before = withExperiences('acme');
    const after = withExperiences('acme', 'beta');

    const changes = diffCareer(before, after);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('added');
    expect(changes[0]?.path).toBe('experiences[beta]');
  });

  it('remover item do meio reporta só a remoção, sem cascata de índice', () => {
    const before = withExperiences('acme', 'beta', 'ceta');
    const after = withExperiences('acme', 'ceta');

    expect(diffCareer(before, after)).toEqual<Change[]>([
      { path: 'experiences[beta]', kind: 'removed', before: exp('beta') },
    ]);
  });

  it('remover o último item reporta só a remoção', () => {
    const before = withExperiences('acme', 'beta');
    const after = withExperiences('acme');

    expect(diffCareer(before, after)).toEqual<Change[]>([
      { path: 'experiences[beta]', kind: 'removed', before: exp('beta') },
    ]);
  });

  it('remover do meio não marca os sobreviventes como movidos', () => {
    const before = withExperiences('acme', 'beta', 'ceta');
    const after = withExperiences('acme', 'ceta');

    expect(diffCareer(before, after).some((c) => c.kind === 'moved')).toBe(false);
  });

  it('reordenar reporta moved com as posições, não reescrita', () => {
    const before = withExperiences('acme', 'beta');
    const after = withExperiences('beta', 'acme');

    expect(diffCareer(before, after)).toEqual<Change[]>([
      { path: 'experiences[acme]', kind: 'moved', before: 0, after: 1 },
      { path: 'experiences[beta]', kind: 'moved', before: 1, after: 0 },
    ]);
  });

  it('separa mudança de campo de mudança de ordem', () => {
    const before = withExperiences('acme', 'beta');
    const after = career({
      experiences: [exp('beta'), exp('acme', { role: 'Tech Lead' })],
    } as Partial<Career>);

    const changes = diffCareer(before, after);

    expect(changes.filter((c) => c.kind === 'moved')).toHaveLength(2);
    expect(changes.filter((c) => c.kind === 'changed')).toEqual<Change[]>([
      { path: 'experiences[acme].role', kind: 'changed', before: 'Dev', after: 'Tech Lead' },
    ]);
  });

  it('casa skills por name, que é a chave delas', () => {
    const skill = (name: string) => ({
      name,
      category: 'language' as const,
      evidence: [],
      provenance: { verified: false, source: 'manual' as const },
    });
    const before = career({ skills: [skill('TypeScript'), skill('Go')] } as Partial<Career>);
    const after = career({ skills: [skill('TypeScript')] } as Partial<Career>);

    expect(diffCareer(before, after)).toEqual<Change[]>([
      { path: 'skills[Go]', kind: 'removed', before: skill('Go') },
    ]);
  });

  // ── Fallback para índice ────────────────────────────────────────────────────

  it('array de strings continua por índice', () => {
    const before = career();
    before.experiences[0]!.bullets = ['um', 'dois', 'tres'];
    const after = career();
    after.experiences[0]!.bullets = ['um', 'tres'];

    // Aqui o índice é o certo: bullet não tem identidade própria.
    expect(diffCareer(before, after)).toEqual<Change[]>([
      {
        path: 'experiences[acme-2023].bullets.1',
        kind: 'changed',
        before: 'dois',
        after: 'tres',
      },
      { path: 'experiences[acme-2023].bullets.2', kind: 'removed', before: 'tres' },
    ]);
  });

  it('itens sem id nem name caem para índice', () => {
    const image = (alt: string) => ({ url: 'https://exemplo.com/a.png', alt });
    const project = (images: { url: string; alt: string }[]) => ({
      id: 'portfolio',
      name: 'Portfolio',
      stack: [],
      links: {},
      images,
      highlight: false,
      provenance: { verified: false, source: 'manual' as const },
    });
    const before = career({ projects: [project([image('um'), image('dois')])] } as Partial<Career>);
    const after = career({ projects: [project([image('um')])] } as Partial<Career>);

    expect(diffCareer(before, after)).toEqual<Change[]>([
      { path: 'projects[portfolio].images.1', kind: 'removed', before: image('dois') },
    ]);
  });

  it('cai para índice quando há id repetido, em vez de engolir um dos itens', () => {
    // O schema proíbe id duplicado, mas o diff não pode depender disso: casar
    // por chave repetida sumiria com uma das mudanças sem avisar.
    const before = { experiences: [exp('acme'), exp('acme', { role: 'Lead' })] };
    const after = { experiences: [exp('acme'), exp('acme', { role: 'Arch' })] };

    expect(diffCareer(before as unknown as Career, after as unknown as Career)).toEqual<Change[]>([
      { path: 'experiences.1.role', kind: 'changed', before: 'Lead', after: 'Arch' },
    ]);
  });
});


describe('snapshotBeforeWrite', () => {
  let dir: string;
  let historyDir: string;
  let careerPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'career-'));
    historyDir = path.join(dir, 'history');
    careerPath = path.join(dir, 'career.yml');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const CHANGES: Change[] = [
    { path: 'profile.headline', kind: 'changed', before: 'Dev', after: 'Tech Lead' },
  ];

  it('devolve null quando ainda não há arquivo para preservar', async () => {
    expect(await snapshotBeforeWrite(historyDir, careerPath, CHANGES)).toBeNull();
  });

  it('copia o conteúdo exato do arquivo atual', async () => {
    await writeFile(careerPath, 'profile:\n  name: Everton\n');

    const snapshot = await snapshotBeforeWrite(historyDir, careerPath, CHANGES);

    expect(snapshot).not.toBeNull();
    expect(await readFile(snapshot!.file, 'utf8')).toBe('profile:\n  name: Everton\n');
  });

  it('grava o diff ao lado do snapshot', async () => {
    await writeFile(careerPath, 'profile:\n  name: Everton\n');

    const snapshot = await snapshotBeforeWrite(historyDir, careerPath, CHANGES);

    expect(JSON.parse(await readFile(snapshot!.diff, 'utf8'))).toEqual({
      timestamp: snapshot!.timestamp,
      source: careerPath,
      changes: CHANGES,
    });
  });

  it('cria o diretório de history quando não existe', async () => {
    await writeFile(careerPath, 'profile:\n  name: Everton\n');

    await snapshotBeforeWrite(historyDir, careerPath, CHANGES);

    expect(await readdir(historyDir)).toHaveLength(2);
  });

  it('preserva conteúdo corrompido sem tentar validar', async () => {
    await writeFile(careerPath, 'isso: [nao é yaml valido\n');

    const snapshot = await snapshotBeforeWrite(historyDir, careerPath, CHANGES);

    expect(await readFile(snapshot!.file, 'utf8')).toBe('isso: [nao é yaml valido\n');
  });

  it('não sobrescreve snapshots feitos no mesmo instante', async () => {
    await writeFile(careerPath, 'profile:\n  name: Everton\n');

    const [first, second] = await Promise.all([
      snapshotBeforeWrite(historyDir, careerPath, CHANGES),
      snapshotBeforeWrite(historyDir, careerPath, CHANGES),
    ]);

    expect(first!.file).not.toBe(second!.file);
    expect(await readdir(historyDir)).toHaveLength(4);
  });
});
