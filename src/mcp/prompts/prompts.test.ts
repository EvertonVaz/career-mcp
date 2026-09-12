import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../../test/harness.js';

const CAREER = `
profile:
  name: Everton
  headline: Desenvolvedor
`;

let h: Harness;

beforeAll(async () => {
  h = await startHarness(CAREER);
});

afterAll(() => h.close());

async function textOf(name: string, args: Record<string, string> = {}): Promise<string> {
  const { messages } = await h.client.getPrompt({ name, arguments: args });

  return messages
    .map((message) => (message.content.type === 'text' ? message.content.text : ''))
    .join('\n');
}

describe('registro dos prompts', () => {
  it('expõe os três prompts do plano', async () => {
    const { prompts } = await h.client.listPrompts();

    expect(prompts.map((p) => p.name).sort()).toEqual([
      'atualizar-linkedin-com-github',
      'auditoria-trimestral',
      'tailor-resume',
    ]);
  });

  it('todos têm descrição', async () => {
    const { prompts } = await h.client.listPrompts();

    expect(prompts.every((p) => (p.description ?? '').length > 0)).toBe(true);
  });
});

describe('atualizar-linkedin-com-github', () => {
  it('encadeia sync, revisão, aprovação e geração', async () => {
    const text = await textOf('atualizar-linkedin-com-github');

    expect(text).toContain('sync_github');
    expect(text).toContain('confirm');
    expect(text).toContain('generate_linkedin');
    expect(text).toContain('diff_channels');
  });

  it('proíbe escrever sem aprovação explícita', async () => {
    const text = await textOf('atualizar-linkedin-com-github');

    expect(text).toMatch(/não aplique nada sem aprovação/i);
  });
});

describe('tailor-resume', () => {
  it('recebe a vaga como argumento', async () => {
    const { prompts } = await h.client.listPrompts();
    const prompt = prompts.find((p) => p.name === 'tailor-resume');

    expect(prompt?.arguments?.map((a) => a.name)).toEqual(['vaga']);
  });

  it('inclui o texto da vaga na mensagem', async () => {
    const text = await textOf('tailor-resume', { vaga: 'Precisamos de alguém com Kubernetes.' });

    expect(text).toContain('Precisamos de alguém com Kubernetes.');
  });

  it('manda extrair termos e chamar a tool, sem inventar', async () => {
    const text = await textOf('tailor-resume', { vaga: 'qualquer' });

    expect(text).toContain('tailor_for_job');
    expect(text).toContain('without_evidence');
    expect(text).toMatch(/não invent/i);
  });
});

describe('auditoria-trimestral', () => {
  it('encadeia validação, coerência e verificação', async () => {
    const text = await textOf('auditoria-trimestral');

    expect(text).toContain('validate_all');
    expect(text).toContain('diff_channels');
    expect(text).toContain('mark_verified');
  });

  it('cobra skill sem evidência e o que está pendente de verificação', async () => {
    const text = await textOf('auditoria-trimestral');

    expect(text).toContain('skill_without_evidence');
    expect(text).toContain('unverified');
  });
});
