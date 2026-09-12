import type { Career } from '../lib/schema.js';

type Project = Career['projects'][number];

/**
 * O que o projeto ainda não tem aparece como pendência explícita. Preencher
 * sozinho seria inventar case.
 */
function missing(project: Project): string[] {
  const faltando = [
    project.problem === undefined ? 'problema' : undefined,
    project.solution === undefined ? 'solução' : undefined,
    project.result === undefined ? 'resultado' : undefined,
  ].filter((item): item is string => item !== undefined);

  return faltando.length === 0 ? [] : [`_Ainda falta: ${faltando.join(', ')}._`];
}

function renderProject(project: Project): string[] {
  return [
    `### ${project.name}`,
    '',
    ...(project.problem === undefined ? [] : [`**Problema.** ${project.problem}`, '']),
    ...(project.solution === undefined ? [] : [`**Solução.** ${project.solution}`, '']),
    ...(project.result === undefined ? [] : [`**Resultado.** ${project.result}`, '']),
    ...missing(project),
    ...(project.stack.length === 0 ? [] : [`**Stack:** ${project.stack.join(', ')}`]),
    ...(project.links.repo === undefined ? [] : [`**Repo:** ${project.links.repo}`]),
    ...(project.links.demo === undefined ? [] : [`**Demo:** ${project.links.demo}`]),
    ...project.images.map((image) => `![${image.alt}](${image.url})`),
    '',
  ];
}

export function renderPortfolio(career: Career): string {
  // highlight primeiro: é a ordem em que o portfólio deve mostrar.
  const ordered = [
    ...career.projects.filter((project) => project.highlight),
    ...career.projects.filter((project) => !project.highlight),
  ];

  const lines = [
    `# ${career.profile.name}`,
    '',
    career.profile.headline,
    '',
    ...(career.profile.summary === undefined ? [] : [career.profile.summary, '']),
    ...(ordered.length === 0 ? [] : ['## Projetos', '']),
    ...ordered.flatMap(renderProject),
  ];

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
