import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkPlugin } from '../scripts/check-plugin.mjs';
import { validateToolCatalog, validateServerIdentity, validateServerUrl, validateLocalSmokeUrl } from '../scripts/mcp-client.mjs';
import { packagePlugin, parsePackageArgs, verifyRemoteCatalog } from '../scripts/package-plugin.mjs';
import { parseSmokeArgs, smokeMcp } from '../scripts/smoke-mcp.mjs';

const validTools = [
  {
    name: 'plan_journey',
    description: 'Plan a Dutch train journey.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' }, dateTime: { type: 'string', format: 'date-time' },
        searchForArrival: { type: 'boolean' }, accessible: { type: 'boolean' }, language: { type: 'string', enum: ['nl', 'en'] }
      },
      required: ['from', 'to'], additionalProperties: false
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'no_results', 'needs_clarification'] }, retrievedAt: { type: 'string', format: 'date-time' }, clarification: { type: ['object', 'null'] },
        from: { type: ['object', 'null'] }, to: { type: ['object', 'null'] }, arrivalDeadline: { type: ['string', 'null'] },
        recommendedIndex: { type: ['integer', 'null'] }, journeys: { type: 'array', maxItems: 3 }
      },
      required: ['status', 'retrievedAt', 'clarification', 'from', 'to', 'arrivalDeadline', 'recommendedIndex', 'journeys']
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'get_departures',
    description: 'List current departures.',
    inputSchema: {
      type: 'object',
      properties: {
        station: { type: 'string' }, dateTime: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1, maximum: 20 }, language: { type: 'string', enum: ['nl', 'en'] }
      },
      required: ['station'], additionalProperties: false
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'no_results', 'needs_clarification'] }, retrievedAt: { type: 'string', format: 'date-time' }, clarification: { type: ['object', 'null'] },
        station: { type: ['object', 'null'] }, departures: { type: 'array', maxItems: 20 }
      },
      required: ['status', 'retrievedAt', 'clarification', 'station', 'departures']
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'get_disruptions',
    description: 'List current or planned disruptions.',
    inputSchema: {
      type: 'object',
      properties: { station: { type: 'string' }, isActive: { type: 'boolean' }, language: { type: 'string', enum: ['nl', 'en'] } },
      required: [], additionalProperties: false
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'no_results', 'needs_clarification'] }, retrievedAt: { type: 'string', format: 'date-time' }, clarification: { type: ['object', 'null'] },
        scope: { type: 'string', enum: ['national', 'station'] }, station: { type: ['object', 'null'] },
        disruptions: { type: 'array', maxItems: 20 }, truncated: { type: 'boolean' }
      },
      required: ['status', 'retrievedAt', 'clarification', 'scope', 'station', 'disruptions', 'truncated']
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  }
];

describe('plugin source package', () => {
  it('passes package, skill, reference, and pending-evaluation integrity checks', async () => {
    expect(await checkPlugin()).toEqual([]);
  });

  it('rejects a skill reference that escapes its skill directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ns-plugin-check-'));
    try {
      const pluginDir = join(root, 'plugin');
      const evaluationsDir = join(root, 'evaluations');
      await cp(new URL('../plugin/', import.meta.url), pluginDir, { recursive: true });
      await cp(new URL('../evaluations/', import.meta.url), evaluationsDir, { recursive: true });
      const skillPath = join(pluginDir, 'skills', 'ns-travel', 'SKILL.md');
      const skill = await readFile(skillPath, 'utf8');
      await writeFile(skillPath, skill.replace('references/server-contract.md', '../../plugin.json'));

      expect((await checkPlugin({ pluginDir, evaluationsDir })).join('\n')).toMatch(/contained|escape|reference/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a results template that claims a live observation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ns-plugin-eval-'));
    try {
      const pluginDir = join(root, 'plugin');
      const evaluationsDir = join(root, 'evaluations');
      await cp(new URL('../plugin/', import.meta.url), pluginDir, { recursive: true });
      await cp(new URL('../evaluations/', import.meta.url), evaluationsDir, { recursive: true });
      const templatePath = join(evaluationsDir, 'results.template.json');
      const template = JSON.parse(await readFile(templatePath, 'utf8'));
      const firstRun = Object.values(template.results)[0] as { untagged: { status: string } };
      firstRun.untagged.status = 'pass';
      await writeFile(templatePath, `${JSON.stringify(template, null, 2)}\n`);

      expect((await checkPlugin({ pluginDir, evaluationsDir })).join('\n')).toMatch(/pending|observation/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts valid optional metadata, contained references, and additional evaluation cases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ns-plugin-extensible-'));
    try {
      const pluginDir = join(root, 'plugin');
      const evaluationsDir = join(root, 'evaluations');
      await cp(new URL('../plugin/', import.meta.url), pluginDir, { recursive: true });
      await cp(new URL('../evaluations/', import.meta.url), evaluationsDir, { recursive: true });
      const manifestPath = join(pluginDir, 'plugin.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.homepage = 'https://example.org/ns-travel';
      manifest.extensions['com.openai'].interface.developerName = 'Example Publisher';
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await writeFile(join(pluginDir, 'skills', 'ns-travel', 'references', 'extra.md'), '# Extra contained notes\n');

      const casesPath = join(evaluationsDir, 'cases.json');
      const cases = JSON.parse(await readFile(casesPath, 'utf8'));
      const extraCase = {
        id: 'nl-accessible-journey', kind: 'positive', language: 'nl',
        prompt: 'Plan een toegankelijke treinreis van Leiden naar Delft.',
        expected: { tool: 'plan_journey', action: 'invoke' }, runModes: ['untagged', 'tagged']
      };
      cases.cases.push(extraCase);
      await writeFile(casesPath, `${JSON.stringify(cases, null, 2)}\n`);
      const resultsPath = join(evaluationsDir, 'results.template.json');
      const results = JSON.parse(await readFile(resultsPath, 'utf8'));
      results.results[extraCase.id] = {
        untagged: { status: 'pending', repetitions: 0, hostVersion: null, pluginVersion: null, observedCalls: null, observations: null },
        tagged: { status: 'pending', repetitions: 0, hostVersion: null, pluginVersion: null, observedCalls: null, observations: null }
      };
      await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);

      expect(await checkPlugin({ pluginDir, evaluationsDir })).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('remote package catalog verification', () => {
  it('accepts the exact three read-only tools and their input/output fields', () => {
    expect(validateToolCatalog(validTools)).toEqual([]);
  });

  it('rejects extra legacy tools, changed inputs, or missing outputs', () => {
    expect(validateToolCatalog([...validTools, { name: 'get_price' }]).join('\n')).toMatch(/exact|tool/i);

    const changed = structuredClone(validTools);
    changed[0].inputSchema.properties.from = undefined;
    expect(validateToolCatalog(changed).join('\n')).toMatch(/from|input/i);

    const missingOutput = structuredClone(validTools);
    delete missingOutput[1].outputSchema.properties.departures;
    expect(validateToolCatalog(missingOutput).join('\n')).toMatch(/departures|output/i);

    const writable = structuredClone(validTools);
    writable[0].annotations.readOnlyHint = false;
    expect(validateToolCatalog(writable).join('\n')).toMatch(/read-only/i);

    const badOutputShape = structuredClone(validTools);
    badOutputShape[0].outputSchema.type = 'array';
    expect(validateToolCatalog(badOutputShape).join('\n')).toMatch(/outputSchema/i);
  });

  it('requires the remote server identity and package version to match', () => {
    expect(() => validateServerIdentity({ name: 'ns-reisplanner-mvp', version: '0.1.0' }, '0.1.0')).not.toThrow();
    expect(() => validateServerIdentity({ name: 'old-ns-service', version: '0.1.0' }, '0.1.0')).toThrow(/identity/i);
    expect(() => validateServerIdentity({ name: 'ns-reisplanner-mvp', version: '0.2.0' }, '0.1.0')).toThrow(/identity/i);
  });

  it('creates and inspects an archive after a mocked SDK initialization and exact catalog check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ns-plugin-archive-'));
    try {
      const archivePath = join(root, 'out', 'ns-reisplanner-mvp.tar.gz');
      const transport = { local: true };
      let connected = false;
      let closed = false;
      const fakeClient = {
        connect: async (candidate: unknown) => { connected = candidate === transport; },
        getServerVersion: () => ({ name: 'ns-reisplanner-mvp', version: '0.1.0' }),
        getServerCapabilities: () => ({}),
        listTools: async () => ({ tools: validTools }),
        close: async () => { closed = true; }
      };
      const verifyCatalog = (url: string, version: string) => verifyRemoteCatalog(url, version, {
        createClient: () => fakeClient as never,
        createTransport: () => transport as never
      });

      const result = await packagePlugin({ serverUrl: 'https://mcp.example.org/mcp', outputPath: archivePath, verifyCatalog });
      const entries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
      const archivedMcp = JSON.parse(execFileSync('tar', ['-xOf', archivePath, 'ns-reisplanner-mvp/mcp.json'], { encoding: 'utf8' }));
      expect(result.archivePath).toBe(archivePath);
      expect(result.toolNames).toEqual(['plan_journey', 'get_departures', 'get_disruptions']);
      expect(entries).toContain('ns-reisplanner-mvp/plugin.json');
      expect(archivedMcp.mcpServers['ns-reisplanner'].url).toBe('https://mcp.example.org/mcp');
      expect(connected).toBe(true);
      expect(closed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the public HTTPS guard in front of the package verifier seam', async () => {
    const verifyCatalog = async () => { throw new Error('The verifier must not run for a local URL.'); };
    await expect(packagePlugin({ serverUrl: 'http://localhost:8787/mcp', outputPath: '/tmp/no-plugin.tar.gz', verifyCatalog })).rejects.toThrow(/HTTPS/);
  });

  it('accepts only credential-free public HTTPS package URLs', () => {
    expect(validateServerUrl('https://mcp.example.org/mcp').href).toBe('https://mcp.example.org/mcp');
    for (const url of [
      'http://mcp.example.org/mcp',
      'https://user:pass@mcp.example.org/mcp',
      'https://mcp.example.org/mcp?token=secret',
      'https://mcp.example.org/mcp#fragment',
      'https://localhost:8787/mcp',
      'https://127.0.0.1/mcp',
      'https://service.local/mcp'
    ]) {
      expect(() => validateServerUrl(url), url).toThrow();
    }
  });

  it('limits smoke URLs to localhost HTTP and rejects remote or credentialed endpoints', () => {
    expect(validateLocalSmokeUrl('http://127.0.0.1:8787/mcp').hostname).toBe('127.0.0.1');
    expect(validateLocalSmokeUrl('http://localhost:8787/mcp').hostname).toBe('localhost');
    for (const url of ['https://mcp.example.org/mcp', 'http://example.org/mcp', 'http://user:pass@localhost:8787/mcp']) {
      expect(() => validateLocalSmokeUrl(url), url).toThrow();
    }
  });

  it('requires an explicit verified package URL and defaults smoke to inspection only', () => {
    expect(() => parsePackageArgs([])).toThrow(/explicit --server-url/);
    expect(parsePackageArgs(['--server-url', 'https://mcp.example.org/mcp']).serverUrl).toBe('https://mcp.example.org/mcp');
    expect(parseSmokeArgs(['--server-url', 'http://localhost:8787/mcp']).toolArguments).toBeUndefined();
    expect(() => parseSmokeArgs(['--server-url', 'http://localhost:8787/mcp', '--tool', 'plan_journey'])).toThrow(/both --tool and explicit JSON/);
    expect(() => parseSmokeArgs(['--server-url', 'http://localhost:8787/mcp', '--tool', 'plan_journey', '--args', '{"from":"a","token":"x"}'])).toThrow(/secret-like/);
  });

  it('fails a smoke call when the requested read-only tool returns an MCP error', async () => {
    const fakeClient = {
      connect: async () => {},
      getServerCapabilities: () => ({}),
      listTools: async () => ({ tools: validTools }),
      callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'redacted' }] }),
      close: async () => {}
    };
    await expect(smokeMcp({
      serverUrl: 'http://127.0.0.1:8787/mcp', tool: 'plan_journey', toolArguments: { from: 'ASD', to: 'UT' },
      clientFactory: () => fakeClient as never, transportFactory: () => ({}) as never
    })).rejects.toThrow(/MCP error/);
  });
});
