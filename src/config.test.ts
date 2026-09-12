import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const MINIMAL = { MCP_AUTH_TOKEN: 'segredo' };

describe('loadConfig', () => {
  it('falha sem MCP_AUTH_TOKEN', () => {
    expect(() => loadConfig({})).toThrow(/MCP_AUTH_TOKEN/);
  });

  it('falha com MCP_AUTH_TOKEN vazio', () => {
    expect(() => loadConfig({ MCP_AUTH_TOKEN: '' })).toThrow(/MCP_AUTH_TOKEN/);
  });

  it('aplica os defaults de porta, host e paths', () => {
    const config = loadConfig(MINIMAL);

    expect(config.port).toBe(3000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.paths.career).toBe('/app/data/career.yml');
    expect(config.paths.history).toBe('/app/history');
  });

  it('respeita MCP_PORT e CAREER_DATA_DIR', () => {
    const config = loadConfig({ ...MINIMAL, MCP_PORT: '8080', CAREER_DATA_DIR: './data' });

    expect(config.port).toBe(8080);
    expect(config.paths.career).toBe('data/career.yml');
    expect(config.paths.private).toBe('data/private.yml');
  });

  it('falha com MCP_PORT não numérica', () => {
    expect(() => loadConfig({ ...MINIMAL, MCP_PORT: 'abc' })).toThrow(/MCP_PORT/);
  });

  it('falha com MCP_PORT fora do intervalo', () => {
    expect(() => loadConfig({ ...MINIMAL, MCP_PORT: '70000' })).toThrow(/MCP_PORT/);
  });

  it('guarda o hash do token, nunca o token cru', () => {
    const config = loadConfig(MINIMAL);

    expect(config.authTokenHash).toEqual(createHash('sha256').update('segredo').digest());
    expect(JSON.stringify(config)).not.toContain('segredo');
  });

  it('deixa githubToken indefinido quando ausente', () => {
    expect(loadConfig(MINIMAL).githubToken).toBeUndefined();
  });
});
