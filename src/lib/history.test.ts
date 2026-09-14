import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commitCareer,
  diffCareer,
  OUTSIDE_CHANGES,
  prepareHistory,
  type Change,
} from './history.js';
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


describe('histórico em Git', () => {
  const execFileAsync = promisify(execFile);

  let dir: string;
  let careerPath: string;

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', dir, ...args]);
    return stdout;
  }

  const subjects = async (): Promise<string[]> =>
    (await git('log', '--all', '--format=%s')).split('\n').filter(Boolean);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'career-'));
    careerPath = path.join(dir, 'career.yml');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  const HEADLINE: Change[] = [
    { path: 'profile.headline', kind: 'changed', before: 'Dev', after: 'Tech Lead' },
  ];

  describe('prepareHistory', () => {
    it('transforma o diretório do career.yml num repositório', async () => {
      await prepareHistory(careerPath);

      expect((await git('rev-parse', '--show-toplevel')).trim()).toBe(await realpath(dir));
    });

    it('não commita nada quando o arquivo ainda não existe', async () => {
      await prepareHistory(careerPath);

      expect(await subjects()).toEqual([]);
    });

    it('commita o arquivo que existia sem versionamento como mudança externa', async () => {
      await writeFile(careerPath, 'profile:\n  name: Everton\n');

      await prepareHistory(careerPath);

      expect(await subjects()).toEqual([OUTSIDE_CHANGES]);
    });

    it('commita à parte a edição manual feita depois do último commit', async () => {
      await prepareHistory(careerPath);
      await writeFile(careerPath, 'profile:\n  headline: Tech Lead\n');
      await commitCareer(careerPath, 'update_profile', HEADLINE);

      await writeFile(careerPath, 'profile:\n  headline: Editado na mão\n');
      await prepareHistory(careerPath);

      expect(await subjects()).toEqual([OUTSIDE_CHANGES, 'update_profile: profile.headline']);
    });

    it('não gera commit quando não há nada pendente', async () => {
      await writeFile(careerPath, 'profile:\n  name: Everton\n');

      await prepareHistory(careerPath);
      await prepareHistory(careerPath);

      expect(await subjects()).toHaveLength(1);
    });

    it('ignora GIT_DIR herdado do ambiente', async () => {
      // Rodando dentro de um hook do Git, GIT_DIR aponta para outro repo.
      const outro = await mkdtemp(path.join(tmpdir(), 'outro-'));
      vi.stubEnv('GIT_DIR', path.join(outro, '.git'));
      await writeFile(careerPath, 'profile:\n  name: Everton\n');

      await prepareHistory(careerPath);
      vi.unstubAllEnvs();

      expect(await subjects()).toEqual([OUTSIDE_CHANGES]);
      await rm(outro, { recursive: true, force: true });
    });
  });

  describe('commitCareer', () => {
    beforeEach(async () => {
      await prepareHistory(careerPath);
      await writeFile(careerPath, 'profile:\n  headline: Tech Lead\n');
    });

    it('põe a tool e o path no título e as mudanças no corpo', async () => {
      await commitCareer(careerPath, 'update_profile', HEADLINE);

      expect((await git('log', '-1', '--format=%B')).trim()).toBe(
        'update_profile: profile.headline\n\nchanged profile.headline',
      );
    });

    it('conta no título as mudanças além da primeira', async () => {
      await commitCareer(careerPath, 'add_skill', [
        { path: 'skills[Go]', kind: 'added' },
        { path: 'skills[Rust]', kind: 'added' },
        { path: 'skills[Zig]', kind: 'added' },
      ]);

      expect(await subjects()).toEqual(['add_skill: skills[Go] (+2)']);
    });

    it('versiona só o career.yml', async () => {
      await writeFile(path.join(dir, 'private.yml'), 'phone: "123"\n');

      await commitCareer(careerPath, 'update_profile', HEADLINE);

      expect((await git('ls-files')).trim()).toBe('career.yml');
    });

    it('assina como career-mcp', async () => {
      await commitCareer(careerPath, 'update_profile', HEADLINE);

      expect((await git('log', '-1', '--format=%an <%ae>')).trim()).toBe(
        'career-mcp <career-mcp@localhost>',
      );
    });
  });
});
