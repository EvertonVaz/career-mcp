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
  });

  it('respeita MCP_HOST', () => {
    expect(loadConfig({ ...MINIMAL, MCP_HOST: '127.0.0.1' }).host).toBe('127.0.0.1');
  });

  it('respeita CAREER_OUTPUT_DIR', () => {
    expect(loadConfig({ ...MINIMAL, CAREER_OUTPUT_DIR: './output' }).paths.output).toBe('./output');
  });

  it('respeita CAREER_CACHE_DIR', () => {
    expect(loadConfig({ ...MINIMAL, CAREER_CACHE_DIR: './cache' }).paths.cache).toBe('./cache');
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

  it('deixa githubApiUrl indefinido para usar github.com', () => {
    expect(loadConfig(MINIMAL).githubApiUrl).toBeUndefined();
    expect(loadConfig({ ...MINIMAL, GITHUB_API_URL: 'http://local' }).githubApiUrl).toBe(
      'http://local',
    );
  });
});
