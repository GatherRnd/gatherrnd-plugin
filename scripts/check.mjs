#!/usr/bin/env node
/**
 * The rules one plugin folder keeps so it can go to both directories later:
 * Claude's (claude.ai/directory/manage, from `.claude-plugin/plugin.json` and
 * `.mcp.json`) and OpenAI's plugin directory (the Agent Plugins `plugin.json`
 * and `mcp.json`). The two manifests describe one plugin, so what they share
 * must not drift, and each directory's own file limits are checked here.
 *
 *   node scripts/check.mjs [--base <git ref>] [--submission]
 *
 * Prints each problem and exits 1 if there are any. `--base` is the ref a pull
 * request merges into: a change to the plugin folder must raise its version.
 * `--submission` adds what a directory submission needs on top: OpenAI's
 * required listing fields. Nothing here builds or uploads a
 * package. Zero dependencies, Node 22. `scripts/check.test.mjs` holds the rules.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_DIR = 'plugins/gatherrnd';
export const CONNECTOR_URL = 'https://mcp.gatherrnd.app/mcp';

/** What the two manifests share by name, and so must say the same. */
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

/** Claude's listing fields and OpenAI's `interface` fields that say the same thing. */
const LISTING_PAIRS = [
  ['displayName', 'displayName'],
  ['homepage', 'websiteURL'],
  ['supportUrl', 'supportURL'],
  ['privacyPolicyUrl', 'privacyPolicyURL'],
  ['termsOfServiceUrl', 'termsOfServiceURL'],
  ['icon', 'logo'],
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

/** The connector's tool areas: a backticked snake_case word starting with one is a tool. */
const TOOL_AREAS = [
  'asks',
  'calendar',
  'calendars',
  'circle',
  'circles',
  'events',
  'features',
  'gathering',
  'karma',
  'me',
  'members',
  'reactions',
  'repeats',
  'stickies',
  'time',
  'week',
];

/** Files a directory upload refuses, wherever they sit. */
const SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const IMAGE_OR_FONT = /\.(png|jpe?g|gif|webp|svg|woff2?|ttf|otf)$/i;
const HELD_BINARIES = /\.(pdf|ico|exe|dll|so|dylib|bin|mcpb|dxt|jar|wasm)$/i;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_FILES = 512;
const MAX_URL = 1024;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Equal as JSON values, whatever order an object's keys were written in. */
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => sameValue(a[key], b[key]));
}

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

/** A PNG's width and height from its IHDR chunk, or null if it is not a PNG. */
export function pngSize(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== signature) return null;
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** WCAG contrast ratio between two #RRGGBB colours. */
export function contrast(first, second) {
  const luminance = (hex) => {
    const channel = (i) => {
      const value = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  };
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** A skill's front matter as name and description, or the reason it can't be read. */
export function frontMatter(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (block === undefined) return { error: 'no front matter' };
  const value = (key) => {
    const raw = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(block)?.[1]?.trim();
    if (raw === undefined || raw === '') return undefined;
    if (/^[>|][+-]?$/.test(raw)) return { block: true };
    return raw.replace(/^(['"])(.*)\1$/, '$2');
  };
  return { name: value('name'), description: value('description') };
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

/** Keys anywhere in a value, for the keys a package must never carry. */
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

/** `major.minor.patch`, with an optional prerelease, as comparable parts; null if not semver. */
function semver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version ?? '');
  return match ? { core: match.slice(1, 4).map(Number), pre: match[4] ?? null } : null;
}

/** Whether `to` is a later version than `from`; a prerelease comes before its release. */
export function rises(from, to) {
  const [a, b] = [semver(from), semver(to)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a.core[i] !== b.core[i]) return b.core[i] > a.core[i];
  if (a.pre === b.pre) return false;
  if (b.pre === null) return true;
  if (a.pre === null) return false;
  return b.pre.localeCompare(a.pre, 'en', { numeric: true }) > 0;
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

/** Whether `path` changed between `ref` and the working tree, or null if `ref` can't be read. */
function changedSince(root, ref, path) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', ref, '--', path], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', path], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0 || untracked.trim().length > 0;
  } catch {
    return null;
  }
}

/**
 * Every problem with the plugin folder under `root`, in words a reviewer can
 * act on. Empty when it keeps every rule.
 */
export function checkPlugin(root, { base, submission = false } = {}) {
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
  const ui = agent?.extensions?.['com.openai']?.interface;
  if (claude && agent) {
    for (const field of SHARED_FIELDS) {
      if (!sameValue(claude[field], agent[field])) {
        problems.push(`${field} differs between plugin.json and .claude-plugin/plugin.json`);
      }
    }
    for (const [claudeField, openaiField] of LISTING_PAIRS) {
      const theirs = claude[claudeField];
      if (theirs !== undefined && ui?.[openaiField] !== undefined && theirs !== ui[openaiField]) {
        problems.push(
          `.claude-plugin/plugin.json ${claudeField} and interface.${openaiField} must say the same`,
        );
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
  if (base !== undefined && claude && agent) {
    const changed = changedSince(root, base, PLUGIN_DIR);
    if (changed === null) {
      problems.push(`cannot compare with ${base}: fetch it first (git fetch origin)`);
    } else if (changed) {
      const before = manifestAt(root, base, `${PLUGIN_DIR}/plugin.json`);
      if (before && !rises(before.version, agent.version)) {
        problems.push(
          `the plugin changed since ${base}, so its version must rise above ${before.version}`,
        );
      }
    }
  }

  // 4. Only files a directory upload accepts.
  const tree = walk(dir);
  for (const link of tree.links) problems.push(`${link}: no symlinks`);
  for (const sub of tree.dirs) {
    if (sub.split('/').includes('__MACOSX')) problems.push(`${sub}: no __MACOSX folders`);
    if (sub === 'hooks')
      problems.push('hooks/: this plugin runs no code, and ChatGPT runs no hooks');
  }
  if (claude?.hooks !== undefined) {
    problems.push('.claude-plugin/plugin.json: no hooks; this plugin runs no code');
  }
  if (tree.files.length > MAX_FILES) {
    problems.push(`${tree.files.length} files; the limit is ${MAX_FILES}`);
  }
  const seen = new Map();
  for (const file of tree.files) {
    const lower = file.toLowerCase();
    const name = lower.split('/').at(-1);
    if (seen.has(lower)) problems.push(`${file} and ${seen.get(lower)} differ only in case`);
    seen.set(lower, file);
    if (SYSTEM_FILES.has(name)) problems.push(`${file}: a system file`);
    if (name.endsWith('.zip')) problems.push(`${file}: no archives inside the plugin`);
    if (name.endsWith('.app.json')) {
      problems.push(`${file}: the connector is declared in mcp.json, never an .app.json`);
    }
    if (HELD_BINARIES.test(name)) {
      problems.push(`${file}: only text, images and fonts; a directory holds other binaries`);
    }
    const size = lstatSync(at(file)).size;
    if (size >= MAX_FILE_BYTES)
      problems.push(`${file}: ${size} bytes; every file stays under 5 MiB`);
    else if (!IMAGE_OR_FONT.test(name) && size >= MAX_TEXT_BYTES) {
      problems.push(`${file}: ${size} bytes; text files stay under 256 KiB`);
    }
  }

  // 5. A README a listing can be read from.
  if (need('README.md') && proseWords(readFileSync(at('README.md'), 'utf8')) < 40) {
    problems.push('README.md: at least 40 words outside code blocks');
  }

  // 6. Skills: a folder per skill, named as its front matter says, described on one line.
  const skills = existsSync(at('skills')) ? readdirSync(at('skills')) : [];
  const skillDocs = [];
  for (const skill of skills) {
    const path = at(`skills/${skill}/SKILL.md`);
    if (!existsSync(path)) {
      problems.push(`skills/${skill}: no SKILL.md`);
      continue;
    }
    const front = frontMatter(readFileSync(path, 'utf8'));
    if (front.error) {
      problems.push(`skills/${skill}: ${front.error}`);
      continue;
    }
    if (front.name !== skill)
      problems.push(`skills/${skill}: front matter name must be "${skill}"`);
    if (front.description === undefined) {
      problems.push(`skills/${skill}: front matter needs a description`);
    } else if (typeof front.description !== 'string') {
      problems.push(`skills/${skill}: write the description on one line`);
    } else if (front.description.length > 1024) {
      problems.push(`skills/${skill}: description over 1,024 characters`);
    }
    if (`${agent?.name ?? claude?.name ?? ''}:${skill}`.length > 64) {
      problems.push(`skills/${skill}: plugin and skill name together over 64 characters`);
    }
  }
  if (existsSync(at('skills'))) {
    for (const file of walk(at('skills')).files) {
      if (file.toLowerCase().endsWith('.md'))
        skillDocs.push(readFileSync(at(`skills/${file}`), 'utf8'));
    }
  }

  // 7. The skills name only tools in the contract, and the contract only tools they name.
  const contractPath = join(root, 'contract/tools.json');
  if (!existsSync(contractPath)) problems.push('contract/tools.json is missing');
  else {
    const contract = new Set(readJson(contractPath).tools);
    const tool = /`(?:mcp__\w+__)?([a-z]+(?:_[a-z0-9]+)+)(?:\(\))?`/g;
    const named = new Set(
      skillDocs
        .flatMap((text) => [...text.matchAll(tool)].map((m) => m[1]))
        .filter((name) => TOOL_AREAS.includes(name.split('_')[0])),
    );
    for (const name of named) {
      if (!contract.has(name)) {
        problems.push(`a skill names \`${name}\`, which contract/tools.json does not list`);
      }
    }
    for (const name of contract) {
      if (!named.has(name))
        problems.push(`contract/tools.json lists ${name}, which no skill names`);
    }
  }

  // 8. OpenAI's listing limits, for the fields that are there; never reviewer credentials.
  if (agent) {
    if ((agent.description ?? '').length > 1024) {
      problems.push('plugin.json: description over 1,024 characters');
    }
    for (const key of ['test_credentials', 'reviewer_instructions']) {
      if (keysIn(agent).has(key)) {
        problems.push(`plugin.json: ${key} goes in OpenAI's dashboard, never in the package`);
      }
    }
  }
  if (ui) {
    const limit = (field, max) => {
      if (ui[field] !== undefined && String(ui[field]).length > max) {
        problems.push(`interface.${field}: at most ${max} characters`);
      }
    };
    limit('displayName', 30);
    limit('shortDescription', 30);
    limit('longDescription', 4000);
    limit('developerName', 80);
    if (/\n/.test(ui.shortDescription ?? '')) problems.push('interface.shortDescription: one line');
    if (ui.category !== undefined && !OPENAI_CATEGORIES.includes(ui.category)) {
      problems.push(`interface.category "${ui.category}" is not one of OpenAI's categories`);
    }
    for (const field of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
      if (ui[field] === undefined) continue;
      if (!/^https:\/\//.test(ui[field])) problems.push(`interface.${field}: an https:// URL`);
      if (ui[field].length > MAX_URL)
        problems.push(`interface.${field}: at most ${MAX_URL} characters`);
    }
    for (const [field, against, label] of [
      ['brandColor', '#FFFFFF', 'white'],
      ['brandColorDark', '#212121', '#212121'],
    ]) {
      if (ui[field] === undefined) continue;
      if (!/^#[0-9A-Fa-f]{6}$/.test(ui[field])) problems.push(`interface.${field}: #RRGGBB`);
      else if (contrast(ui[field], against) < 2) {
        problems.push(`interface.${field}: needs at least 2:1 contrast against ${label}`);
      }
    }
    const prompts = [ui.defaultPrompt ?? []].flat();
    if (prompts.length > 3 || new Set(prompts).size !== prompts.length) {
      problems.push('interface.defaultPrompt: at most 3, all different');
    }
    for (const prompt of prompts) {
      if (typeof prompt !== 'string' || prompt.length > 128 || /[@\n]/.test(prompt)) {
        problems.push(
          `interface.defaultPrompt "${prompt}": one line, at most 128 characters, no @`,
        );
      }
    }
    const capabilities = ui.capabilities ?? [];
    if (
      !Array.isArray(capabilities) ||
      capabilities.length > 20 ||
      capabilities.some((c) => typeof c !== 'string' || c.length > 120)
    ) {
      problems.push('interface.capabilities: a list of at most 20, each at most 120 characters');
    }
  }

  // 9. Every icon a manifest points at: inside the plugin, square, 48 to 4,096 px.
  const icons = [
    ['.claude-plugin/plugin.json icon', claude?.icon],
    ['interface.logo', ui?.logo],
    ['interface.composerIcon', ui?.composerIcon],
  ].filter(([, path]) => path !== undefined);
  for (const [field, path] of icons) {
    const inside = relative(dir, resolve(dir, path));
    if (!/^\.\//.test(path) || inside.startsWith('..') || isAbsolute(inside)) {
      problems.push(`${field}: a ./ path that stays inside the plugin`);
      continue;
    }
    if (!existsSync(at(path))) {
      problems.push(`${field}: ${path} is missing`);
      continue;
    }
    if (!/\.png$/i.test(path)) continue; // other formats: only the file-size rule above
    const size = pngSize(readFileSync(at(path)));
    if (!size) problems.push(`${field}: ${path} is not a readable PNG`);
    else if (size.width !== size.height) problems.push(`${field}: ${path} must be square`);
    else if (size.width < 48 || size.width > 4096) {
      problems.push(`${field}: ${path} must be 48 to 4,096 px`);
    }
  }

  // 10. A licence, in both manifests and as a file in the plugin folder, the same
  //     text as the repository's own (Matt, 2026-10-04: MIT). Claude's directory
  //     requires one, and an install carries only the plugin folder.
  if (claude && agent && claude.license === undefined) {
    problems.push('license: set it in both manifests');
  }
  if (!existsSync(at('LICENSE'))) problems.push(`${PLUGIN_DIR}/LICENSE is missing`);
  else if (
    existsSync(join(root, 'LICENSE')) &&
    readFileSync(join(root, 'LICENSE'), 'utf8') !== readFileSync(at('LICENSE'), 'utf8')
  ) {
    problems.push(`LICENSE and ${PLUGIN_DIR}/LICENSE must be the same text`);
  }

  // 11. At submission: what OpenAI's directory needs that day-to-day work does not.
  if (submission) {
    for (const field of ['longDescription', 'developerName', 'termsOfServiceURL', 'logo']) {
      if (ui?.[field] === undefined) problems.push(`interface.${field}: OpenAI requires it`);
    }
  }

  return problems;
}

const invoked =
  process.argv[1] !== undefined &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  const baseAt = args.indexOf('--base');
  const base = baseAt >= 0 ? args[baseAt + 1] : undefined;
  if (baseAt >= 0 && (base === undefined || base.startsWith('--'))) {
    console.error('--base needs a git ref, e.g. --base origin/main');
    process.exitCode = 2;
  } else {
    const problems = checkPlugin(process.cwd(), {
      base,
      submission: args.includes('--submission'),
    });
    for (const problem of problems) console.error(`✗ ${problem}`);
    if (problems.length > 0) process.exitCode = 1;
    else
      console.log(
        `✓ ${PLUGIN_DIR} keeps every rule${args.includes('--submission') ? ', submission included' : ''}`,
      );
  }
}
