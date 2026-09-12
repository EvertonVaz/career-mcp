import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../config.js';
import { createApp } from '../http/app.js';

const TOKEN = 'token-de-teste';

export type Harness = {
  /** Client oficial do SDK, para os casos que precisam da resposta crua. */
  client: Client;
  dir: string;
  careerPath: string;
  historyDir: string;
  cacheDir: string;
  outputDir: string;
  writeCareer(yaml: string): Promise<void>;
  removeCareer(): Promise<void>;
  readCareer(): Promise<string>;
  readResource(uri: string): Promise<unknown>;
  callTool<T>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
};

/**
 * Sobe o servidor de verdade numa porta efêmera, com um data dir temporário, e
 * conecta o client oficial do SDK. Testar contra a implementação de referência
 * pega divergência de protocolo que JSON-RPC na mão deixaria passar.
 */
export async function startHarness(
  careerYaml?: string,
  env: Record<string, string | undefined> = {},
): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-'));
  const careerPath = path.join(dir, 'career.yml');
  if (careerYaml !== undefined) await writeFile(careerPath, careerYaml);

  const app = createApp(
    loadConfig({
      MCP_AUTH_TOKEN: TOKEN,
      CAREER_DATA_DIR: dir,
      CAREER_HISTORY_DIR: path.join(dir, 'history'),
      CAREER_CACHE_DIR: path.join(dir, 'cache'),
      CAREER_OUTPUT_DIR: path.join(dir, 'output'),
      ...env,
    }),
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('servidor sem porta');

  const client = new Client({ name: 'vitest', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );

  return {
    client,
    dir,
    careerPath,
    historyDir: path.join(dir, 'history'),
    cacheDir: path.join(dir, 'cache'),
    outputDir: path.join(dir, 'output'),

    writeCareer: (yaml) => writeFile(careerPath, yaml),

    removeCareer: () => rm(careerPath),

    readCareer: () => readFile(careerPath, 'utf8'),

    async readResource(uri) {
      const [content] = (await client.readResource({ uri })).contents;
      if (content === undefined || !('text' in content)) {
        throw new Error(`${uri} não veio como texto`);
      }
      return JSON.parse(content.text);
    },

    async callTool<T>(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      return result.structuredContent as unknown as T;
    },

    async close() {
      await client.close();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
