import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const ROTEIRO = `Guie a criação do profile no career.yml. Serve tanto para um data dir
vazio quanto para revisar um profile existente.

Siga nesta ordem:

1. Leia o resource career://profile. Se falhar porque o career.yml não
   existe, é um começo do zero: diga isso e siga. Se existir, mostre o que já
   está preenchido e pergunte só pelo que falta ou pelo que a pessoa quer mudar.

2. Pergunte, um bloco por vez, e espere a resposta:
   - name (obrigatório)
   - headline (obrigatório, até 220 caracteres — limite do LinkedIn). Se a
     pessoa não souber o que escrever, ofereça 2 ou 3 opções no formato
     "cargo | foco | stack principal", usando só o que ela contou.
   - summary (opcional, até 2600 caracteres)
   - location e email (opcionais)
   - links: github, linkedin e site (opcionais, URLs completas)

   Não invente nada: campo que a pessoa não informou fica de fora.

3. Chame update_profile com o patch montado, sem confirm, e mostre o diff.

4. Só depois de aprovação explícita, chame update_profile de novo com
   confirm: true. Se vier erro de validação, mostre o campo citado e
   pergunte de novo só por ele.

5. Feche sugerindo o próximo passo: add_experience para a experiência atual,
   ou sync_github se houver GITHUB_TOKEN configurado.`;

export function registerCreateProfilePrompt(server: McpServer): void {
  server.registerPrompt(
    'criar-perfil',
    {
      title: 'Criar perfil',
      description:
        'Guia inicial: coleta name, headline e o resto do profile e cria o career.yml se ele não existir.',
    },
    () => ({
      messages: [{ role: 'user', content: { type: 'text', text: ROTEIRO } }],
    }),
  );
}
