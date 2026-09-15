import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

function roteiro(vaga: string): string {
  return `Adapte o currículo para esta vaga sem inventar nada.

VAGA
${vaga}

Siga nesta ordem:

1. Leia a vaga e extraia os requisitos técnicos concretos como uma lista de
   termos curtos, do jeito que apareceriam num career.yml: linguagens,
   frameworks, ferramentas, plataformas. Ignore requisito comportamental e
   texto de marketing.

2. Chame tailor_for_job com esses termos. A tool cruza com o career.yml e
   devolve o que tem evidência, o que não tem, e o currículo reordenado.

3. Mostre matched[] dizendo, para cada requisito, qual experiência ou projeto
   sustenta ele.

4. Mostre without_evidence[] como o ponto de atenção da candidatura. Para
   cada item, ofereça duas saídas e nada além disso:
   - você tem e falta registrar: use add_skill ou update_experience
   - você não tem: fica como lacuna conhecida
   Não invente experiência, não estique o que existe e não escreva bullet
   novo para cobrir requisito.

5. Ajuste o arquivo gerado a este modelo:
   - Resumo: no máximo 5 linhas, um parágrafo só.
   - Competências: agrupadas por tema, só o que a vaga pede e tem evidência.
   - Experiência: bullets só nas experiências que mais se encaixam na vaga;
     as demais ficam sem bullet, apenas cargo, empresa e período.
   - Projetos não entram no currículo. Podem sustentar um requisito em
     matched[], mas a seção sai do arquivo.
   - Formação: mantém como está.

6. Aponte onde está o arquivo gerado e o que mudou de ordem em relação ao
   currículo padrão.`;
}

export function registerTailorResumePrompt(server: McpServer): void {
  server.registerPrompt(
    'tailor-resume',
    {
      title: 'Adaptar currículo para uma vaga',
      description:
        'Extrai os requisitos da vaga, cruza com o career.yml e adapta o currículo sem inventar.',
      argsSchema: { vaga: z.string().describe('Texto da vaga, colado inteiro.') },
    },
    ({ vaga }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: roteiro(vaga) } }],
    }),
  );
}
