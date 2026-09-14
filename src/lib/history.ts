import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Career } from './schema.js';

export type Change = {
  path: string;
  kind: 'added' | 'removed' | 'changed' | 'moved';
  /** Em 'moved', a posição anterior. */
  before?: unknown;
  /** Em 'moved', a posição nova. */
  after?: unknown;
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

/** Título do commit que registra o que mudou no career.yml fora das tools. */
export const OUTSIDE_CHANGES = 'Record changes made outside career-mcp';

const execFileAsync = promisify(execFile);

/**
 * Variáveis que apontam o git para outro repositório. Herdadas de um hook —
 * rodar os testes num pre-commit, por exemplo —, fariam o commit cair no repo
 * errado.
 */
const REPO_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
]);

async function git(dir: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !REPO_ENV.has(key)),
  );

  const { stdout } = await execFileAsync(
    'git',
    [
      '-C',
      dir,
      // Volume montado com outro dono faz o git recusar o repo ("dubious ownership").
      '-c',
      `safe.directory=${path.resolve(dir)}`,
      // Autor fixo. GIT_AUTHOR_NAME e afins no ambiente continuam valendo por cima.
      '-c',
      'user.name=career-mcp',
      '-c',
      'user.email=career-mcp@localhost',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { env },
  );

  return stdout;
}

async function commit(filePath: string, message: string[]): Promise<void> {
  const dir = path.dirname(filePath);
  const file = path.basename(filePath);

  await git(dir, ['add', '--', file]);
  // Pathspec no commit: só o career.yml entra, mesmo que haja outra coisa no
  // índice. private.yml mora no mesmo diretório e nunca pode ser versionado.
  await git(dir, ['commit', '--quiet', ...message.flatMap((part) => ['-m', part]), '--', file]);
}

/**
 * Chame dentro do lock, antes de gravar. Garante que o diretório do career.yml
 * é um repo e commita à parte o que estiver pendente — edição manual ou um
 * commit que falhou —, para a próxima escrita não levar a autoria disso.
 *
 * Falhar aqui aborta a escrita: sem git funcionando não há como recuperar o
 * estado anterior, e gravar assim seria perder histórico calado.
 */
export async function prepareHistory(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);

  try {
    await access(path.join(dir, '.git'));
  } catch {
    await git(dir, ['init', '--quiet', '--initial-branch=main']);
  }

  const pending = await git(dir, ['status', '--porcelain', '--', path.basename(filePath)]);
  if (pending.trim() !== '') await commit(filePath, [OUTSIDE_CHANGES]);
}

/**
 * Commita a escrita que acabou de acontecer. Título curto para o `git log
 * --oneline` servir de linha do tempo; o corpo lista cada mudança.
 */
export async function commitCareer(filePath: string, tool: string, changes: Change[]): Promise<void> {
  const extra = changes.length > 1 ? ` (+${changes.length - 1})` : '';
  const title = `${tool}: ${changes[0]?.path ?? ''}${extra}`;
  const body = changes.map((change) => `${change.kind} ${change.path}`).join('\n');

  await commit(filePath, [title, body]);
}
