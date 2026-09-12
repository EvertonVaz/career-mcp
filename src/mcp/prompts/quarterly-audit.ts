import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const ROTEIRO = `Faça a auditoria trimestral do career.yml.

Siga nesta ordem:

1. Chame validate_all. Se valid for false, pare: liste schema_issues[] e
   resolva o formato antes de qualquer outra coisa.

2. Percorra warnings[] agrupando por código:
   - experience_without_bullets: experiência sem nada para gerar
   - project_incomplete: falta problem, solution ou result
   - skill_without_evidence: skill que não aponta para experiência nem projeto
   Para cada uma, pergunte o que falta. Não preencha por conta própria.

3. Percorra unverified[]: tudo que ainda é sugestão esperando conferência.
   Mostre o conteúdo de cada item e, para os que forem confirmados, chame
   mark_verified. Um por vez, com confirmação.

4. Chame sync_github sem confirm e reporte divergences[]: projeto cujo link
   ou stack destoa do repositório.

5. Chame diff_channels. Para cada canal stale, mostre as linhas que mudariam
   e ofereça regerar com generate_linkedin, generate_resume ou
   generate_portfolio.

6. Feche com um resumo curto: quantos itens seguem sem evidência, quantos
   sem verificação, e quais canais ficaram para republicar.`;

export function registerQuarterlyAuditPrompt(server: McpServer): void {
  server.registerPrompt(
    'auditoria-trimestral',
    {
      title: 'Auditoria trimestral',
      description:
        'Valida o career.yml, cobra o que está incompleto, confirma pendências e confere os canais.',
    },
    () => ({
      messages: [{ role: 'user', content: { type: 'text', text: ROTEIRO } }],
    }),
  );
}
