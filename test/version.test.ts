import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('version', () => {
  it('the MCP server reports the package version, which tags the image', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8')).toContain(`version: '${pkg.version}'`);
  });
});
