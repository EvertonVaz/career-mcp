import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Career } from './schema.js';

export type Change = {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
};

export type Snapshot = {
  timestamp: string;
  /** Cópia do arquivo como estava antes da escrita. */
  file: string;
  /** JSON com as mudanças que motivaram o snapshot. */
  diff: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walk(before: unknown, after: unknown, at: string, out: Change[]): void {
  if (Object.is(before, after)) return;

  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      walk(before[key], after[key], at ? `${at}.${key}` : key, out);
    }
    return;
  }

  // Arrays comparados por índice: reordenar uma lista aparece como N mudanças.
  // Aceitável enquanto as escritas forem pontuais, não reordenações em massa.
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      walk(before[i], after[i], `${at}.${i}`, out);
    }
    return;
  }

  if (before === undefined) out.push({ path: at, kind: 'added', after });
  else if (after === undefined) out.push({ path: at, kind: 'removed', before });
  else out.push({ path: at, kind: 'changed', before, after });
}

/**
 * Diff estrutural, não textual: as write tools precisam mostrar "o quê mudou
 * onde" para você aprovar, e isso não sai de um diff de linhas.
 */
export function diffCareer(before: Career, after: Career): Change[] {
  const changes: Change[] = [];
  walk(before, after, '', changes);
  return changes;
}

/**
 * Copia o arquivo atual para history/ antes de qualquer escrita. Copia bytes
 * crus, sem reparsear: se o arquivo estiver corrompido, é justamente o estado
 * que queremos poder recuperar. Devolve null na primeira escrita, quando não
 * há nada a preservar.
 */
export async function snapshotBeforeWrite(
  historyDir: string,
  filePath: string,
  changes: Change[],
): Promise<Snapshot | null> {
  const timestamp = new Date().toISOString();
  // UUID curto no nome porque duas escritas podem cair no mesmo milissegundo.
  const stamp = `${timestamp.replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const base = path.basename(filePath, path.extname(filePath));

  await mkdir(historyDir, { recursive: true });

  const snapshot: Snapshot = {
    timestamp,
    file: path.join(historyDir, `${stamp}-${base}${path.extname(filePath)}`),
    diff: path.join(historyDir, `${stamp}-${base}.diff.json`),
  };

  try {
    await copyFile(filePath, snapshot.file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  await writeFile(
    snapshot.diff,
    `${JSON.stringify({ timestamp, source: filePath, changes }, null, 2)}\n`,
  );

  return snapshot;
}
