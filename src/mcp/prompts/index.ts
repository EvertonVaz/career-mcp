import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerQuarterlyAuditPrompt } from './quarterly-audit.js';
import { registerTailorResumePrompt } from './tailor-resume.js';
import { registerUpdateLinkedinPrompt } from './update-linkedin.js';

export function registerPrompts(server: McpServer): void {
  registerUpdateLinkedinPrompt(server);
  registerTailorResumePrompt(server);
  registerQuarterlyAuditPrompt(server);
}
