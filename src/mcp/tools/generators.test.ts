import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../../test/harness.js';

const CAREER = `
profile:
  name: Everton
  headline: Desenvolvedor Backend
  summary: Backend há dez anos.
experiences:
  - id: acme-2023
    company: Acme
    role: Backend Dev
    start: 01/03/2023
    bullets:
      - Migrou a API para TypeScript
projects:
  - id: career-mcp
    name: career-mcp
    problem: Canais desencontrados
    solution: Servidor MCP sobre YAML
    result: Coerência entre canais
    stack: [TypeScript]
skills:
  - name: TypeScript
    category: language
`;

type GenerateResult = {
  channel: string;
  path: string;
  characters: number;
  content: string;
};

type ChannelStatus = {
  channel: string;
  status: 'missing' | 'stale' | 'current';
  added: string[];
  removed: string[];
};

type DiffResult = {
  coherent: boolean;
  channels: ChannelStatus[];
};

let h: Harness;

beforeAll(async () => {
  h = await startHarness(CAREER);
});

afterAll(() => h.close());

beforeEach(async () => {
  await h.writeCareer(CAREER);
  await rm(h.outputDir, { recursive: true, force: true });
});

const generate = (channel: string, args: Record<string, unknown> = {}): Promise<GenerateResult> =>
  h.callTool<GenerateResult>(`generate_${channel}`, args);

const statusOf = (result: DiffResult, channel: string): ChannelStatus | undefined =>
  result.channels.find((item) => item.channel === channel);

describe('generate_* e cópia local', () => {
  it('instrui o agente a oferecer uma cópia local do conteúdo gerado', async () => {
    const { tools } = await h.client.listTools();

    for (const channel of ['linkedin', 'resume', 'portfolio']) {
      const description = tools.find((t) => t.name === `generate_${channel}`)?.description;
      expect(description).toMatch(/pergunte se (ele|o usuário) quer uma cópia local/i);
      expect(description).toMatch(/content/);
    }
  });
});

describe('generate_resume', () => {
  it('grava em output/ e devolve o conteúdo', async () => {
    const result = await generate('resume');

    expect(result.channel).toBe('resume');
    expect(result.path).toBe(path.join(h.outputDir, 'resume.md'));
    expect(result.content).toContain('# Everton');
    expect(await readFile(result.path, 'utf8')).toBe(result.content);
  });

  it('informa o tamanho do que gerou', async () => {
    const result = await generate('resume');

    expect(result.characters).toBe(result.content.length);
  });

  it('cria o diretório de output quando não existe', async () => {
    await generate('resume');

    expect(await readdir(h.outputDir)).toEqual(['resume.md']);
  });

  it('sobrescreve a geração anterior', async () => {
    await generate('resume');
    await h.writeCareer(CAREER.replace('Desenvolvedor Backend', 'Tech Lead'));

    const result = await generate('resume');

    expect(result.content).toContain('Tech Lead');
    expect(result.content).not.toContain('Desenvolvedor Backend');
  });

  it('é marcada como escrita não destrutiva', async () => {
    const { tools } = await h.client.listTools();
    const tool = tools.find((t) => t.name === 'generate_resume');

    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(false);
  });

  it('não exige confirm, porque output/ é derivado e descartável', async () => {
    const { tools } = await h.client.listTools();
    const tool = tools.find((t) => t.name === 'generate_resume');

    expect(Object.keys(tool?.inputSchema.properties ?? {})).not.toContain('confirm');
  });

  it('propaga erro de schema do career.yml', async () => {
    await h.writeCareer(CAREER.replace('01/03/2023', '2023-03'));

    const result = await h.client.callTool({ name: 'generate_resume', arguments: {} });

    expect(result.isError).toBe(true);
  });
});

describe('generate_linkedin e generate_portfolio', () => {
  it('geram os próprios arquivos', async () => {
    const linkedin = await generate('linkedin');
    const portfolio = await generate('portfolio');

    expect(linkedin.path.endsWith('linkedin.md')).toBe(true);
    expect(portfolio.path.endsWith('portfolio.md')).toBe(true);
    expect(linkedin.content).toContain('## Headline');
    expect(portfolio.content).toContain('**Problema.**');
  });
});

describe('resources output://', () => {
  it('orientam a gerar quando o arquivo não existe', async () => {
    const view = (await h.readResource('output://resume')) as Record<string, unknown>;

    expect(view.generated).toBe(false);
    expect(view.hint).toMatch(/generate_resume/);
  });

  it('servem o arquivo gerado', async () => {
    await generate('resume');

    const view = (await h.readResource('output://resume')) as Record<string, unknown>;

    expect(view.generated).toBe(true);
    expect(view.content).toContain('# Everton');
  });

  it('aparecem na lista de resources', async () => {
    const { resources } = await h.client.listResources();
    const uris = resources.map((r) => r.uri);

    expect(uris).toContain('output://linkedin');
    expect(uris).toContain('output://resume');
    expect(uris).toContain('output://portfolio');
  });
});

describe('diff_channels', () => {
  const diff = (): Promise<DiffResult> => h.callTool<DiffResult>('diff_channels');

  it('é read-only', async () => {
    const { tools } = await h.client.listTools();

    expect(tools.find((t) => t.name === 'diff_channels')?.annotations?.readOnlyHint).toBe(true);
  });

  it('reporta missing quando o canal nunca foi gerado', async () => {
    const result = await diff();

    expect(result.coherent).toBe(false);
    expect(statusOf(result, 'resume')?.status).toBe('missing');
  });

  it('reporta current logo depois de gerar tudo', async () => {
    await generate('resume');
    await generate('linkedin');
    await generate('portfolio');

    const result = await diff();

    expect(result.coherent).toBe(true);
    expect(result.channels.every((c) => c.status === 'current')).toBe(true);
  });

  it('reporta stale quando o career.yml mudou depois da geração', async () => {
    await generate('resume');
    await generate('linkedin');
    await generate('portfolio');
    await h.writeCareer(CAREER.replace('Desenvolvedor Backend', 'Tech Lead'));

    const result = await diff();

    expect(result.coherent).toBe(false);
    expect(statusOf(result, 'resume')?.status).toBe('stale');
  });

  it('mostra as linhas que entrariam e que sairiam', async () => {
    await generate('resume');
    await h.writeCareer(CAREER.replace('Desenvolvedor Backend', 'Tech Lead'));

    const resume = statusOf(await diff(), 'resume');

    expect(resume?.added).toContain('Tech Lead');
    expect(resume?.removed).toContain('Desenvolvedor Backend');
  });

  it('não acusa diferença por arquivo editado à mão fora do formato', async () => {
    await generate('resume');
    await writeFile(path.join(h.outputDir, 'resume.md'), 'mexido à mão\n');

    expect(statusOf(await diff(), 'resume')?.status).toBe('stale');
  });
});
