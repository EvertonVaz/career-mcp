import { formatPeriod, type Career } from '../lib/schema.js';

/** Limites reais dos campos do LinkedIn. */
const HEADLINE_LIMIT = 220;
const SUMMARY_LIMIT = 2600;

function counted(text: string, limit: number): string {
  const aviso = text.length > limit ? ' ⚠ passou do limite' : '';
  return `_${text.length}/${limit} caracteres${aviso}_`;
}

export function renderLinkedin(career: Career): string {
  const { profile } = career;

  const lines = [
    `# LinkedIn — ${profile.name}`,
    '',
    '## Headline',
    '',
    profile.headline,
    '',
    counted(profile.headline, HEADLINE_LIMIT),
    '',
    '## Sobre',
    '',
    ...(profile.summary === undefined
      ? ['_(sem summary no career.yml — escreva um antes de publicar)_', '']
      : [profile.summary, '', counted(profile.summary, SUMMARY_LIMIT), '']),

    '## Experiência',
    '',
    ...career.experiences.flatMap((experience) => [
      `### ${experience.company} — ${experience.role}`,
      formatPeriod(experience.start, experience.end),
      '',
      ...experience.bullets.map((bullet) => `- ${bullet}`),
      '',
    ]),

    ...(career.skills.length === 0
      ? []
      : ['## Competências', '', career.skills.map((skill) => skill.name).join(', '), '']),
  ];

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
