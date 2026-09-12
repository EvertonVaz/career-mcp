import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const ROTEIRO = `Atualize o LinkedIn a partir do que existe hoje no GitHub e no career.yml.

Siga nesta ordem e pare em cada aprovação:

1. Chame sync_github sem confirm. Nada é escrito nesse passo.

2. Apresente o resultado em duas listas separadas:
   - proposals[]: repositórios que ainda não são projeto no career.yml
   - divergences[]: projetos que já existem e destoam do repo
   Para cada proposta, diga o que entraria e o que ficaria faltando
   (problem, solution e result nunca vêm do GitHub).

3. Espere a escolha. Não aplique nada sem aprovação explícita: chame
   sync_github com confirm: true e accept: [...] só com os repos aprovados.

4. Chame suggest_skills_from_github sem confirm e repita o passo 2 e 3 para
   as linguagens sugeridas.

5. Para cada projeto novo, pergunte problem, solution e result. Não escreva
   esses campos por conta própria — se não houver resposta, deixe em branco
   e siga.

6. Chame generate_linkedin e mostre o resultado, conferindo se headline e
   sobre couberam nos limites de caracteres.

7. Feche com diff_channels: se currículo ou portfólio ficaram stale, avise
   que precisam ser regerados também.`;

export function registerUpdateLinkedinPrompt(server: McpServer): void {
  server.registerPrompt(
    'atualizar-linkedin-com-github',
    {
      title: 'Atualizar LinkedIn com o GitHub',
      description:
        'Sincroniza com o GitHub, propõe o que entra, espera aprovação e regenera o LinkedIn.',
    },
    () => ({
      messages: [{ role: 'user', content: { type: 'text', text: ROTEIRO } }],
    }),
  );
}
