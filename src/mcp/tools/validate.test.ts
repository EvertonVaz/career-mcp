import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import { createApp } from '../../http/app.js';

const TOKEN = 'token-de-teste';

/** Tudo preenchido e confirmado: a auditoria não deve ter o que reclamar. */
const CLEAN = `
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
projects:
  - id: career-mcp
    name: career-mcp
    problem: Canais desencontrados
    solution: Servidor MCP sobre YAML
    result: Currículo e LinkedIn coerentes
    stack: [TypeScript]
    provenance: { verified: true }
skills:
  - name: TypeScript
    category: language
    evidence:
      - type: experience
        ref: acme-2023
    provenance: { verified: true }
`;

let dir: string;
let careerPath: string;
let client: Client;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

type Report = {
  valid: boolean;
  schema_issues: { path: string; message: string }[];
  warnings: { code: string; path: string; message: string }[];
  unverified: string[];
  counts?: Record<string, number>;
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'career-'));
  careerPath = path.join(dir, 'career.yml');
  await writeFile(careerPath, CLEAN);

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

async function validate(yaml: string): Promise<Report> {
  await writeFile(careerPath, yaml);
  const result = await client.callTool({ name: 'validate_all', arguments: {} });
  return result.structuredContent as unknown as Report;
}

function codes(report: Report): string[] {
  return report.warnings.map((w) => `${w.code} ${w.path}`);
}

describe('validate_all', () => {
  it('está registrada como leitura', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'validate_all');

    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it('não reclama de um career completo e confirmado', async () => {
    const report = await validate(CLEAN);

    expect(report).toMatchObject({ valid: true, schema_issues: [], warnings: [], unverified: [] });
  });

  it('conta as entidades', async () => {
    const report = await validate(CLEAN);

    expect(report.counts).toMatchObject({ experiences: 1, projects: 1, skills: 1, education: 0 });
  });

  it('acusa skill sem evidência', async () => {
    const report = await validate(CLEAN.replace(/    evidence:\n.*\n.*\n/, ''));

    expect(codes(report)).toContain('skill_without_evidence skills[TypeScript]');
  });

  it('acusa experiência sem bullets', async () => {
    const report = await validate(CLEAN.replace(/    bullets:\n.*\n/, ''));

    expect(codes(report)).toContain('experience_without_bullets experiences[acme-2023]');
  });

  it('acusa projeto sem problema, solução ou resultado', async () => {
    const report = await validate(CLEAN.replace(/    result: .*\n/, ''));

    expect(codes(report)).toContain('project_incomplete projects[career-mcp]');
  });

  it('não acusa projeto que tem os três campos', async () => {
    const report = await validate(CLEAN);

    expect(codes(report).some((c) => c.startsWith('project_incomplete'))).toBe(false);
  });

  it('lista o que ainda não foi verificado, separado dos warnings', async () => {
    const report = await validate(CLEAN.replaceAll('    provenance: { verified: true }\n', ''));

    expect(report.unverified.sort()).toEqual([
      'experiences[acme-2023]',
      'projects[career-mcp]',
      'skills[TypeScript]',
    ]);
    expect(report.warnings).toEqual([]);
  });

  it('reporta erro de schema em vez de estourar', async () => {
    const report = await validate(CLEAN.replace('01/03/2023', '2023-03'));

    expect(report.valid).toBe(false);
    expect(report.schema_issues[0]).toMatchObject({ path: 'experiences.0.start' });
    expect(report.counts).toBeUndefined();
  });

  it('reporta evidência órfã como erro de schema', async () => {
    const report = await validate(CLEAN.replace('ref: acme-2023', 'ref: nao-existe'));

    expect(report.valid).toBe(false);
    expect(report.schema_issues[0]?.message).toContain('não existe');
  });

  it('falha de verdade quando o career.yml não existe', async () => {
    await rm(careerPath);
    const result = await client.callTool({ name: 'validate_all', arguments: {} });

    expect(result.isError).toBe(true);
  });
});
