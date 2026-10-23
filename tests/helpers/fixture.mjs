/**
 * Test fixture: a small Obsidian vault on disk.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Write a set of `relativePath -> content` files under a fresh temp directory. */
export async function makeVault(files) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-obsidian-'))
  for (const [relative, content] of Object.entries(files)) {
    const abs = path.join(root, relative)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content, 'utf8')
  }
  return root
}

/** Remove a fixture directory. */
export async function removeVault(root) {
  await fsp.rm(root, { recursive: true, force: true })
}

/** A vault with frontmatter, tags, wikilinks, a daily note, and hidden folders. */
export const SAMPLE_FILES = {
  'Welcome.md': [
    '---',
    'title: Welcome Home',
    'tags:',
    '  - start',
    '  - meta',
    'aliases: [Home, Index]',
    'status: active',
    '---',
    '',
    '# Welcome',
    '',
    'This is the vault entry point. It mentions alpha once.',
    '',
    'Link to [[Projects/Alpha]] and [[Beta|the beta note]].',
    '',
    '#inline-tag here.',
    '',
    '## Details',
    '',
    'More details about the project.',
    '',
  ].join('\n'),
  'Projects/Alpha.md': [
    '---',
    'tags: [project, alpha]',
    'status: active',
    '---',
    '',
    '# Alpha',
    '',
    'Alpha project notes.',
    '',
    'See [[Welcome]] and [[Missing Note]].',
    '',
    '## Tasks',
    '',
    '- [ ] task one',
    '',
  ].join('\n'),
  'Projects/Beta.md': [
    '---',
    'tags: [project, beta]',
    'status: done',
    '---',
    '',
    '# Beta',
    '',
    'Beta project notes referencing [[Alpha]].',
    '',
  ].join('\n'),
  'Daily/2026-10-10.md': '# Daily 2026-10-10\n\nStandup notes.\n',
  'notes/plain.txt': 'plain text note about alpha\n',
  '.obsidian/app.json': '{"attachmentFolderPath":"attachments"}\n',
  '.obsidian/daily-notes.json': '{"folder":"Daily","format":"YYYY-MM-DD"}\n',
  '.trash/Deleted.md': '# Deleted\n\nshould never be indexed\n',
}

/** The Local REST API `data.json` fixture used by the discovery tests. */
export const REST_DATA_FIXTURE = JSON.stringify({
  port: 27124,
  insecurePort: 27123,
  enableInsecureServer: true,
  apiKey: 'test-key-0123456789',
})

/**
 * A discovery fixture on ports nothing listens on, so tests that assert the
 * "bridge unavailable" path cannot accidentally reach a real Obsidian instance.
 */
export const REST_DATA_FIXTURE_OFFLINE = JSON.stringify({
  port: 27924,
  insecurePort: 27923,
  enableInsecureServer: true,
  apiKey: 'offline-test-key',
})
