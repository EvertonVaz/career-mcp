import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { CareerValidationError, loadCareer, type Issue } from '../../lib/loader.js';
import type { Career } from '../../lib/schema.js';

type Warning = { code: string; path: string; message: string };

/**
 * Checagens que o Zod não faz porque não são erro de formato, e sim material
 * faltando. Nada aqui impede salvar — é pauta de revisão.
 */
export function auditCareer(career: Career): Warning[] {
  const warnings: Warning[] = [];

  for (const experience of career.experiences) {
    if (experience.bullets.length === 0) {
      warnings.push({
        code: 'experience_without_bullets',
        path: `experiences[${experience.id}]`,
        message: `${experience.company} não tem nenhum bullet — não há o que gerar para currículo.`,
      });
    }
  }

  for (const project of career.projects) {
    if (!project.problem || !project.solution || !project.result) {
      warnings.push({
        code: 'project_incomplete',
        path: `projects[${project.id}]`,
        message: `${project.name} precisa de problem, solution e result para virar case.`,
      });
    }
  }

  for (const skill of career.skills) {
    if (skill.evidence.length === 0) {
      warnings.push({
        code: 'skill_without_evidence',
        path: `skills[${skill.name}]`,
        message: `${skill.name} não aponta para nenhuma experiência ou projeto.`,
      });
    }
  }

  return warnings;
}

/** Tudo que ainda está como sugestão, esperando confirmação humana. */
export function listUnverified(career: Career): string[] {
  const paths: string[] = [];

  for (const item of career.experiences) {
    if (!item.provenance.verified) paths.push(`experiences[${item.id}]`);
  }
  for (const item of career.projects) {
    if (!item.provenance.verified) paths.push(`projects[${item.id}]`);
  }
  for (const item of career.skills) {
    if (!item.provenance.verified) paths.push(`skills[${item.name}]`);
  }
  for (const item of career.education) {
    if (!item.provenance.verified) paths.push(`education[${item.id}]`);
  }
  for (const item of career.certifications) {
    if (!item.provenance.verified) paths.push(`certifications[${item.id}]`);
  }

  return paths;
}

function countEntities(career: Career): Record<string, number> {
  return {
    experiences: career.experiences.length,
    projects: career.projects.length,
    skills: career.skills.length,
    education: career.education.length,
    certifications: career.certifications.length,
    languages: career.languages.length,
  };
}

export function registerValidateTool(server: McpServer, config: Config): void {
  server.registerTool(
    'validate_all',
    {
      title: 'Auditar o career.yml',
      description: `Valida o career.yml e aponta o que está incompleto. Não escreve nada.

Retorna:
  - valid: false quando o arquivo não passa no schema
  - schema_issues[]: { path, message } — erro de formato, impede salvar
  - warnings[]: { code, path, message } — material faltando, não impede salvar
      experience_without_bullets, project_incomplete, skill_without_evidence
  - unverified[]: caminhos que ainda são sugestão, esperando você confirmar
  - counts: quantidade por coleção (ausente quando o schema falha)

Se valid for false, warnings e unverified vêm vazios: sem parse não dá para
auditar conteúdo. Corrija schema_issues primeiro.`,
      inputSchema: {},
      outputSchema: {
        valid: z.boolean(),
        schema_issues: z.array(z.object({ path: z.string(), message: z.string() })),
        warnings: z.array(
          z.object({ code: z.string(), path: z.string(), message: z.string() }),
        ),
        unverified: z.array(z.string()),
        counts: z.record(z.string(), z.number().int()).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      let career: Career | undefined;
      let schemaIssues: Issue[] = [];

      try {
        career = await loadCareer(config.paths.career);
      } catch (error) {
        // Schema inválido é resultado da auditoria, não falha da tool. Arquivo
        // ausente ou ilegível é falha de verdade e continua subindo.
        if (!(error instanceof CareerValidationError)) throw error;
        schemaIssues = error.issues;
      }

      const report = {
        valid: career !== undefined,
        schema_issues: schemaIssues,
        warnings: career ? auditCareer(career) : [],
        unverified: career ? listUnverified(career) : [],
        ...(career ? { counts: countEntities(career) } : {}),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
        structuredContent: report,
      };
    },
  );
}
