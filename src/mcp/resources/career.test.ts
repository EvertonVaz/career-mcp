import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../../test/harness.js';

const CAREER_YAML = `
profile:
  name: Everton
  headline: Desenvolvedor
  links:
    github: https://github.com/etovaz
experiences:
  - id: acme-2023
    company: Acme
    role: Backend Dev
    start: 01/03/2023
    tech:
      - TypeScript
projects:
  - id: career-mcp
    name: career-mcp
    stack:
      - TypeScript
skills:
  - name: TypeScript
    category: language
education:
  - id: fatec
    institution: FATEC
    degree: Tecnólogo
    start: 01/02/2018
    end: 01/12/2020
certifications:
  - id: aws-saa
    name: AWS Solutions Architect Associate
    issuer: AWS
    issued_at: 01/09/2024
languages:
  - name: Português
    level: native
  - name: Inglês
    level: B2
`;

let h: Harness;

beforeAll(async () => {
  h = await startHarness(CAREER_YAML);
});

afterAll(() => h.close());

beforeEach(() => h.writeCareer(CAREER_YAML));

const read = (uri: string): Promise<unknown> => h.readResource(uri);

describe('resources career://', () => {
  it('lista as sete fatias de career://', async () => {
    const { resources } = await h.client.listResources();
    const career = resources.filter((r) => r.uri.startsWith('career://'));

    expect(career.map((r) => r.uri).sort()).toEqual([
      'career://certifications',
      'career://education',
      'career://experiences',
      'career://languages',
      'career://profile',
      'career://projects',
      'career://skills',
    ]);
  });

  it('anuncia mimeType application/json', async () => {
    const { resources } = await h.client.listResources();

    expect(resources.every((r) => r.mimeType === 'application/json')).toBe(true);
  });

  it('lê o profile', async () => {
    expect(await read('career://profile')).toEqual({
      name: 'Everton',
      headline: 'Desenvolvedor',
      links: { github: 'https://github.com/etovaz' },
    });
  });

  it('lê experiences já com os defaults do schema aplicados', async () => {
    const experiences = (await read('career://experiences')) as Record<string, unknown>[];

    expect(experiences).toHaveLength(1);
    expect(experiences[0]).toMatchObject({
      id: 'acme-2023',
      end: null,
      provenance: { verified: false, source: 'manual' },
    });
  });

  it('lê projects, skills e education', async () => {
    expect((await read('career://projects')) as unknown[]).toHaveLength(1);
    expect((await read('career://skills')) as unknown[]).toHaveLength(1);
    expect((await read('career://education')) as unknown[]).toHaveLength(1);
  });

  it('lê certifications e languages', async () => {
    expect(await read('career://certifications')).toEqual([
      {
        id: 'aws-saa',
        name: 'AWS Solutions Architect Associate',
        issuer: 'AWS',
        issued_at: '01/09/2024',
        expires_at: null,
        provenance: { verified: false, source: 'manual' },
      },
    ]);
    expect(await read('career://languages')).toEqual([
      { name: 'Português', level: 'native' },
      { name: 'Inglês', level: 'B2' },
    ]);
  });

  it('reflete alteração no arquivo sem reiniciar o servidor', async () => {
    await h.writeCareer(CAREER_YAML.replace('Desenvolvedor', 'Tech Lead'));

    expect(await read('career://profile')).toMatchObject({ headline: 'Tech Lead' });
  });

  it('falha em uri desconhecida', async () => {
    await expect(h.client.readResource({ uri: 'career://inexistente' })).rejects.toThrow();
  });

  it('propaga erro de validação citando o campo', async () => {
    await h.writeCareer(CAREER_YAML.replace('01/03/2023', '2023-03'));

    await expect(h.client.readResource({ uri: 'career://experiences' })).rejects.toThrow(
      /experiences\.0\.start/,
    );
  });

  it('propaga erro quando o career.yml não existe', async () => {
    await h.removeCareer();

    await expect(h.client.readResource({ uri: 'career://profile' })).rejects.toThrow(/career\.yml/);
  });
});
