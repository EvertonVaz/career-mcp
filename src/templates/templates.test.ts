import { describe, expect, it } from 'vitest';
import { CareerFile, type Career } from '../lib/schema.js';
import { renderLinkedin } from './linkedin.js';
import { renderPortfolio } from './portfolio.js';
import { renderResume } from './resume.js';

function career(overrides: Record<string, unknown> = {}): Career {
  return CareerFile.parse({
    profile: {
      name: 'Everton',
      headline: 'Desenvolvedor Backend',
      summary: 'Backend há dez anos.',
      location: 'São Paulo',
      email: 'etovaz.web@gmail.com',
      links: { github: 'https://github.com/etovaz' },
    },
    experiences: [
      {
        id: 'acme-2023',
        company: 'Acme',
        role: 'Backend Dev',
        start: '01/03/2023',
        location: 'Remoto',
        bullets: ['Migrou a API para TypeScript'],
        tech: ['TypeScript'],
      },
      {
        id: 'beta-2021',
        company: 'Beta',
        role: 'Dev Pleno',
        start: '01/02/2021',
        end: '28/02/2023',
        bullets: ['Automação de deploy'],
      },
    ],
    projects: [
      {
        id: 'career-mcp',
        name: 'career-mcp',
        problem: 'Canais desencontrados',
        solution: 'Servidor MCP sobre YAML',
        result: 'Coerência entre canais',
        stack: ['TypeScript', 'Node'],
        links: { repo: 'https://github.com/etovaz/career-mcp' },
        highlight: true,
      },
      { id: 'portfolio', name: 'Portfólio', stack: ['Astro'] },
    ],
    skills: [
      { name: 'TypeScript', category: 'language' },
      { name: 'Go', category: 'language' },
      { name: 'Docker', category: 'tool' },
    ],
    education: [
      {
        id: 'fatec',
        institution: 'FATEC',
        degree: 'Tecnólogo em ADS',
        start: '01/02/2018',
        end: '01/12/2020',
      },
    ],
    certifications: [
      { id: 'aws-saa', name: 'AWS SAA', issuer: 'AWS', issued_at: '01/09/2024' },
    ],
    languages: [
      { name: 'Português', level: 'native' },
      { name: 'Inglês', level: 'B2' },
    ],
    ...overrides,
  });
}

describe('renderResume', () => {
  it('abre com nome e headline', () => {
    expect(renderResume(career())).toMatch(/^# Everton\n\nDesenvolvedor Backend\n/);
  });

  it('traz contato e links na linha de cabeçalho', () => {
    const resume = renderResume(career());

    expect(resume).toContain('etovaz.web@gmail.com');
    expect(resume).toContain('São Paulo');
    expect(resume).toContain('https://github.com/etovaz');
  });

  it('lista experiências da mais recente para a mais antiga', () => {
    const resume = renderResume(career());

    expect(resume.indexOf('Acme')).toBeLessThan(resume.indexOf('Beta'));
  });

  it('formata período em mês/ano com "atual" no cargo em aberto', () => {
    const resume = renderResume(career());

    expect(resume).toContain('03/2023 – atual');
    expect(resume).toContain('02/2021 – 02/2023');
  });

  it('escreve os bullets como lista', () => {
    expect(renderResume(career())).toContain('- Migrou a API para TypeScript');
  });

  it('rotula problema, solução e resultado igual ao portfólio', () => {
    const resume = renderResume(career());

    expect(resume).toContain('**Problema.** Canais desencontrados');
    expect(resume).toContain('**Solução.** Servidor MCP sobre YAML');
    expect(resume).toContain('**Resultado.** Coerência entre canais');
    expect(resume).toContain('**Stack:** TypeScript, Node');
    expect(resume).toContain('**Repo:** https://github.com/etovaz/career-mcp');
  });

  it('omite o rótulo do campo que o projeto não tem', () => {
    const resume = renderResume(career());

    // O projeto "Portfólio" só tem stack.
    expect(resume).toContain('### Portfólio\n**Stack:** Astro');
  });

  it('agrupa skills por categoria', () => {
    const resume = renderResume(career());

    expect(resume).toContain('TypeScript, Go');
    expect(resume).toContain('Docker');
  });

  it('traz formação, certificações e idiomas', () => {
    const resume = renderResume(career());

    expect(resume).toContain('FATEC');
    expect(resume).toContain('AWS SAA');
    expect(resume).toContain('Inglês (B2)');
    expect(resume).toContain('Português (nativo)');
  });

  it('omite seção vazia em vez de deixar título órfão', () => {
    const resume = renderResume(career({ certifications: [], languages: [] }));

    expect(resume).not.toContain('Certificações');
    expect(resume).not.toContain('Idiomas');
  });

  it('não inventa seção para o que não existe no career.yml', () => {
    const resume = renderResume(career({ projects: [], skills: [] }));

    expect(resume).not.toContain('career-mcp');
    expect(resume).not.toContain('## Projetos');
    expect(resume).not.toContain('**Linguagens:**');
    // O que continua aparecendo vem dos bullets da experiência, não de palpite.
    expect(resume).toContain('- Migrou a API para TypeScript');
  });
});

describe('renderLinkedin', () => {
  it('separa headline e sobre em seções coláveis', () => {
    const linkedin = renderLinkedin(career());

    expect(linkedin).toContain('## Headline');
    expect(linkedin).toContain('Desenvolvedor Backend');
    expect(linkedin).toContain('## Sobre');
    expect(linkedin).toContain('Backend há dez anos.');
  });

  it('mostra a contagem de caracteres contra o limite do LinkedIn', () => {
    const linkedin = renderLinkedin(career());

    expect(linkedin).toMatch(/21\/220 caracteres/);
    expect(linkedin).toMatch(/\d+\/2600 caracteres/);
  });

  it('avisa quando não há resumo escrito', () => {
    expect(renderLinkedin(career({ profile: { name: 'Everton', headline: 'Dev' } }))).toMatch(
      /sem summary/i,
    );
  });

  it('lista experiências com empresa, cargo e período', () => {
    const linkedin = renderLinkedin(career());

    expect(linkedin).toContain('Acme');
    expect(linkedin).toContain('Backend Dev');
    expect(linkedin).toContain('03/2023 – atual');
  });

  it('junta as competências numa linha só, pronta para colar', () => {
    expect(renderLinkedin(career())).toContain('TypeScript, Go, Docker');
  });
});

describe('renderPortfolio', () => {
  it('põe os projetos destacados antes dos demais', () => {
    const portfolio = renderPortfolio(career());

    expect(portfolio.indexOf('career-mcp')).toBeLessThan(portfolio.indexOf('Portfólio'));
  });

  it('escreve problema, solução e resultado quando existem', () => {
    const portfolio = renderPortfolio(career());

    expect(portfolio).toContain('Canais desencontrados');
    expect(portfolio).toContain('Servidor MCP sobre YAML');
    expect(portfolio).toContain('Coerência entre canais');
  });

  it('marca o que falta em vez de preencher sozinho', () => {
    const portfolio = renderPortfolio(career());

    expect(portfolio).toMatch(/Portfólio[\s\S]*falta/i);
  });

  it('lista stack e links', () => {
    const portfolio = renderPortfolio(career());

    expect(portfolio).toContain('TypeScript, Node');
    expect(portfolio).toContain('https://github.com/etovaz/career-mcp');
  });

  it('não quebra com career sem projeto nenhum', () => {
    expect(renderPortfolio(career({ projects: [] }))).toContain('Everton');
  });
});
