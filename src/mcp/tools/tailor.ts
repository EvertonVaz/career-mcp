import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { loadCareer } from '../../lib/loader.js';
import type { Career } from '../../lib/schema.js';
import { renderResume } from '../../templates/resume.js';

type Evidence = { type: 'skill' | 'experience' | 'project'; ref: string; where: string };
type Match = { term: string; evidence: Evidence[] };

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** Item de lista casa inteiro: "Go" não é "Postgres". */
function inList(term: string, items: string[]): boolean {
  const needle = normalize(term);
  return items.some((item) => normalize(item) === needle);
}

/** Em prosa, casa por limite de palavra, senão "Go" acha "Migrou". */
function inText(term: string, texts: (string | undefined)[]): boolean {
  const needle = normalize(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${needle}(?![\\p{L}\\p{N}])`, 'u');

  return texts.some((text) => text !== undefined && pattern.test(normalize(text)));
}

function evidenceFor(career: Career, term: string): Evidence[] {
  const evidence: Evidence[] = [];

  for (const skill of career.skills) {
    if (inList(term, [skill.name])) {
      evidence.push({ type: 'skill', ref: skill.name, where: 'skills' });
    }
  }

  for (const experience of career.experiences) {
    if (inList(term, experience.tech)) {
      evidence.push({ type: 'experience', ref: experience.id, where: 'tech' });
    } else if (inText(term, [experience.role, ...experience.bullets])) {
      evidence.push({ type: 'experience', ref: experience.id, where: 'bullets' });
    }
  }

  for (const project of career.projects) {
    if (inList(term, project.stack)) {
      evidence.push({ type: 'project', ref: project.id, where: 'stack' });
    } else if (inText(term, [project.name, project.problem, project.solution, project.result])) {
      evidence.push({ type: 'project', ref: project.id, where: 'texto' });
    }
  }

  return evidence;
}

/** Quantos termos distintos cada entidade sustenta. */
function scoreOf(matches: Match[], type: Evidence['type'], ref: string): number {
  return matches.filter((match) =>
    match.evidence.some((item) => item.type === type && item.ref === ref),
  ).length;
}

export function registerTailorTool(server: McpServer, config: Config): void {
  server.registerTool(
    'tailor_for_job',
    {
      title: 'Adaptar currículo para uma vaga',
      description: `Cruza os requisitos de uma vaga com o career.yml e gera um currículo
reordenado pelo que é mais relevante.

terms[] são os requisitos da vaga, extraídos por você a partir do texto. A
tool não lê a vaga: extrair requisito de texto corrido é trabalho de LLM,
cruzar com a fonte de verdade é trabalho determinístico, e separar os dois é
o que impede o currículo de ganhar coisa que você não fez.

Retorna:
  - matched[]: cada termo com as evidências que o sustentam (skill, tech de
    experiência, stack de projeto, ou menção em bullet)
  - without_evidence[]: requisitos sem nada no career.yml. Não invente — ou
    você tem e falta registrar, ou não tem.
  - emphasis: ids de experiências e projetos ordenados por quantos termos cada
    um sustenta
  - resume: o currículo renderizado nessa ordem

Grava em output/resume-tailored.md, sem tocar no resume.md. Nenhum conteúdo
novo é criado: só reordena e recorta o que já está no career.yml.`,
      inputSchema: {
        terms: z
          .array(z.string().min(1))
          .min(1)
          .describe('Requisitos da vaga, ex: ["TypeScript", "Postgres", "Docker"].'),
        limitExperiences: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Mantém só as N experiências mais relevantes.'),
        limitProjects: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Mantém só os N projetos mais relevantes.'),
      },
      outputSchema: {
        matched: z.array(
          z.object({
            term: z.string(),
            evidence: z.array(
              z.object({ type: z.string(), ref: z.string(), where: z.string() }),
            ),
          }),
        ),
        without_evidence: z.array(z.string()),
        emphasis: z.object({ experiences: z.array(z.string()), projects: z.array(z.string()) }),
        path: z.string(),
        resume: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ terms, limitExperiences, limitProjects }) => {
      const career = await loadCareer(config.paths.career);

      const all = terms.map((term) => ({ term, evidence: evidenceFor(career, term) }));
      const matched = all.filter((match) => match.evidence.length > 0);
      const without_evidence = all
        .filter((match) => match.evidence.length === 0)
        .map((match) => match.term);

      // Ordenação estável: empate mantém a ordem original do career.yml.
      const experiences = [...career.experiences].sort(
        (a, b) => scoreOf(matched, 'experience', b.id) - scoreOf(matched, 'experience', a.id),
      );
      const projects = [...career.projects].sort(
        (a, b) => scoreOf(matched, 'project', b.id) - scoreOf(matched, 'project', a.id),
      );

      const tailored: Career = {
        ...career,
        experiences: experiences.slice(0, limitExperiences ?? experiences.length),
        projects: projects.slice(0, limitProjects ?? projects.length),
      };

      const resume = renderResume(tailored);
      const file = path.join(config.paths.output, 'resume-tailored.md');

      await mkdir(config.paths.output, { recursive: true });
      await writeFile(file, resume);

      const payload = {
        matched,
        without_evidence,
        emphasis: {
          experiences: tailored.experiences.map((item) => item.id),
          projects: tailored.projects.map((item) => item.id),
        },
        path: file,
        resume,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    },
  );
}
