import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import { createApp } from '../../http/app.js';

const TOKEN = 'token-de-teste';

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
`;

let dir: string;
let careerPath: string;
let client: Client;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'career-'));
  careerPath = path.join(dir, 'career.yml');
  await writeFile(careerPath, CAREER_YAML);

  const app = createApp(loadConfig({ MCP_AUTH_TOKEN: TOKEN, CAREER_DATA_DIR: dir }));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('sem porta');

  client = new Client({ name: 'vitest', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );
});

afterAll(async () => {
  await client.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await writeFile(careerPath, CAREER_YAML);
});

async function read(uri: string): Promise<unknown> {
  const [content] = (await client.readResource({ uri })).contents;
  if (content === undefined || !('text' in content)) throw new Error(`${uri} não veio como texto`);

  return JSON.parse(content.text);
}

describe('resources career://', () => {
  it('lista os cinco resources de leitura', async () => {
    const { resources } = await client.listResources();

    expect(resources.map((r) => r.uri).sort()).toEqual([
      'career://education',
      'career://experiences',
      'career://profile',
      'career://projects',
      'career://skills',
    ]);
  });

  it('anuncia mimeType application/json', async () => {
    const { resources } = await client.listResources();

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

  it('reflete alteração no arquivo sem reiniciar o servidor', async () => {
    await writeFile(careerPath, CAREER_YAML.replace('Desenvolvedor', 'Tech Lead'));

    expect(await read('career://profile')).toMatchObject({ headline: 'Tech Lead' });
  });

  it('falha em uri desconhecida', async () => {
    await expect(client.readResource({ uri: 'career://inexistente' })).rejects.toThrow();
  });

  it('propaga erro de validação citando o campo', async () => {
    await writeFile(careerPath, CAREER_YAML.replace('01/03/2023', '2023-03'));

    await expect(client.readResource({ uri: 'career://experiences' })).rejects.toThrow(
      /experiences\.0\.start/,
    );
  });

  it('propaga erro quando o career.yml não existe', async () => {
    await rm(careerPath);

    await expect(client.readResource({ uri: 'career://profile' })).rejects.toThrow(/career\.yml/);
  });
});
