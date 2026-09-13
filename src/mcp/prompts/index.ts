import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCreateProfilePrompt } from './create-profile.js';
import { registerQuarterlyAuditPrompt } from './quarterly-audit.js';
import { registerTailorResumePrompt } from './tailor-resume.js';
import { registerUpdateLinkedinPrompt } from './update-linkedin.js';

export function registerPrompts(server: McpServer): void {
  registerCreateProfilePrompt(server);
  registerUpdateLinkedinPrompt(server);
  registerTailorResumePrompt(server);
  registerQuarterlyAuditPrompt(server);
}
