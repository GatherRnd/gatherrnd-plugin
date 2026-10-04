import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkPlugin, contrastWithWhite, pngSize, proseWords, PLUGIN_DIR } from './check.mjs';

const REPO = join(import.meta.dirname, '..');

/** A copy of this repository's plugin and contract, to break one rule at a time. */
function copy() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-check-'));
  cpSync(join(REPO, PLUGIN_DIR), join(root, PLUGIN_DIR), { recursive: true });
  cpSync(join(REPO, 'contract'), join(root, 'contract'), { recursive: true });
  return root;
}

const edit = (root, path, change) => {
  const file = join(root, PLUGIN_DIR, path);
  writeFileSync(file, change(readFileSync(file, 'utf8')));
};
const editJson = (root, path, change) =>
  edit(root, path, (text) => JSON.stringify(change(JSON.parse(text)), null, 2));

/** The problems with one rule broken, for a test to look for its own. */
function broken(change) {
  const root = copy();
  try {
    change(root);
    return checkPlugin(root).join('\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the real plugin folder keeps every rule', () => {
  assert.deepEqual(checkPlugin(REPO), []);
});

test('1. the two manifests say the same name, version, description and the rest', () => {
  const problems = broken((root) =>
    editJson(root, 'plugin.json', (manifest) => ({ ...manifest, version: '9.9.9' })),
  );
  assert.match(problems, /version differs between plugin.json and .claude-plugin\/plugin.json/);
});

test('2. one connector: http for Claude, streamable-http for OpenAI, at the same URL', () => {
  assert.match(
    broken((root) =>
      editJson(root, 'mcp.json', (config) => ({
        ...config,
        mcpServers: { gatherrnd: { type: 'http', url: 'https://mcp.gatherrnd.app/mcp' } },
      })),
    ),
    /mcp.json: server "gatherrnd" must have type "streamable-http"/,
  );
  assert.match(
    broken((root) =>
      editJson(root, '.mcp.json', (config) => ({
        mcpServers: {
          gatherrnd: { ...config.mcpServers.gatherrnd, url: 'https://example.com/mcp' },
        },
      })),
    ),
    /\.mcp\.json: server "gatherrnd" must point at https:\/\/mcp\.gatherrnd\.app\/mcp/,
  );
  assert.match(
    broken((root) =>
      editJson(root, 'mcp.json', (config) => ({
        ...config,
        mcpServers: { other: config.mcpServers.gatherrnd },
      })),
    ),
    /the server is "gatherrnd" in \.mcp\.json and "other" in mcp\.json/,
  );
});

test('3. a change to the plugin ships under a higher version', () => {
  const root = copy();
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    git('checkout', '-q', '-b', 'change');
    edit(root, 'README.md', (text) => `${text}\nOne more line.\n`);
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'change');
    assert.match(
      checkPlugin(root, { base: 'main' }).join('\n'),
      /its version must rise above 0\.2\.0/,
    );
    for (const path of ['plugin.json', '.claude-plugin/plugin.json']) {
      editJson(root, path, (manifest) => ({ ...manifest, version: '0.2.1' }));
    }
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'bump');
    assert.deepEqual(checkPlugin(root, { base: 'main' }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('4. only files a directory upload accepts', () => {
  assert.match(
    broken((root) => writeFileSync(join(root, PLUGIN_DIR, 'skills/.DS_Store'), '')),
    /skills\/\.DS_Store: a system file/,
  );
  assert.match(
    broken((root) => symlinkSync('README.md', join(root, PLUGIN_DIR, 'link.md'))),
    /link\.md: no symlinks/,
  );
  assert.match(
    broken((root) => writeFileSync(join(root, PLUGIN_DIR, 'notes.md'), 'x'.repeat(300 * 1024))),
    /notes\.md: \d+ bytes/,
  );
});

test('5. a README of at least 40 words outside code blocks', () => {
  assert.equal(proseWords('one two\n```\nthree four five\n```\nsix'), 3);
  assert.match(
    broken((root) =>
      edit(root, 'README.md', () => '# Gather Rnd\n\n```\nlots of code here\n```\n'),
    ),
    /README\.md: at least 40 words outside code blocks/,
  );
});

test('6. each skill’s front matter names its folder and describes it', () => {
  assert.match(
    broken((root) =>
      edit(root, 'skills/make-asks/SKILL.md', (text) =>
        text.replace('name: make-asks', 'name: asks'),
      ),
    ),
    /skills\/make-asks: front matter name must be "make-asks"/,
  );
});

test('7. the skills name only tools in the contract, and the contract only tools they name', () => {
  assert.match(
    broken((root) =>
      edit(root, 'skills/make-asks/SKILL.md', (text) => `${text}\nAlso \`asks_frobnicate\`.\n`),
    ),
    /a skill names `asks_frobnicate`, which contract\/tools\.json does not list/,
  );
  assert.match(
    broken((root) => {
      const path = join(root, 'contract/tools.json');
      const contract = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(
        path,
        JSON.stringify({ ...contract, tools: [...contract.tools, 'week_unclose'] }),
      );
    }),
    /contract\/tools\.json lists week_unclose, which no skill names/,
  );
});

test('8. OpenAI’s listing limits, and no reviewer credentials in the package', () => {
  const ui = (change) =>
    broken((root) =>
      editJson(root, 'plugin.json', (manifest) => {
        const openai = manifest.extensions['com.openai'];
        return {
          ...manifest,
          extensions: {
            'com.openai': {
              ...openai,
              interface: change(openai.interface),
              ...(change.extra ?? {}),
            },
          },
        };
      }),
    );
  assert.match(
    ui((i) => ({ ...i, shortDescription: 'x'.repeat(31) })),
    /interface\.shortDescription: at most 30 characters/,
  );
  assert.match(
    ui((i) => ({ ...i, category: 'Family' })),
    /interface\.category "Family"/,
  );
  assert.match(
    ui((i) => ({ ...i, brandColor: '#EEEEEE' })),
    /at least 2:1 contrast against white/,
  );
  assert.match(
    ui((i) => ({ ...i, defaultPrompt: ['Ask @Kai', 'a', 'b', 'c'] })),
    /interface\.defaultPrompt: at most 3/,
  );
  const credentials = (i) => i;
  credentials.extra = { review: { test_credentials: { login: 'x' } } };
  assert.match(ui(credentials), /test_credentials goes in OpenAI's dashboard/);
  assert.ok(contrastWithWhite('#2F5A52') >= 2);
});

test('9. every icon is there, a square PNG of 48 to 4,096 px', () => {
  const tiny = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000280000002808060000000000000000',
    'hex',
  );
  assert.deepEqual(pngSize(tiny), { width: 40, height: 40 });
  assert.match(
    broken((root) => writeFileSync(join(root, PLUGIN_DIR, 'assets/composer-icon.png'), tiny)),
    /interface\.composerIcon: \.\/assets\/composer-icon\.png must be 48 to 4,096 px/,
  );
  assert.match(
    broken((root) =>
      editJson(root, '.claude-plugin/plugin.json', (manifest) => ({
        ...manifest,
        icon: 'assets/logo.png',
      })),
    ),
    /\.claude-plugin\/plugin\.json icon: a \.\/ path inside the plugin/,
  );
});
