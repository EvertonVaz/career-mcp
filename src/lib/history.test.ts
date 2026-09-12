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

describe('diffCareer', () => {
  it('não acusa mudança quando nada mudou', () => {
    expect(diffCareer(career(), career())).toEqual([]);
  });

  it('detecta campo alterado com caminho legível', () => {
    const before = career();
    const after = career();
    after.experiences[0]!.role = 'Tech Lead';

    expect(diffCareer(before, after)).toEqual<Change[]>([
      { path: 'experiences.0.role', kind: 'changed', before: 'Backend Dev', after: 'Tech Lead' },
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

  it('detecta item novo em array', () => {
    const before = career();
    const after = career();
    after.experiences.push({ ...before.experiences[0]!, id: 'beta-2025' });

    const changes = diffCareer(before, after);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.path).toBe('experiences.1');
    expect(changes[0]?.kind).toBe('added');
  });

  it('trata null como valor, não como ausência', () => {
    const before = career();
    const after = career();
    after.experiences[0]!.end = '01/06/2024';

    expect(diffCareer(before, after)).toEqual<Change[]>([
      { path: 'experiences.0.end', kind: 'changed', before: null, after: '01/06/2024' },
    ]);
  });

  it('acumula várias mudanças', () => {
    const before = career();
    const after = career();
    after.profile.headline = 'Tech Lead';
    after.experiences[0]!.tech.push('TypeScript');

    expect(diffCareer(before, after)).toHaveLength(2);
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
