import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Career } from './schema.js';

export type Change = {
  path: string;
  kind: 'added' | 'removed' | 'changed' | 'moved';
  /** Em 'moved', a posição anterior. */
  before?: unknown;
  /** Em 'moved', a posição nova. */
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

type Keyed = { value: unknown; index: number };

/** `id` nas entidades; `name` em skills e languages, que não têm id. */
function entityKey(item: unknown): string | null {
  if (!isPlainObject(item)) return null;

  const key = item.id ?? item.name;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/**
 * Indexa por chave. Devolve null se algum item não tiver chave ou se houver
 * chave repetida — nesse caso casar por chave engoliria uma das mudanças sem
 * avisar, o que é pior do que o ruído do índice.
 */
function keyAll(items: unknown[]): Map<string, Keyed> | null {
  const keyed = new Map<string, Keyed>();

  for (const [index, value] of items.entries()) {
    const key = entityKey(value);
    if (key === null || keyed.has(key)) return null;
    keyed.set(key, { value, index });
  }

  return keyed;
}

function diffKeyed(
  before: Map<string, Keyed>,
  after: Map<string, Keyed>,
  at: string,
  out: Change[],
): void {
  for (const [key, item] of before) {
    const counterpart = after.get(key);
    if (counterpart === undefined) {
      out.push({ path: `${at}[${key}]`, kind: 'removed', before: item.value });
      continue;
    }
    walk(item.value, counterpart.value, `${at}[${key}]`, out);
  }

  for (const [key, item] of after) {
    if (!before.has(key)) out.push({ path: `${at}[${key}]`, kind: 'added', after: item.value });
  }

  // Ordem comparada só entre os sobreviventes: sem isso, remover um item do
  // meio marcaria todos os de baixo como movidos.
  const survived = [...before.keys()].filter((key) => after.has(key));
  const reordered = [...after.keys()].filter((key) => before.has(key));

  survived.forEach((key, position) => {
    const next = reordered.indexOf(key);
    if (next !== position) {
      out.push({ path: `${at}[${key}]`, kind: 'moved', before: position, after: next });
    }
  });
}

function walk(before: unknown, after: unknown, at: string, out: Change[]): void {
  if (Object.is(before, after)) return;

  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      walk(before[key], after[key], at ? `${at}.${key}` : key, out);
    }
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const keyedBefore = keyAll(before);
    const keyedAfter = keyAll(after);

    if (keyedBefore && keyedAfter) {
      diffKeyed(keyedBefore, keyedAfter, at, out);
      return;
    }

    // Sem chave dos dois lados: índice é a melhor aproximação que existe.
    // Vale para bullets, tech, stack e afins, que não têm identidade própria.
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
 * onde" para você aprovar, e isso não sai de um diff de linhas. Entidades são
 * casadas por id (ou name), não por posição — índice não é identidade, e
 * tratá-lo como tal descreve errado remoção e reordenação.
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
