import { createHash } from 'node:crypto';
import path from 'node:path';

export type Config = {
  readonly port: number;
  readonly host: string;
  /** SHA-256 do MCP_AUTH_TOKEN. O token cru nunca é guardado. */
  readonly authTokenHash: Buffer;
  readonly githubToken: string | undefined;
  readonly paths: {
    readonly data: string;
    readonly career: string;
    readonly private: string;
    readonly history: string;
    readonly output: string;
  };
};

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Env var ${name} é obrigatória`);
  return value;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 3000;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`MCP_PORT inválida: "${raw}"`);
  }
  return port;
}

/**
 * Recebe o env como argumento em vez de ler `process.env` no import: assim o
 * módulo não tem efeito colateral e os testes não precisam mexer no ambiente.
 */
export function loadConfig(env: Env = process.env): Config {
  const dataDir = env.CAREER_DATA_DIR ?? '/app/data';

  return {
    port: parsePort(env.MCP_PORT),
    // 0.0.0.0 para o Traefik do Coolify alcançar o container.
    host: env.MCP_HOST ?? '0.0.0.0',
    authTokenHash: createHash('sha256').update(required(env, 'MCP_AUTH_TOKEN')).digest(),
    githubToken: env.GITHUB_TOKEN,
    paths: {
      data: dataDir,
      career: path.join(dataDir, 'career.yml'),
      private: path.join(dataDir, 'private.yml'),
      history: env.CAREER_HISTORY_DIR ?? '/app/history',
      output: env.CAREER_OUTPUT_DIR ?? '/app/output',
    },
  };
}
