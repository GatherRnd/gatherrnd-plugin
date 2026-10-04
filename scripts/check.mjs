#!/usr/bin/env node
/**
 * The rules one plugin folder keeps so it can go to both directories: Claude's
 * (claude.ai/directory/manage, from `.claude-plugin/plugin.json` and
 * `.mcp.json`) and OpenAI's plugin directory (a ZIP of the Agent Plugins
 * `plugin.json` and `mcp.json`). The two manifests describe one plugin, so
 * what they share must not drift; each directory's own limits are checked
 * here so a submission does not find them first.
 *
 *   node scripts/check.mjs [--base <git ref>]
 *
 * Prints each problem and exits 1 if there are any. `--base` is the ref a pull
 * request merges into: a change to the plugin folder must raise its version.
 * Zero dependencies, Node 22. `scripts/check.test.mjs` holds the rules.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PLUGIN_DIR = 'plugins/gatherrnd';
export const CONNECTOR_URL = 'https://mcp.gatherrnd.app/mcp';

/** What the two manifests share, and so must say the same. */
const SHARED_FIELDS = [
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
];

/** OpenAI's categories (developers.openai.com/plugins/deploy/submission-errors). */
const OPENAI_CATEGORIES = [
  'Productivity',
  'Creativity',
  'Developer Tools',
  'Business & Operations',
  'Data & Analytics',
  'Communication',
  'Education & Research',
  'Security',
  'Finance',
  'Healthcare',
  'Travel',
  'Entertainment',
  'Other',
];

/** Files a directory upload refuses, wherever they sit. */
const SYSTEM_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const IMAGE = /\.(png|jpe?g|webp|svg)$/i;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 512;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Every file under `dir`, as paths relative to it; symlinks are reported, not followed. */
function walk(dir, base = dir, out = { files: [], links: [], dirs: [] }) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    const rel = relative(base, path);
    if (stat.isSymbolicLink()) out.links.push(rel);
    else if (stat.isDirectory()) {
      out.dirs.push(rel);
      walk(path, base, out);
    } else out.files.push(rel);
  }
  return out;
}

/** Words outside fenced code blocks. */
export function proseWords(markdown) {
  const prose = markdown.replace(/^```[\s\S]*?^```/gm, ' ');
  return prose.split(/\s+/).filter((word) => /[A-Za-z]/.test(word)).length;
}

/** A PNG's width and height from its header, or null if it is not a PNG. */
export function pngSize(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== signature) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** WCAG contrast ratio of a #RRGGBB colour against white. */
export function contrastWithWhite(hex) {
  const channel = (i) => {
    const value = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return 1.05 / (luminance + 0.05);
}

/** The one server a manifest declares, or a problem. */
function onlyServer(config, file, type, problems) {
  const servers = Object.entries(config?.mcpServers ?? {});
  if (servers.length !== 1) {
    problems.push(`${file}: declare exactly one MCP server (found ${servers.length})`);
    return null;
  }
  const [name, server] = servers[0];
  if (server.type !== type) problems.push(`${file}: server "${name}" must have type "${type}"`);
  if (server.url !== CONNECTOR_URL) {
    problems.push(`${file}: server "${name}" must point at ${CONNECTOR_URL}`);
  }
  if (server.headers !== undefined) problems.push(`${file}: server "${name}" must send no headers`);
  return name;
}

/** Keys anywhere in a value, for the keys a ZIP must never carry. */
function keysIn(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => keysIn(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      found.add(key);
      keysIn(inner, found);
    }
  }
  return found;
}

/** `major.minor.patch` as numbers, or null. */
function semver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  return match ? match.slice(1).map(Number) : null;
}

function rises(from, to) {
  const [a, b] = [semver(from), semver(to)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return b[i] > a[i];
  return false;
}

/** The manifest at `ref`, or null when the plugin folder is not there yet. */
function manifestAt(root, ref, path) {
  try {
    return JSON.parse(
      execFileSync('git', ['show', `${ref}:${path}`], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
}

function changedSince(root, ref, path) {
  const out = execFileSync('git', ['diff', '--name-only', `${ref}...HEAD`, '--', path], {
    cwd: root,
    encoding: 'utf8',
  });
  return out.trim().length > 0;
}

/**
 * Every problem with the plugin folder under `root`, in words a reviewer can
 * act on. Empty when it keeps every rule.
 */
export function checkPlugin(root, { base } = {}) {
  const problems = [];
  const dir = join(root, PLUGIN_DIR);
  const at = (path) => join(dir, path);
  const need = (path) => {
    if (existsSync(at(path))) return true;
    problems.push(`${PLUGIN_DIR}/${path} is missing`);
    return false;
  };
  if (!existsSync(dir)) return [`${PLUGIN_DIR} is missing`];

  // 1. One identity: what both manifests say, they say the same.
  const claude = need('.claude-plugin/plugin.json')
    ? readJson(at('.claude-plugin/plugin.json'))
    : null;
  const agent = need('plugin.json') ? readJson(at('plugin.json')) : null;
  if (claude && agent) {
    for (const field of SHARED_FIELDS) {
      if (JSON.stringify(claude[field]) !== JSON.stringify(agent[field])) {
        problems.push(`${field} differs between plugin.json and .claude-plugin/plugin.json`);
      }
    }
  }

  // 2. One connector: Claude's http, OpenAI's streamable-http, same name and URL.
  const claudeServer = need('.mcp.json')
    ? onlyServer(readJson(at('.mcp.json')), '.mcp.json', 'http', problems)
    : null;
  const agentServer = need('mcp.json')
    ? onlyServer(readJson(at('mcp.json')), 'mcp.json', 'streamable-http', problems)
    : null;
  if (claudeServer && agentServer && claudeServer !== agentServer) {
    problems.push(`the server is "${claudeServer}" in .mcp.json and "${agentServer}" in mcp.json`);
  }

  // 3. A change ships under a new version, in both manifests.
  if (base && claude && agent && changedSince(root, base, PLUGIN_DIR)) {
    const before = manifestAt(root, base, `${PLUGIN_DIR}/plugin.json`);
    if (before && !rises(before.version, agent.version)) {
      problems.push(
        `the plugin changed since ${base}, so its version must rise above ${before.version}`,
      );
    }
  }

  // 4. Only files a directory upload accepts.
  const tree = walk(dir);
  for (const link of tree.links) problems.push(`${link}: no symlinks`);
  for (const sub of tree.dirs) {
    if (sub.split('/').includes('__MACOSX')) problems.push(`${sub}: no __MACOSX folders`);
    if (sub === 'hooks') problems.push('hooks/: OpenAI refuses plugins with hooks');
  }
  if (tree.files.length > MAX_FILES) {
    problems.push(`${tree.files.length} files; the limit is ${MAX_FILES}`);
  }
  for (const file of tree.files) {
    const name = file.split('/').at(-1);
    if (SYSTEM_FILES.has(name)) problems.push(`${file}: a system file`);
    if (name.endsWith('.zip')) problems.push(`${file}: no archives inside the plugin`);
    if (name.endsWith('.app.json')) problems.push(`${file}: OpenAI refuses .app.json files`);
    const size = lstatSync(at(file)).size;
    if (!IMAGE.test(name) && size > MAX_TEXT_BYTES) {
      problems.push(`${file}: ${size} bytes; text files stay under ${MAX_TEXT_BYTES}`);
    }
  }

  // 5. A README a listing can be read from.
  if (need('README.md') && proseWords(readFileSync(at('README.md'), 'utf8')) < 40) {
    problems.push('README.md: at least 40 words outside code blocks');
  }

  // 6. Skills: a folder per skill, named as its front matter says.
  const skills = existsSync(at('skills')) ? readdirSync(at('skills')) : [];
  const skillText = [];
  for (const skill of skills) {
    const path = at(`skills/${skill}/SKILL.md`);
    if (!existsSync(path)) {
      problems.push(`skills/${skill}: no SKILL.md`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    skillText.push(text);
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
    const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim();
    const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim();
    if (name !== skill) problems.push(`skills/${skill}: front matter name must be "${skill}"`);
    if (!description) problems.push(`skills/${skill}: front matter needs a description`);
    else if (description.length > 1024) {
      problems.push(`skills/${skill}: description over 1,024 characters`);
    }
  }

  // 7. The skills name only tools the connector has, and the contract lists only tools they use.
  const contractPath = join(root, 'contract/tools.json');
  if (!existsSync(contractPath)) problems.push('contract/tools.json is missing');
  else {
    const contract = new Set(readJson(contractPath).tools);
    const named = new Set(
      skillText.flatMap((text) =>
        [...text.matchAll(/`([a-z]+(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]),
      ),
    );
    for (const tool of named) {
      if (!contract.has(tool))
        problems.push(`a skill names \`${tool}\`, which contract/tools.json does not list`);
    }
    for (const tool of contract) {
      if (!named.has(tool))
        problems.push(`contract/tools.json lists ${tool}, which no skill names`);
    }
  }

  // 8. OpenAI's listing limits, for the fields that are there.
  const openai = agent?.extensions?.['com.openai'];
  if (agent && (agent.description ?? '').length > 1024) {
    problems.push('plugin.json: description over 1,024 characters');
  }
  if (openai) {
    const ui = openai.interface ?? {};
    const limit = (field, max) => {
      if (ui[field] !== undefined && String(ui[field]).length > max) {
        problems.push(`interface.${field}: at most ${max} characters`);
      }
    };
    limit('displayName', 30);
    limit('shortDescription', 30);
    limit('longDescription', 4000);
    limit('developerName', 80);
    if (ui.category !== undefined && !OPENAI_CATEGORIES.includes(ui.category)) {
      problems.push(`interface.category "${ui.category}" is not one of OpenAI's categories`);
    }
    for (const field of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
      if (ui[field] !== undefined && !/^https:\/\//.test(ui[field])) {
        problems.push(`interface.${field}: an https:// URL`);
      }
    }
    if (ui.brandColor !== undefined) {
      if (!/^#[0-9A-Fa-f]{6}$/.test(ui.brandColor)) problems.push('interface.brandColor: #RRGGBB');
      else if (contrastWithWhite(ui.brandColor) < 2) {
        problems.push('interface.brandColor: needs at least 2:1 contrast against white');
      }
    }
    const prompts = ui.defaultPrompt ?? [];
    if (prompts.length > 3 || new Set(prompts).size !== prompts.length) {
      problems.push('interface.defaultPrompt: at most 3, all different');
    }
    for (const prompt of prompts) {
      if (prompt.length > 128 || prompt.includes('@') || prompt.includes('\n')) {
        problems.push(
          `interface.defaultPrompt "${prompt}": one line, at most 128 characters, no @`,
        );
      }
    }
    const capabilities = ui.capabilities ?? [];
    if (capabilities.length > 20 || capabilities.some((c) => c.length > 120)) {
      problems.push('interface.capabilities: at most 20, each at most 120 characters');
    }
    for (const key of ['test_credentials', 'reviewer_instructions']) {
      if (keysIn(agent).has(key)) {
        problems.push(`plugin.json: ${key} goes in OpenAI's dashboard, never in the package`);
      }
    }
  }

  // 9. Every icon a manifest points at: there, square, 48 to 4,096 px, at most 5 MiB.
  const icons = [
    ['.claude-plugin/plugin.json icon', claude?.icon],
    ['interface.logo', openai?.interface?.logo],
    ['interface.composerIcon', openai?.interface?.composerIcon],
  ].filter(([, path]) => path !== undefined);
  for (const [field, path] of icons) {
    if (!/^\.\//.test(path)) {
      problems.push(`${field}: a ./ path inside the plugin`);
      continue;
    }
    if (!existsSync(at(path))) {
      problems.push(`${field}: ${path} is missing`);
      continue;
    }
    const bytes = readFileSync(at(path));
    const size = pngSize(bytes);
    if (!size) problems.push(`${field}: ${path} must be a PNG`);
    else if (size.width !== size.height) problems.push(`${field}: ${path} must be square`);
    else if (size.width < 48 || size.width > 4096) {
      problems.push(`${field}: ${path} must be 48 to 4,096 px`);
    }
    if (bytes.length > MAX_IMAGE_BYTES) problems.push(`${field}: ${path} over 5 MiB`);
  }

  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const baseAt = args.indexOf('--base');
  const base = baseAt >= 0 ? args[baseAt + 1] : undefined;
  const problems = checkPlugin(process.cwd(), { base });
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`✓ ${PLUGIN_DIR} keeps every rule`);
}
