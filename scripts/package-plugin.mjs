import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkPlugin } from './check-plugin.mjs';
import {
  assertNoUiResources,
  createMcpClient,
  createStreamableHttpTransport,
  TOOL_NAMES,
  validateServerUrl,
  validateServerIdentity,
  validateToolCatalog
} from './mcp-client.mjs';

const execFileAsync = promisify(execFile);
const copyFileExclusive = constants.COPYFILE_EXCL;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const sourcePluginDir = join(repoRoot, 'plugin');
const evaluationsDir = join(repoRoot, 'evaluations');
const archivePackageName = 'ns-reisplanner-mvp';
const defaultArchive = join(repoRoot, 'dist', `${archivePackageName}.tar.gz`);

function isWithinPath(childPath, parentPath) {
  const rel = relative(resolve(parentPath), resolve(childPath));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function parsePackageArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--server-url' || key === '--output') {
      if (parsed[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) {
        throw new TypeError(`${key} requires exactly one value and may appear only once.`);
      }
      parsed[key] = args[index + 1];
      index += 1;
    } else {
      throw new TypeError(`Unknown package option: ${key}`);
    }
  }
  if (!parsed['--server-url']) throw new TypeError('Supply an explicit --server-url HTTPS endpoint.');
  return {
    serverUrl: parsed['--server-url'],
    outputPath: parsed['--output'] ? resolve(parsed['--output']) : defaultArchive
  };
}

/**
 * @param {string} serverUrl
 * @param {string} version
 * @param {{createClient?: (options: {name: string, version: string}) => any, createTransport?: (url: URL) => any}} [adapters]
 * @returns {Promise<void>}
 */
export async function verifyRemoteCatalog(serverUrl, version, adapters = {}) {
  const url = validateServerUrl(serverUrl);
  const client = (adapters.createClient ?? createMcpClient)({ name: 'ns-reisplanner-mvp-package-check', version: '1.0.0' });
  const transport = (adapters.createTransport ?? createStreamableHttpTransport)(url);
  try {
    await client.connect(transport);
    validateServerIdentity(client.getServerVersion(), version);
    const response = await client.listTools();
    const errors = validateToolCatalog(response.tools);
    if (errors.length) throw new Error(errors.join('\n'));
    await assertNoUiResources(client);
  } catch (error) {
    if (error instanceof Error && /^(?:MCP |plan_journey |get_departures |get_disruptions )/.test(error.message)) {
      throw error;
    }
    throw new Error('Could not initialize and inspect the supplied MCP server. No package archive was created.');
  } finally {
    try {
      await client.close();
    } catch {
      // A failed initialization may leave no active transport to close.
    }
  }
}

async function outputDoesNotExist(path) {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Created archive is empty.');
  const required = new Set([
    `${archivePackageName}/plugin.json`,
    `${archivePackageName}/mcp.json`,
    `${archivePackageName}/skills/ns-travel/SKILL.md`,
    `${archivePackageName}/skills/ns-travel/agents/openai.yaml`,
    `${archivePackageName}/skills/ns-travel/references/server-contract.md`
  ]);
  for (const rawEntry of entries) {
    const entry = rawEntry.replace(/\/$/, '');
    const segments = entry.split('/');
    if (entry.startsWith('/') || entry.includes('\\') || segments.includes('..') || segments[0] !== archivePackageName) {
      throw new Error('Created archive contains an unexpected or unsafe path.');
    }
    required.delete(entry);
  }
  if (required.size) throw new Error(`Created archive is missing required components: ${[...required].join(', ')}.`);
}

/**
 * @param {{serverUrl: string, outputPath?: string, verifyCatalog?: (serverUrl: string, version: string) => Promise<void>}} options
 */
export async function packagePlugin({ serverUrl, outputPath = defaultArchive, verifyCatalog = verifyRemoteCatalog } = {}) {
  if (!serverUrl) throw new TypeError('Supply an explicit --server-url HTTPS endpoint.');
  const publicUrl = validateServerUrl(serverUrl);
  const output = resolve(outputPath);
  if (isWithinPath(output, sourcePluginDir)) throw new TypeError('Archive output must be outside the plugin package directory.');
  if (!(await outputDoesNotExist(output))) throw new TypeError('Archive output already exists; choose a new path.');

  const sourceErrors = await checkPlugin({ pluginDir: sourcePluginDir, evaluationsDir });
  if (sourceErrors.length) throw new Error(`Plugin source check failed:\n${sourceErrors.join('\n')}`);

  const manifest = JSON.parse(await readFile(join(sourcePluginDir, 'plugin.json'), 'utf8'));
  await verifyCatalog(publicUrl.href, manifest.version);

  const tempRoot = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'ns-reisplanner-mvp-'));
  const stagingRoot = join(tempRoot, 'staging');
  const packageRoot = join(stagingRoot, archivePackageName);
  const temporaryArchive = join(tempRoot, `${archivePackageName}.tar.gz`);
  const verificationRoot = join(tempRoot, 'archive-verification');
  let outputCreated = false;
  try {
    await mkdir(stagingRoot, { recursive: true });
    await cp(sourcePluginDir, packageRoot, { recursive: true, errorOnExist: true, force: false });
    const mcpConfig = {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        'ns-reisplanner': {
          type: 'streamable-http',
          url: publicUrl.href
        }
      }
    };
    await writeFile(join(packageRoot, 'mcp.json'), `${JSON.stringify(mcpConfig, null, 2)}\n`, { flag: 'wx' });

    const stagedErrors = await checkPlugin({ pluginDir: packageRoot, evaluationsDir, allowMcp: true });
    if (stagedErrors.length) throw new Error(`Staged package check failed:\n${stagedErrors.join('\n')}`);

    await mkdir(dirname(output), { recursive: true });
    if (!(await outputDoesNotExist(output))) throw new TypeError('Archive output appeared during packaging; choose a new path.');
    if (isWithinPath(output, tempRoot) || isWithinPath(output, stagingRoot) || isWithinPath(output, packageRoot)) {
      throw new TypeError('Archive output must be outside the staging and package roots.');
    }
    await execFileAsync('tar', ['-czf', temporaryArchive, '-C', stagingRoot, basename(packageRoot)], { maxBuffer: 1024 * 1024 });

    const { stdout } = await execFileAsync('tar', ['-tzf', temporaryArchive], { maxBuffer: 1024 * 1024 });
    const entries = stdout.split(/\r?\n/).filter(Boolean);
    validateArchiveEntries(entries);
    await mkdir(verificationRoot, { recursive: true });
    await execFileAsync('tar', ['-xzf', temporaryArchive, '-C', verificationRoot], { maxBuffer: 1024 * 1024 });
    const archivedErrors = await checkPlugin({
      pluginDir: join(verificationRoot, archivePackageName),
      evaluationsDir,
      allowMcp: true
    });
    if (archivedErrors.length) throw new Error(`Final archive check failed:\n${archivedErrors.join('\n')}`);
    const archivedMcp = JSON.parse(await readFile(join(verificationRoot, archivePackageName, 'mcp.json'), 'utf8'));
    if (archivedMcp.mcpServers['ns-reisplanner'].url !== publicUrl.href) {
      throw new Error('Final archive endpoint differs from the verified server URL.');
    }
    await copyFile(temporaryArchive, output, copyFileExclusive);
    outputCreated = true;
    const finalArchive = await execFileAsync('tar', ['-tzf', output], { maxBuffer: 1024 * 1024 });
    validateArchiveEntries(finalArchive.stdout.split(/\r?\n/).filter(Boolean));
    return { archivePath: output, toolNames: TOOL_NAMES };
  } catch (error) {
    if (outputCreated) await rm(output, { force: true });
    throw error;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function isCliEntry() {
  return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isCliEntry()) {
  if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
    console.log('Usage: node scripts/package-plugin.mjs --server-url https://MCP_HOST/mcp [--output /path/to/plugin.tar.gz]');
    console.log('The public HTTPS server is initialized and its exact three-tool catalog is verified before packaging.');
  } else {
    try {
      const args = parsePackageArgs(process.argv.slice(2));
      const result = await packagePlugin(args);
      console.log(`Verified three-tool catalog and inspected archive: ${result.archivePath}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Plugin packaging failed.');
      process.exitCode = 1;
    }
  }
}
