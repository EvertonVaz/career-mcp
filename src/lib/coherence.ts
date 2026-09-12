import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { renderLinkedin } from '../templates/linkedin.js';
import { renderPortfolio } from '../templates/portfolio.js';
import { renderResume } from '../templates/resume.js';
import type { Career } from './schema.js';

export type Channel = 'linkedin' | 'resume' | 'portfolio';

export const CHANNELS: Channel[] = ['linkedin', 'resume', 'portfolio'];

const RENDERERS: Record<Channel, (career: Career) => string> = {
  linkedin: renderLinkedin,
  resume: renderResume,
  portfolio: renderPortfolio,
};

export type ChannelStatus = {
  channel: Channel;
  /** missing: nunca gerado. stale: career.yml mudou desde a geração. */
  status: 'missing' | 'stale' | 'current';
  added: string[];
  removed: string[];
};

/** Quantas linhas de diferença reportar antes de cortar. */
const MAX_LINES = 20;

export function outputPath(outputDir: string, channel: Channel): string {
  return path.join(outputDir, `${channel}.md`);
}

export function render(career: Career, channel: Channel): string {
  return RENDERERS[channel](career);
}

function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const beforeLines = new Set(before.split('\n').filter((line) => line.trim() !== ''));
  const afterLines = new Set(after.split('\n').filter((line) => line.trim() !== ''));

  return {
    added: [...afterLines].filter((line) => !beforeLines.has(line)).slice(0, MAX_LINES),
    removed: [...beforeLines].filter((line) => !afterLines.has(line)).slice(0, MAX_LINES),
  };
}

/**
 * Os três canais saem do mesmo career.yml, então entre si são coerentes por
 * construção. O que desencontra é o arquivo gerado ficar velho depois de uma
 * edição — é isso que medimos aqui.
 */
export async function compareChannel(
  career: Career,
  outputDir: string,
  channel: Channel,
): Promise<ChannelStatus> {
  const fresh = render(career, channel);

  let current: string;
  try {
    current = await readFile(outputPath(outputDir, channel), 'utf8');
  } catch {
    return { channel, status: 'missing', added: [], removed: [] };
  }

  if (current === fresh) return { channel, status: 'current', added: [], removed: [] };

  return { channel, status: 'stale', ...lineDiff(current, fresh) };
}
