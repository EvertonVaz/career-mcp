import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { CareerFile, PrivateFile, type Career, type Private } from './schema.js';

export type Issue = { path: string; message: string };

/** Erro estruturado: as issues vão inteiras para a resposta da tool. */
export class CareerValidationError extends Error {
  constructor(
    readonly file: string,
    readonly issues: Issue[],
  ) {
    super(`${file} inválido: ${issues.map((i) => `${i.path} — ${i.message}`).join('; ')}`);
    this.name = 'CareerValidationError';
  }
}

function toIssues(error: z.ZodError): Issue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(raiz)',
    message: issue.message,
  }));
}

async function readYaml(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Não consegui ler ${filePath}: ${(error as NodeJS.ErrnoException).code}`);
  }

  try {
    return parse(text);
  } catch (error) {
    throw new Error(`YAML malformado em ${filePath}: ${(error as Error).message}`);
  }
}

/** Valida e devolve com os defaults aplicados, ou estoura com as issues. */
export function validateCareer(filePath: string, value: unknown): Career {
  const result = CareerFile.safeParse(value);
  if (!result.success) throw new CareerValidationError(filePath, toIssues(result.error));

  return result.data;
}

export async function loadCareer(filePath: string): Promise<Career> {
  return validateCareer(filePath, await readYaml(filePath));
}

/** private.yml é opcional — ausência não é erro. */
export async function loadPrivate(filePath: string): Promise<Private> {
  let raw: unknown;
  try {
    raw = await readYaml(filePath);
  } catch {
    return {};
  }

  const result = PrivateFile.safeParse(raw ?? {});
  if (!result.success) throw new CareerValidationError(filePath, toIssues(result.error));

  return result.data;
}

/**
 * Escreve em arquivo temporário no mesmo diretório e renomeia: rename é
 * atômico dentro do mesmo filesystem, então nunca existe um career.yml
 * parcial em disco. O fsync antes garante que o conteúdo chegou ao disco.
 */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);

  try {
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, filePath);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

const locks = new Map<string, Promise<void>>();

/**
 * Serializa quem faz load → mutate → save no mesmo arquivo. O rename atômico
 * impede arquivo parcial, não update perdido: sem isso, duas tools leem a mesma
 * versão e a segunda grava por cima da primeira.
 *
 * Lock em memória: vale para um processo só, que é como o servidor roda.
 * Réplicas ou edição manual concorrente continuam fora da proteção.
 */
export async function withCareerLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = locks.get(key) ?? Promise.resolve();

  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(key, tail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export async function saveCareer(filePath: string, career: Career): Promise<Career> {
  const validated = validateCareer(filePath, career);

  const stamped: Career = {
    ...validated,
    meta: { ...validated.meta, updated_at: new Date().toISOString() },
  };

  // lineWidth 0 desliga o dobramento de linha: bullet longo quebrado em duas
  // linhas polui o diff do Git sem mudar nada semanticamente.
  await writeAtomic(filePath, stringify(stamped, { lineWidth: 0 }));

  return stamped;
}
