import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CareerValidationError,
  loadCareer,
  loadPrivate,
  saveCareer,
  withCareerLock,
} from './loader.js';
import type { Career } from './schema.js';

const VALID_YAML = `
profile:
  name: Everton
  headline: Dev
experiences:
  - id: acme-2023
    company: Acme
    role: Backend Dev
    start: 01/03/2023
`;

let dir: string;
let careerPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'career-'));
  careerPath = path.join(dir, 'career.yml');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadCareer', () => {
  it('lê, valida e aplica os defaults', async () => {
    await writeFile(careerPath, VALID_YAML);

    const career = await loadCareer(careerPath);

    expect(career.profile.name).toBe('Everton');
    expect(career.experiences[0]?.end).toBeNull();
    expect(career.projects).toEqual([]);
  });

  it('mantém a data como string, não converte para Date', async () => {
    await writeFile(careerPath, VALID_YAML);

    const career = await loadCareer(careerPath);

    expect(career.experiences[0]?.start).toBe('01/03/2023');
  });

  it('falha citando o caminho quando o arquivo não existe', async () => {
    await expect(loadCareer(careerPath)).rejects.toThrow(careerPath);
  });

  it('falha com YAML malformado', async () => {
    await writeFile(careerPath, 'profile:\n  name: [aberto\n');

    await expect(loadCareer(careerPath)).rejects.toThrow(/YAML/i);
  });

  it('reporta as issues do Zod com caminho legível', async () => {
    await writeFile(careerPath, 'profile:\n  name: Everton\n  headline: Dev\nexperiences:\n  - id: a\n    company: Acme\n    role: Dev\n    start: 2023-03\n');

    const error = await loadCareer(careerPath).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CareerValidationError);
    expect((error as CareerValidationError).issues[0]?.path).toBe('experiences.0.start');
    expect((error as CareerValidationError).issues[0]?.message).toContain('DD/MM/YYYY');
  });
});

describe('loadPrivate', () => {
  it('devolve objeto vazio quando o arquivo não existe', async () => {
    expect(await loadPrivate(path.join(dir, 'private.yml'))).toEqual({});
  });

  it('lê o arquivo quando existe', async () => {
    const privatePath = path.join(dir, 'private.yml');
    await writeFile(privatePath, 'phone: "+55 11 90000-0000"\n');

    expect(await loadPrivate(privatePath)).toEqual({ phone: '+55 11 90000-0000' });
  });
});

describe('saveCareer', () => {
  async function load(): Promise<Career> {
    await writeFile(careerPath, VALID_YAML);
    return loadCareer(careerPath);
  }

  it('faz round-trip sem perder nem converter nada', async () => {
    const career = await load();

    await saveCareer(careerPath, career);

    const reloaded = await loadCareer(careerPath);
    expect(reloaded.experiences).toEqual(career.experiences);
    expect(reloaded.profile).toEqual(career.profile);
  });

  it('carimba meta.updated_at', async () => {
    const career = await load();

    await saveCareer(careerPath, career);

    const stamp = (await loadCareer(careerPath)).meta.updated_at;
    expect(stamp).toBeDefined();
    expect(Date.now() - Date.parse(stamp as string)).toBeLessThan(5000);
  });

  it('valida antes de gravar e deixa o arquivo anterior intacto', async () => {
    const career = await load();
    const before = await readFile(careerPath, 'utf8');
    const corrupted = { ...career, experiences: [{ ...career.experiences[0], start: 'ontem' }] };

    await expect(saveCareer(careerPath, corrupted as unknown as Career)).rejects.toThrow(
      CareerValidationError,
    );
    expect(await readFile(careerPath, 'utf8')).toBe(before);
  });

  it('não deixa arquivo temporário para trás', async () => {
    const career = await load();

    await saveCareer(careerPath, career);

    expect(await readdir(dir)).toEqual(['career.yml']);
  });

  it('serializa load → save concorrentes no mesmo arquivo', async () => {
    await load();

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        withCareerLock(careerPath, async () => {
          const career = await loadCareer(careerPath);
          const nova = { ...career.experiences[0], id: `job-${i}` } as Career['experiences'][number];
          await saveCareer(careerPath, { ...career, experiences: [...career.experiences, nova] });
        }),
      ),
    );

    expect((await loadCareer(careerPath)).experiences).toHaveLength(11);
  });

  it('libera o lock quando a operação falha', async () => {
    await expect(
      withCareerLock(careerPath, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await withCareerLock(careerPath, async () => 'ok')).toBe('ok');
  });

  it('cria o arquivo quando ainda não existe', async () => {
    const career = await load();
    const novo = path.join(dir, 'outro.yml');

    await saveCareer(novo, career);

    expect((await loadCareer(novo)).profile.name).toBe('Everton');
  });
});
