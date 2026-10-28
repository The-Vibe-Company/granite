import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpCommand, parseMcpRole, parsePort, parseTransport, resolveAuthToken } from '../../src/commands/mcp.js';

const originalPort = process.env.PORT;
const originalMcpPort = process.env.MCP_PORT;
const originalGraniteMcpToken = process.env.GRANITE_MCP_TOKEN;

describe('mcp command helpers', () => {
  afterEach(() => {
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    if (originalMcpPort === undefined) {
      delete process.env.MCP_PORT;
    } else {
      process.env.MCP_PORT = originalMcpPort;
    }
    if (originalGraniteMcpToken === undefined) {
      delete process.env.GRANITE_MCP_TOKEN;
    } else {
      process.env.GRANITE_MCP_TOKEN = originalGraniteMcpToken;
    }
  });

  it('prefers the explicit port over MCP_PORT', () => {
    process.env.MCP_PORT = '4444';
    expect(parsePort('5555')).toBe(5555);
  });

  it('falls back to MCP_PORT, Railway PORT, and then the default port', () => {
    process.env.PORT = '8080';
    process.env.MCP_PORT = '4444';
    expect(parsePort()).toBe(4444);

    delete process.env.MCP_PORT;
    expect(parsePort()).toBe(8080);
    delete process.env.PORT;
    expect(parsePort()).toBe(3321);
  });

  it.each(['0', '65536', '-1', 'abc'])('rejects invalid TCP port %s', port => {
    expect(() => parsePort(port)).toThrow('Invalid MCP port');
  });

  it('rejects --web-api on stdio transport', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);

    try {
      await expect(mcpCommand({ transport: 'stdio', webApi: true, vault: '/tmp/nonexistent-vault' }))
        .rejects.toThrow('process.exit(1)');
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('--web-api requires --transport http');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('rejects invalid transport values', () => {
    expect(() => parseTransport('streamable-http' as 'stdio')).toThrow('Invalid MCP transport');
  });

  it('parses MCP access roles', () => {
    expect(parseMcpRole()).toBe('write');
    expect(parseMcpRole('read')).toBe('read');
    expect(parseMcpRole('write')).toBe('write');
    expect(() => parseMcpRole('admin')).toThrow('Invalid MCP role');
  });

  it('resolves the MCP auth token from explicit options and GRANITE_MCP_TOKEN', () => {
    process.env.GRANITE_MCP_TOKEN = 'env-token';

    expect(resolveAuthToken('explicit-token')).toBe('explicit-token');
    expect(resolveAuthToken()).toBe('env-token');

    delete process.env.GRANITE_MCP_TOKEN;
    expect(resolveAuthToken()).toBeUndefined();
    expect(() => resolveAuthToken('   ')).toThrow('Invalid MCP auth token');
  });
});
