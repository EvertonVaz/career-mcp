import { formatPeriod, type Career } from '../lib/schema.js';

type Skill = Career['skills'][number];

const CATEGORY_LABEL: Record<Skill['category'], string> = {
  language: 'Linguagens',
  framework: 'Frameworks',
  tool: 'Ferramentas',
  platform: 'Plataformas',
  practice: 'Práticas',
  soft: 'Comportamentais',
};

const LEVEL_LABEL: Record<string, string> = { native: 'nativo' };

/** Junta o que existe e descarta o resto, sem deixar separador solto. */
function join(parts: (string | undefined)[], separator: string): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(separator);
}

/** Título só entra se tiver corpo: seção vazia vira título órfão. */
function section(title: string, body: string[]): string[] {
  return body.length === 0 ? [] : [`## ${title}`, '', ...body];
}

function skillsByCategory(skills: Skill[]): string[] {
  return Object.entries(CATEGORY_LABEL)
    .map(([category, label]) => {
      const names = skills.filter((skill) => skill.category === category).map((s) => s.name);
      return names.length === 0 ? undefined : `**${label}:** ${names.join(', ')}`;
    })
    .filter((line): line is string => line !== undefined)
    .flatMap((line) => [line, '']);
}

export function renderResume(career: Career): string {
  const { profile } = career;

  const contact = join(
    [profile.email, profile.location, profile.links.github, profile.links.linkedin, profile.links.site],
    ' · ',
  );

  const lines = [
    `# ${profile.name}`,
    '',
    profile.headline,
    '',
    ...(contact === '' ? [] : [contact, '']),
    ...section('Resumo', profile.summary === undefined ? [] : [profile.summary, '']),

    ...section(
      'Experiência',
      career.experiences.flatMap((experience) => [
        `### ${experience.role} — ${experience.company}`,
        join([formatPeriod(experience.start, experience.end), experience.location], ' · '),
        '',
        ...experience.bullets.map((bullet) => `- ${bullet}`),
        ...(experience.bullets.length === 0 ? [] : ['']),
      ]),
    ),

    ...section(
      'Projetos',
      career.projects.flatMap((project) => [
        `### ${project.name}`,
        ...[project.problem, project.solution, project.result]
          .filter((value): value is string => value !== undefined)
          .map((value) => value),
        ...(project.stack.length === 0 ? [] : [`Stack: ${project.stack.join(', ')}`]),
        ...(project.links.repo === undefined ? [] : [project.links.repo]),
        '',
      ]),
    ),

    ...section(
      'Formação',
      career.education.flatMap((item) => [
        `### ${item.degree} — ${item.institution}`,
        formatPeriod(item.start, item.end),
        '',
      ]),
    ),

    ...section(
      'Certificações',
      career.certifications.map(
        (item) => `- ${item.name} — ${item.issuer} (${item.issued_at.slice(3)})`,
      ),
    ),

    ...(career.certifications.length === 0 ? [] : ['']),
    ...section('Skills', skillsByCategory(career.skills)),

    ...section(
      'Idiomas',
      career.languages.map(
        (language) => `- ${language.name} (${LEVEL_LABEL[language.level] ?? language.level})`,
      ),
    ),
  ];

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
