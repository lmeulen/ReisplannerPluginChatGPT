import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { validateServerUrl } from './mcp-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = new Set(['plan_journey', 'get_departures', 'get_disruptions']);
const manifestFields = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']);
const forbiddenBindings = new Set(['apps', 'logo', 'composericon', 'logodark', 'composericondark']);
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = value => typeof value === 'string' && value.trim().length > 0;

async function walk(path, errors, files = []) {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch { return files; }
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isSymbolicLink()) errors.push(`Symlinks are not allowed in plugin packages: ${full}`);
    else if (entry.isDirectory()) await walk(full, errors, files);
    else if (entry.isFile()) files.push(full);
    else errors.push(`Unsupported filesystem entry in plugin package: ${full}`);
  }
  return files;
}

async function readJson(path, label, errors) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { errors.push(`${label} must be valid UTF-8 JSON.`); return null; }
}

function validateManifest(manifest, errors) {
  if (!record(manifest)) { errors.push('plugin.json must be a JSON object.'); return; }
  for (const key of Object.keys(manifest)) if (!manifestFields.has(key) && !['extensions'].includes(key)) errors.push(`Unsupported plugin.json field: ${key}.`);
  if (manifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') errors.push('plugin.json must use the Agent Plugins 1.0 schema.');
  if (manifest.name !== 'ns-reisplanner-mvp') errors.push('plugin.json name must be ns-reisplanner-mvp.');
  if (typeof manifest.version !== 'string' || !semver.test(manifest.version)) errors.push('plugin.json version must be strict SemVer.');
  if (!nonblank(manifest.description)) errors.push('plugin.json needs a nonblank description.');
  if (!record(manifest.extensions) || Object.keys(manifest.extensions).some(key => key !== 'com.openai')) errors.push('plugin.json may use only the com.openai extension.');
  const openai = manifest.extensions?.['com.openai'];
  const ui = openai?.interface;
  if (!record(openai) || !record(ui)) { errors.push('plugin.json needs com.openai.interface metadata.'); return; }
  for (const key of Object.keys(openai)) if (key.toLowerCase() === 'apps') errors.push('Plugin app bindings are excluded.');
  for (const key of Object.keys(ui)) if (forbiddenBindings.has(key.toLowerCase())) errors.push(`Plugin UI or icon binding is excluded: ${key}.`);
  for (const key of ['displayName', 'shortDescription', 'longDescription']) if (!nonblank(ui[key])) errors.push(`interface.${key} must be nonblank.`);
  if (!nonblank(ui.category) || ui.category !== 'Travel') errors.push('interface.category must be the supported Travel category.');
  if (typeof ui.shortDescription === 'string' && ui.shortDescription.length > 30) errors.push('interface.shortDescription must be at most 30 characters.');
  if (!Array.isArray(ui.capabilities) || ui.capabilities.length !== 0) errors.push('interface.capabilities must be an empty array for this text-only plugin.');
  if (!(nonblank(ui.defaultPrompt) || (Array.isArray(ui.defaultPrompt) && ui.defaultPrompt.length > 0 && ui.defaultPrompt.length <= 3 && ui.defaultPrompt.every(nonblank)))) {
    errors.push('interface.defaultPrompt must be one to three nonblank prompts.');
  }
  for (const [key, value] of Object.entries(manifest)) {
    if (['description', 'version', 'homepage', 'repository', 'license'].includes(key) && typeof value !== 'string') errors.push(`plugin.json ${key} must be a string.`);
    if (key === 'keywords' && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) errors.push('plugin.json keywords must be strings.');
    if (key === 'author' && !record(value)) errors.push('plugin.json author must be an object.');
  }
}

function frontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter.');
  return { metadata: parseYaml(match[1]), body: markdown.slice(match[0].length) };
}

function validateLinks(markdown, skillDir, errors, files) {
  let contained = 0;
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().split(/[?#]/, 1)[0];
    let target;
    try { target = decodeURIComponent(raw); }
    catch { errors.push(`Invalid skill reference encoding: ${raw}.`); continue; }
    if (!target || target.startsWith('/') || target.includes('\\') || /^[a-z][a-z\d+.-]*:/i.test(target) || target.split('/').includes('..')) {
      errors.push(`Skill links must stay inside the skill directory: ${raw}.`);
      continue;
    }
    const resolved = resolve(skillDir, target);
    const rel = relative(skillDir, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`)) errors.push(`Skill link escapes its directory: ${raw}.`);
    else if (!rel.startsWith(`references${sep}`) || !files.includes(resolved)) errors.push(`Skill link must point to an existing contained reference file: ${raw}.`);
    else contained += 1;
  }
  if (!contained) errors.push('SKILL.md must link to at least one contained reference.');
}

async function checkPluginTree(pluginDir, errors, allowMcp) {
  try {
    const stat = await lstat(pluginDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) { errors.push('Plugin root must be a real directory, not a symlink.'); return null; }
  } catch { errors.push(`Plugin directory is missing: ${pluginDir}`); return null; }
  let rootEntries = [];
  try { rootEntries = await readdir(pluginDir); }
  catch { errors.push(`Plugin directory is missing: ${pluginDir}`); return null; }
  const allowedRoot = allowMcp ? ['plugin.json', 'skills', 'mcp.json'] : ['plugin.json', 'skills'];
  if (rootEntries.some(name => !allowedRoot.includes(name)) || allowedRoot.some(name => !rootEntries.includes(name))) {
    errors.push(`Plugin root must contain ${allowedRoot.join(', ')}${allowMcp ? '' : ' and no placeholder mcp.json'}.`);
  }

  const errorsBeforeWalk = errors.length;
  const files = await walk(pluginDir, errors);
  if (errors.length > errorsBeforeWalk) return null;
  for (const path of files) {
    const lower = path.toLowerCase();
    if (/\.(?:png|jpe?g|webp|svg|ico)$/.test(lower)) errors.push('This plugin does not include UI or icon assets.');
    try {
      const content = await readFile(path, 'utf8');
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content) || /(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9/_+=-]{16,}/i.test(content)) {
        errors.push(`Credential-like content must not be packaged: ${path}`);
      }
    } catch { errors.push(`Plugin file must be readable UTF-8 text: ${path}`); }
  }
  const manifest = await readJson(join(pluginDir, 'plugin.json'), 'plugin/plugin.json', errors);
  validateManifest(manifest, errors);
  const skillDir = join(pluginDir, 'skills', 'ns-travel');
  const skillsDir = join(pluginDir, 'skills');
  try {
    const skillNames = await readdir(skillsDir);
    if (skillNames.length !== 1 || skillNames[0] !== 'ns-travel') errors.push('Package exactly one focused skill at skills/ns-travel/.');
  } catch { errors.push('Plugin must contain skills/ns-travel/.'); }

  let skill = '';
  try {
    skill = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
    const parsed = frontmatter(skill);
    if (!record(parsed.metadata) || parsed.metadata.name !== 'ns-travel' || !nonblank(parsed.metadata.description)) errors.push('SKILL.md frontmatter needs name ns-travel and a description.');
    const description = String(parsed.metadata?.description ?? '').toLowerCase();
    if (!/(dutch|nederlands)/.test(description) || !/(english|engels)/.test(description)) errors.push('Skill description must include Dutch and English triggers.');
    validateLinks(skill, skillDir, errors, files);
  } catch (error) { errors.push(error instanceof Error ? error.message : 'SKILL.md could not be parsed.'); }

  try {
    const agent = parseYaml(await readFile(join(skillDir, 'agents', 'openai.yaml'), 'utf8'));
    if (!record(agent) || Object.keys(agent).some(key => !['interface', 'policy', 'dependencies'].includes(key))) errors.push('agents/openai.yaml contains unsupported fields.');
    if (!record(agent?.policy) || agent.policy.allow_implicit_invocation !== true) errors.push('agents/openai.yaml must set policy.allow_implicit_invocation to boolean true.');
    if (agent?.policy && Object.keys(agent.policy).some(key => !['allow_implicit_invocation', 'products'].includes(key))) errors.push('agents/openai.yaml has unsupported policy fields.');
    if (agent?.policy?.products !== undefined && (!Array.isArray(agent.policy.products) || agent.policy.products.some(product => !['CHAT', 'CODEX', 'HERMES'].includes(product)))) errors.push('agents/openai.yaml policy.products contains an unsupported product.');
    if (agent?.interface !== undefined && (!record(agent.interface) || !nonblank(agent.interface.display_name) || !nonblank(agent.interface.short_description))) errors.push('agents/openai.yaml interface needs display_name and short_description.');
    if (agent?.dependencies !== undefined && (!record(agent.dependencies) || Object.keys(agent.dependencies).some(key => key !== 'tools'))) errors.push('agents/openai.yaml dependencies may contain only tools.');
  } catch { errors.push('agents/openai.yaml must be readable UTF-8 YAML.'); }

  const skillFiles = files.filter(path => path.startsWith(`${skillDir}${sep}`));
  const skillText = [skill, ...(await Promise.all(skillFiles.filter(path => path.endsWith('.md') && !path.endsWith(`${sep}SKILL.md`)).map(path => readFile(path, 'utf8').catch(() => ''))))].join('\n').toLowerCase();
  for (const name of tools) if (!skillText.includes(name)) errors.push(`Skill package must document ${name}.`);
  for (const term of ['needs_clarification', 'searchforarrival', 'datetime', 'europe/amsterdam', 'ov-fiets', 'booking', 'price']) {
    if (!skillText.includes(term)) errors.push(`Skill package must document ${term}.`);
  }

  if (allowMcp) {
    const config = await readJson(join(pluginDir, 'mcp.json'), 'plugin/mcp.json', errors);
    if (!record(config) || config.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' ||
        Object.keys(config).some(key => !['$schema', 'mcpServers'].includes(key)) ||
        !record(config.mcpServers) || Object.keys(config.mcpServers).length !== 1 || !record(config.mcpServers['ns-reisplanner'])) {
      errors.push('Generated mcp.json must contain the portable schema and one ns-reisplanner server.');
    } else {
      const server = config.mcpServers['ns-reisplanner'];
      if (server.type !== 'streamable-http' || Object.keys(server).some(key => !['type', 'url'].includes(key))) errors.push('Generated MCP server must use streamable-http without auth or extra fields.');
      try { validateServerUrl(server.url); } catch { errors.push('Generated mcp.json needs a public HTTPS URL without credentials, query, or fragment.'); }
    }
  }
  return manifest;
}

function validateEvaluations(casesFile, template, errors) {
  const cases = casesFile?.cases;
  if (!Array.isArray(cases) || cases.length === 0) { errors.push('evaluations/cases.json needs at least one routing case.'); return; }
  const ids = new Set();
  const modesById = new Map();
  for (const item of cases) {
    if (!record(item) || !/^[a-z0-9-]+$/.test(item.id ?? '') || ids.has(item.id) || !nonblank(item.prompt) || !['nl', 'en'].includes(item.language)) {
      errors.push('Each evaluation case needs a unique id, prompt, and nl or en language.'); continue;
    }
    ids.add(item.id);
    if (!['positive', 'negative'].includes(item.kind) || !record(item.expected) || !(item.expected.tool === null || tools.has(item.expected.tool)) ||
        !['invoke', 'invoke_then_clarify', 'ask_missing_input', 'no_ns_call'].includes(item.expected.action)) errors.push(`Evaluation case ${item.id} has invalid routing metadata.`);
    const modes = item.runModes;
    if (!Array.isArray(modes) || !modes.includes('untagged') || modes.some(mode => !['untagged', 'tagged'].includes(mode)) || new Set(modes).size !== modes.length) errors.push(`Evaluation case ${item.id} needs unique tagged/untagged run modes.`);
    else modesById.set(item.id, [...modes].sort());
    if (item.kind === 'positive' && !modes?.includes('tagged')) errors.push(`Positive case ${item.id} needs a tagged control.`);
    if (item.kind === 'negative' && (item.expected.tool !== null || item.expected.action !== 'no_ns_call' || modes?.includes('tagged'))) errors.push(`Negative case ${item.id} must expect no NS call and run untagged.`);
    if (item.expected?.tool && !['invoke', 'invoke_then_clarify'].includes(item.expected.action)) errors.push(`Positive case ${item.id} must state its invocation behavior.`);
    if (item.expected?.tool === null && !['ask_missing_input', 'no_ns_call'].includes(item.expected.action)) errors.push(`Case ${item.id} without a tool must ask for input or expect no NS call.`);
  }

  if (!record(template?.results) || JSON.stringify(Object.keys(template.results).sort()) !== JSON.stringify([...ids].sort())) {
    errors.push('Results template IDs must exactly match the evaluation cases.'); return;
  }
  for (const [id, runs] of Object.entries(template.results)) {
    if (!record(runs) || JSON.stringify(Object.keys(runs).sort()) !== JSON.stringify(modesById.get(id))) { errors.push(`Results template modes must match case ${id}.`); continue; }
    for (const [mode, result] of Object.entries(runs)) {
      if (!record(result) || result.status !== 'pending' || (result.repetitions !== undefined && result.repetitions !== 0) ||
          (result.observedCalls !== undefined && result.observedCalls !== null) || (result.observations !== undefined && result.observations !== null)) {
        errors.push(`Results template ${id}.${mode} must remain pending with no live observations.`);
      }
    }
  }
  if (template?.evaluatedAt !== null || template?.hostVersion !== null || template?.pluginVersion !== null) errors.push('Results template live metadata must begin as null.');
}

export async function checkPlugin({ pluginDir = join(root, 'plugin'), evaluationsDir = join(root, 'evaluations'), allowMcp = false } = {}) {
  const errors = [];
  const manifest = await checkPluginTree(resolve(pluginDir), errors, allowMcp);
  let cases;
  let results;
  try { cases = JSON.parse(await readFile(join(evaluationsDir, 'cases.json'), 'utf8')); }
  catch { errors.push('evaluations/cases.json must be valid UTF-8 JSON.'); }
  try { results = JSON.parse(await readFile(join(evaluationsDir, 'results.template.json'), 'utf8')); }
  catch { errors.push('evaluations/results.template.json must be valid UTF-8 JSON.'); }
  validateEvaluations(cases, results, errors);
  try {
    const readme = (await readFile(join(evaluationsDir, 'README.md'), 'utf8')).toLowerCase();
    for (const term of ['untagged', 'tagged', 'pending', 'tool call']) if (!readme.includes(term)) errors.push(`Evaluation README must explain ${term} observations.`);
  } catch { errors.push('evaluations/README.md is required.'); }
  return errors;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const errors = await checkPlugin();
  if (errors.length) { errors.forEach(error => console.error(`- ${error}`)); process.exitCode = 1; }
  else console.log('Plugin package source and evaluation artifacts are valid.');
}
