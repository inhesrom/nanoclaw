import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allowedMcpToolPatterns,
  buildClaudeMcpServers,
  buildCodexMcpConfigToml,
  buildGrokMcpConfigToml,
  MCP_SERVERS,
} from './mcp-servers.js';

test('gdocs is registered with placeholder auth and the proxy preload', () => {
  const definition = MCP_SERVERS.find((server) => server.name === 'gdocs');
  assert.ok(definition);
  assert.deepEqual(definition.args, ['/tmp/dist/gdocs-mcp.js']);
  assert.deepEqual(definition.env, { GOOGLE_API_ACCESS_TOKEN: 'placeholder' });
  assert.equal(definition.proxyEnv, true);
  assert.equal(definition.nodePreload, true);
  assert.ok(allowedMcpToolPatterns().includes('mcp__gdocs__*'));
});

test('Claude, Codex, and Grok gdocs configs include proxy variables and preload', () => {
  const originalHttpsProxy = process.env.HTTPS_PROXY;
  const originalCa = process.env.NODE_EXTRA_CA_CERTS;
  const originalNodeOptions = process.env.NODE_OPTIONS;
  process.env.HTTPS_PROXY = 'http://gateway.invalid:10255';
  process.env.NODE_EXTRA_CA_CERTS = '/tmp/onecli-ca.pem';
  process.env.NODE_OPTIONS = '--trace-warnings';
  try {
    const claude = buildClaudeMcpServers().gdocs;
    assert.ok(claude);
    assert.equal(claude.env.HTTPS_PROXY, 'http://gateway.invalid:10255');
    assert.equal(claude.env.NODE_EXTRA_CA_CERTS, '/tmp/onecli-ca.pem');
    assert.equal(
      claude.env.NODE_OPTIONS,
      '--trace-warnings --import=file:///app/proxy-preload.mjs',
    );

    for (const build of [buildCodexMcpConfigToml, buildGrokMcpConfigToml]) {
      const tomlConfig = build();
      assert.match(tomlConfig, /\[mcp_servers\.gdocs\]/);
      assert.match(tomlConfig, /GOOGLE_API_ACCESS_TOKEN = "placeholder"/);
      assert.match(
        tomlConfig,
        /HTTPS_PROXY = "http:\/\/gateway\.invalid:10255"/,
      );
      assert.match(
        tomlConfig,
        /NODE_EXTRA_CA_CERTS = "\/tmp\/onecli-ca\.pem"/,
      );
      assert.match(
        tomlConfig,
        /NODE_OPTIONS = "--import=file:\/\/\/app\/proxy-preload\.mjs"/,
      );
    }
  } finally {
    if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalHttpsProxy;
    if (originalCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = originalCa;
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalNodeOptions;
  }
});
