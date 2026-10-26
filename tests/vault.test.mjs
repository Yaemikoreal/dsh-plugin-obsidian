import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ToolInputError, VaultPathError } from '../lib/util.js'
import { ObsidianVault, discoverVaults, formatDate } from '../lib/vault.js'
import { SAMPLE_FILES, makeVault, removeVault } from './helpers/fixture.mjs'

async function withVault(options, run) {
  const root = await makeVault({ ...SAMPLE_FILES, ...(options?.files ?? {}) })
  const vault = new ObsidianVault({ root, ttlMs: 0, ...(options?.vaultOptions ?? {}) })
  try {
    await run(vault, root)
  } finally {
    await removeVault(root)
  }
}

test('indexes notes and skips .obsidian, .trash, and unknown extensions', async () => {
  await withVault({}, async (vault) => {
    await vault.scan()
    assert.deepEqual([...vault.files.keys()].sort(), [
      'Daily/2026-10-10.md',
      'Projects/Alpha.md',
      'Projects/Beta.md',
      'Welcome.md',
      'notes/plain.txt',
    ])
    assert.equal(vault.stats.notes, 5)
  })
})

test('search modes: all, any, phrase, regex, tag, path, frontmatter, title', async () => {
  await withVault({}, async (vault) => {
    const all = await vault.search({ query: 'alpha' })
    const allPaths = all.matches.map((match) => match.path)
    assert.equal(all.mode, 'all')
    assert.ok(allPaths.includes('Projects/Alpha.md'))
    assert.ok(allPaths.includes('Welcome.md'))
    assert.ok(allPaths.includes('notes/plain.txt'))
    assert.ok(all.total >= 3)
    assert.ok(all.matches[0].matches.length > 0)
    assert.equal(typeof all.elapsedMs, 'number')

    const any = await vault.search({ query: 'zzzz alpha', mode: 'any' })
    assert.ok(any.total >= 3)

    const phrase = await vault.search({ query: 'vault entry point', mode: 'phrase' })
    assert.deepEqual(phrase.matches.map((match) => match.path), ['Welcome.md'])

    const regex = await vault.search({ query: 'task (one|two)', mode: 'regex' })
    assert.deepEqual(regex.matches.map((match) => match.path), ['Projects/Alpha.md'])

    const tag = await vault.search({ query: 'project', mode: 'tag' })
    assert.deepEqual(tag.matches.map((match) => match.path).sort(), ['Projects/Alpha.md', 'Projects/Beta.md'])

    const tagFiltered = await vault.search({ query: 'project', tag: 'beta' })
    assert.deepEqual(tagFiltered.matches.map((match) => match.path), ['Projects/Beta.md'])

    const requiredTags = await vault.search({ query: 'project', tags: ['alpha', 'project'] })
    assert.deepEqual(requiredTags.matches.map((match) => match.path), ['Projects/Alpha.md'])

    const byPath = await vault.search({ query: 'Projects/*.md', mode: 'path' })
    assert.deepEqual(byPath.matches.map((match) => match.path).sort(), ['Projects/Alpha.md', 'Projects/Beta.md'])

    const byFrontmatter = await vault.search({ query: 'status:done', mode: 'frontmatter' })
    assert.deepEqual(byFrontmatter.matches.map((match) => match.path), ['Projects/Beta.md'])

    const byTitle = await vault.search({ query: 'Alpha', mode: 'title' })
    assert.deepEqual(byTitle.matches.map((match) => match.path), ['Projects/Alpha.md'])

    const caseSensitive = await vault.search({ query: 'ALPHA', caseSensitive: true })
    assert.equal(caseSensitive.total, 0)

    const limited = await vault.search({ query: 'alpha', limit: 1 })
    assert.equal(limited.matches.length, 1)
    assert.equal(limited.truncated, true)

    const excluded = await vault.search({ query: 'alpha', exclude: ['notes/**'] })
    assert.equal(excluded.matches.some((match) => match.path === 'notes/plain.txt'), false)

    const inFolder = await vault.search({ query: 'notes', folder: 'Projects' })
    assert.deepEqual(inFolder.matches.map((match) => match.path).sort(), ['Projects/Alpha.md', 'Projects/Beta.md'])

    const withContext = await vault.search({ query: 'Standup', context: 1 })
    assert.equal(Array.isArray(withContext.matches[0].matches[0].context), true)

    await assert.rejects(() => vault.search({ query: 'x', mode: 'regex', caseSensitive: false, limit: 1, ...{ query: '(' } }), ToolInputError)
    await assert.rejects(() => vault.search({ query: '', mode: 'all' }), ToolInputError)
  })
})

test('resolveNote accepts paths, file names, wikilinks, basenames, and aliases', async () => {
  await withVault({}, async (vault) => {
    assert.equal(await vault.resolveNote('Welcome.md'), 'Welcome.md')
    assert.equal(await vault.resolveNote('Welcome'), 'Welcome.md')
    assert.equal(await vault.resolveNote('[[Welcome]]'), 'Welcome.md')
    assert.equal(await vault.resolveNote('Home'), 'Welcome.md')
    assert.equal(await vault.resolveNote('Projects/Alpha'), 'Projects/Alpha.md')
    assert.equal(await vault.resolveNote('Alpha'), 'Projects/Alpha.md')
    assert.equal(await vault.resolveNote('Projects/Alpha.md#Tasks'), 'Projects/Alpha.md')
    assert.equal(await vault.resolveNote('Does Not Exist'), null)
    await assert.rejects(() => vault.resolveNote(''), ToolInputError)
  })
})

test('readNote returns a line window plus metadata and backlinks', async () => {
  await withVault({}, async (vault) => {
    const note = await vault.readNote({ note: 'Welcome', offset: 10, limit: 3 })
    assert.equal(note.path, 'Welcome.md')
    assert.equal(note.title, 'Welcome Home')
    assert.deepEqual(note.aliases, ['Home', 'Index'])
    assert.equal(note.totalLines, 20)
    assert.equal(note.lines[0].number, 10)
    assert.equal(note.lines[0].text, '# Welcome')
    assert.equal(note.truncated, true)
    assert.deepEqual(note.tags, ['start', 'meta', 'inline-tag'])
    assert.equal(note.frontmatter.status, 'active')
    assert.equal(note.headings.length, 2)
    assert.equal(note.links.length, 2)
    assert.equal(note.backlinks, null)

    const withBacklinks = await vault.readNote({ note: 'Alpha', backlinks: true })
    assert.deepEqual(withBacklinks.backlinks.map((entry) => entry.path).sort(), ['Projects/Beta.md', 'Welcome.md'])

    await assert.rejects(() => vault.readNote({ note: 'Nope' }), ToolInputError)
  })
})

test('links reports outgoing, incoming, and unresolved links', async () => {
  await withVault({}, async (vault) => {
    const links = await vault.links({ note: 'Alpha' })
    assert.equal(links.note, 'Projects/Alpha.md')
    assert.deepEqual(links.outgoing.map((entry) => entry.path), ['Welcome.md'])
    assert.deepEqual(links.unresolved.map((entry) => entry.target), ['Missing Note'])
    assert.deepEqual(links.incoming.map((entry) => entry.path).sort(), ['Projects/Beta.md', 'Welcome.md'])
    assert.ok(links.incoming.every((entry) => entry.line > 0))

    const outgoingOnly = await vault.links({ note: 'Alpha', direction: 'outgoing' })
    assert.deepEqual(outgoingOnly.incoming, [])
  })
})

test('list modes: tree, flat, tags, folders', async () => {
  await withVault({}, async (vault) => {
    const tree = await vault.list({ mode: 'tree', depth: 2 })
    assert.equal(tree.mode, 'tree')
    assert.equal(tree.entries[0].type, 'folder')
    assert.ok(tree.entries.some((entry) => entry.path === 'Projects/Alpha.md' && entry.depth === 2))
    assert.ok(tree.entries.some((entry) => entry.path === 'Projects' && entry.count === 2))

    const flat = await vault.list({ mode: 'flat' })
    assert.equal(flat.total, 5)
    const welcome = flat.entries.find((entry) => entry.path === 'Welcome.md')
    assert.equal(welcome.title, 'Welcome Home')
    assert.deepEqual(welcome.tags, ['start', 'meta', 'inline-tag'])

    const tags = await vault.list({ mode: 'tags' })
    const counts = Object.fromEntries(tags.entries.map((entry) => [entry.name, entry.count]))
    assert.equal(counts.project, 2)
    assert.equal(counts.alpha, 1)
    assert.equal(counts['inline-tag'], 1)

    const folders = await vault.list({ mode: 'folders' })
    const folderCounts = Object.fromEntries(folders.entries.map((entry) => [entry.path, entry.count]))
    assert.equal(folderCounts.Projects, 2)
    assert.equal(folderCounts.Daily, 1)
    assert.equal(folderCounts.notes, 1)
  })
})

test('writeNote: create, append, prepend, insert, overwrite, and ifExists', async () => {
  await withVault({}, async (vault, root) => {
    const created = await vault.writeNote({ note: 'New Note', content: '# New\n\ntext\n', mode: 'create' })
    assert.equal(created.path, 'New Note.md')
    assert.equal(created.created, true)
    assert.equal(await fsp.readFile(path.join(root, 'New Note.md'), 'utf8'), '# New\n\ntext\n')

    await assert.rejects(() => vault.writeNote({ note: 'New Note', content: 'x', mode: 'create' }), /already exists/)

    const skipped = await vault.writeNote({ note: 'New Note', content: 'x', mode: 'create', ifExists: 'skip' })
    assert.equal(skipped.skipped, true)
    assert.equal(await fsp.readFile(path.join(root, 'New Note.md'), 'utf8'), '# New\n\ntext\n')

    const appended = await vault.writeNote({ note: 'New Note', content: 'appended', mode: 'append' })
    assert.equal(appended.created, false)
    assert.equal(await fsp.readFile(path.join(root, 'New Note.md'), 'utf8'), '# New\n\ntext\n\nappended\n')

    const prepended = await vault.writeNote({ note: 'Welcome.md', content: 'PREPENDED', mode: 'prepend' })
    const welcomeText = await fsp.readFile(path.join(root, 'Welcome.md'), 'utf8')
    assert.ok(welcomeText.startsWith('---\ntitle: Welcome Home\n'))
    assert.ok(welcomeText.includes('PREPENDED\n\n# Welcome'))
    assert.equal(prepended.created, false)

    const inserted = await vault.writeNote({ note: 'Projects/Alpha.md', content: 'INSERTED', mode: 'insert', heading: 'Tasks' })
    const alphaText = await fsp.readFile(path.join(root, 'Projects/Alpha.md'), 'utf8')
    // "insert" appends at the end of the named section, before the next heading.
    assert.ok(alphaText.includes('## Tasks\n\n- [ ] task one\n\nINSERTED'))

    await assert.rejects(
      () => vault.writeNote({ note: 'Projects/Alpha.md', content: 'x', mode: 'insert', heading: 'Nope', headingFallback: 'error' }),
      /heading not found/,
    )
    const fallback = await vault.writeNote({ note: 'Projects/Alpha.md', content: 'AT END', mode: 'insert', heading: 'Nope' })
    assert.equal(fallback.mode, 'insert')
    assert.ok((await fsp.readFile(path.join(root, 'Projects/Alpha.md'), 'utf8')).trimEnd().endsWith('AT END'))

    const overwritten = await vault.writeNote({ note: 'Projects/Beta.md', content: '# Replaced\n', mode: 'overwrite' })
    assert.equal(overwritten.created, false)
    assert.equal(await fsp.readFile(path.join(root, 'Projects/Beta.md'), 'utf8'), '# Replaced\n')

    const overwrittenWithFrontmatter = await vault.writeNote({
      note: 'Projects/Beta.md',
      content: '---\ntitle: From Content\n---\nbody\n',
      mode: 'overwrite',
    })
    const betaText = await fsp.readFile(path.join(root, 'Projects/Beta.md'), 'utf8')
    assert.equal(betaText, '---\ntitle: From Content\n---\nbody\n')
    assert.equal(overwrittenWithFrontmatter.frontmatter.title, 'From Content')

    const createdWithContentFrontmatter = await vault.writeNote({ note: 'Third.md', content: '---\nstatus: new\n---\nhi\n' })
    assert.deepEqual(createdWithContentFrontmatter.frontmatter, { status: 'new' })
    assert.equal(await fsp.readFile(path.join(root, 'Third.md'), 'utf8'), '---\nstatus: new\n---\nhi\n')
  })
})

test('writeNote merges and deletes frontmatter keys', async () => {
  await withVault({}, async (vault, root) => {
    const merged = await vault.writeNote({
      note: 'Projects/Alpha.md',
      mode: 'overwrite',
      content: 'body only',
      frontmatter: { status: 'archived', owner: 'me' },
    })
    assert.deepEqual(merged.frontmatter, { tags: ['project', 'alpha'], status: 'archived', owner: 'me' })
    assert.equal(await fsp.readFile(path.join(root, 'Projects/Alpha.md'), 'utf8'), '---\ntags: [project, alpha]\nstatus: archived\nowner: me\n---\nbody only\n')

    const removed = await vault.writeNote({ note: 'Projects/Alpha.md', frontmatter: { status: null } })
    assert.deepEqual(removed.frontmatter, { tags: ['project', 'alpha'], owner: 'me' })
    assert.equal(removed.diff.oldText.includes('status: archived'), true)
  })
})

test('writeNote dryRun previews without touching the file', async () => {
  await withVault({}, async (vault, root) => {
    const before = await fsp.readFile(path.join(root, 'Welcome.md'), 'utf8')
    const preview = await vault.writeNote({ note: 'Welcome.md', mode: 'append', content: 'DRY', dryRun: true })
    assert.equal(preview.dryRun, true)
    assert.ok(preview.diff.newText.endsWith('DRY\n'))
    assert.equal(await fsp.readFile(path.join(root, 'Welcome.md'), 'utf8'), before)
  })
})

test('writeNote refuses path escapes, unwritable extensions, and read-only vaults', async () => {
  await withVault({}, async (vault, root) => {
    await assert.rejects(() => vault.writeNote({ note: '../outside.md', content: 'x' }), VaultPathError)
    await assert.rejects(() => vault.writeNote({ note: '..\\outside.md', content: 'x' }), VaultPathError)
    await assert.rejects(() => vault.writeNote({ note: 'sub/../../outside.md', content: 'x' }), VaultPathError)
    await assert.rejects(() => vault.writeNote({ note: 'evil.exe', content: 'x' }), /not writable/)
    assert.equal(await fsp.readdir(root).then((entries) => entries.includes('outside.md')), false)

    const readOnly = new ObsidianVault({ root, ttlMs: 0, readOnly: true })
    await assert.rejects(() => readOnly.writeNote({ note: 'Welcome.md', content: 'x', mode: 'append' }), /read-only/)
  })
})

test('writeNote accepts names that merely start with dots and rejects unusable ones', async () => {
  await withVault({}, async (vault, root) => {
    // A leading ".." is a legal name inside the vault, not a traversal.
    const dotted = await vault.writeNote({ note: '..dotted/note.md', content: 'x\n' })
    assert.equal(dotted.path, '..dotted/note.md')
    assert.equal(await fsp.readFile(path.join(root, '..dotted', 'note.md'), 'utf8'), 'x\n')

    await assert.rejects(() => vault.writeNote({ note: '.', content: 'x' }), /must name a file/)
    await assert.rejects(() => vault.writeNote({ note: '..', content: 'x' }), /must name a file/)
    if (process.platform === 'win32') {
      await assert.rejects(() => vault.writeNote({ note: 'CON.md', content: 'x' }), /reserved by Windows/)
    }
  })
})

test('writeNote reports filesystem problems as actionable tool errors', async () => {
  await withVault({}, async (vault, root) => {
    await fsp.writeFile(path.join(root, 'blocker'), 'not a directory', 'utf8')
    await assert.rejects(() => vault.writeNote({ note: 'blocker/child.md', content: 'x' }), /not a directory/)
    // The failed attempt must not leave a temp file behind.
    const leftovers = (await fsp.readdir(root)).filter((entry) => entry.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  })
})

test('writeNote never retargets an explicit path to another note with the same basename', async () => {
  await withVault({}, async (vault, root) => {
    await vault.writeNote({ note: 'afile/child.md', content: 'first\n' })
    await fsp.writeFile(path.join(root, 'blocker'), 'not a directory', 'utf8')
    await assert.rejects(
      () => vault.writeNote({ note: 'blocker/child.md', content: 'second\n', mode: 'overwrite' }),
      /not a directory/,
    )
    assert.equal(await fsp.readFile(path.join(root, 'afile/child.md'), 'utf8'), 'first\n')

    // A bare name may still resolve to an existing note elsewhere in the vault.
    const byName = await vault.writeNote({ note: 'Alpha', mode: 'append', content: 'via-name' })
    assert.equal(byName.path, 'Projects/Alpha.md')
    assert.ok((await fsp.readFile(path.join(root, 'Projects/Alpha.md'), 'utf8')).includes('via-name'))
  })
})

test('writeNote keeps new notes inside the vault and creates folders', async () => {
  await withVault({}, async (vault, root) => {
    const result = await vault.writeNote({ note: 'Deep/Nested/Note', content: 'nested\n' })
    assert.equal(result.path, 'Deep/Nested/Note.md')
    assert.equal(await fsp.readFile(path.join(root, 'Deep/Nested/Note.md'), 'utf8'), 'nested\n')
  })
})

test('moveNote renames a note and rewrites the links that reference it', async () => {
  await withVault({}, async (vault, root) => {
    await vault.scan()
    const result = await vault.moveNote({ note: 'Projects/Alpha.md', to: 'Projects/Alpha Renamed' })
    assert.equal(result.from, 'Projects/Alpha.md')
    assert.equal(result.to, 'Projects/Alpha Renamed.md')
    assert.equal(result.renamed, true)
    assert.equal(result.moved, false)
    assert.equal(result.linksUpdated, 2)
    assert.equal(result.filesUpdated, 2)

    assert.equal(await fsp.access(path.join(root, 'Projects/Alpha.md')).then(() => true, () => false), false)
    const moved = await fsp.readFile(path.join(root, 'Projects/Alpha Renamed.md'), 'utf8')
    assert.ok(moved.includes('# Alpha'))

    const welcome = await fsp.readFile(path.join(root, 'Welcome.md'), 'utf8')
    assert.ok(welcome.includes('[[Alpha Renamed]]'), `Welcome should link the new name:\n${welcome}`)
    const beta = await fsp.readFile(path.join(root, 'Projects/Beta.md'), 'utf8')
    assert.ok(beta.includes('[[Alpha Renamed]]'), `Beta should link the new name:\n${beta}`)
    // The index follows the move without a forced rescan.
    assert.equal(vault.findFile('Projects/Alpha Renamed.md'), 'Projects/Alpha Renamed.md')
    assert.equal(vault.findFile('Projects/Alpha.md'), null)
    assert.equal((await vault.search({ query: 'Alpha', mode: 'title' })).total, 1)
  })
})

test('moveNote keeps resolving bare-name links on a pure folder move and fixes path links', async () => {
  await withVault({}, async (vault, root) => {
    await vault.scan()
    const result = await vault.moveNote({ note: 'Projects/Alpha.md', to: 'Archive/' })
    assert.equal(result.to, 'Archive/Alpha.md')
    assert.equal(result.moved, true)
    assert.equal(result.renamed, false)

    // Bare-name wikilinks still resolve to the moved note: untouched.
    const beta = await fsp.readFile(path.join(root, 'Projects/Beta.md'), 'utf8')
    assert.ok(beta.includes('[[Alpha]]'), `Beta keeps its bare link:\n${beta}`)
    // The explicit-path link in Welcome is rewritten — to the shortest form
    // that still resolves, which is now the bare name.
    const welcome = await fsp.readFile(path.join(root, 'Welcome.md'), 'utf8')
    assert.ok(welcome.includes('[[Alpha]]'), `Welcome should use the shortest link:\n${welcome}`)
    assert.ok(!welcome.includes('[[Projects/Alpha]]'))
    assert.equal(result.linksUpdated, 1)
    assert.deepEqual(result.rewrites, [{ path: 'Welcome.md', line: 14, before: '[[Projects/Alpha]]', after: '[[Alpha]]' }])
  })
})

test('moveNote updates embeds, skips code blocks, and fixes the moved note\'s own relative links', async () => {
  await withVault({
    files: {
      'notes/Embeds.md': [
        'Real: [[Projects/Alpha]] and ![[Projects/Alpha]] embed.',
        '',
        '```md',
        'Inside a fence: [[Projects/Alpha]] stays.',
        '```',
        '',
        'Inline `[[Projects/Alpha]]` code stays too.',
        '',
      ].join('\n'),
      'notes/Relative.md': 'See [the alpha note](../Projects/Alpha.md) and [welcome](../Welcome.md).\n',
    },
  }, async (vault, root) => {
    await vault.scan()
    const result = await vault.moveNote({ note: 'Projects/Alpha.md', to: 'Archive/' })
    assert.equal(result.to, 'Archive/Alpha.md')

    const embeds = await fsp.readFile(path.join(root, 'notes/Embeds.md'), 'utf8')
    assert.ok(embeds.includes('Real: [[Alpha]] and ![[Alpha]] embed.'), `real links rewritten to the shortest form:\n${embeds}`)
    assert.ok(embeds.includes('Inside a fence: [[Projects/Alpha]] stays.'), 'fenced code untouched')
    assert.ok(embeds.includes('Inline `[[Projects/Alpha]]` code stays too.'), 'inline code untouched')

    const relative = await fsp.readFile(path.join(root, 'notes/Relative.md'), 'utf8')
    assert.ok(relative.includes('(../Archive/Alpha.md)'), `markdown links are rewritten:\n${relative}`)
    assert.ok(relative.includes('[welcome](../Welcome.md)'), 'unrelated markdown links untouched')
  })
})

test('moveNote refuses collisions, self-moves, dot folders, and unwritable targets', async () => {
  await withVault({}, async (vault) => {
    await vault.scan()
    await assert.rejects(() => vault.moveNote({ note: 'Projects/Alpha.md', to: 'Projects/Beta.md' }), /already exists/)
    await assert.rejects(() => vault.moveNote({ note: 'Projects/Alpha.md', to: 'Projects/Alpha' }), /same as the source/)
    await assert.rejects(() => vault.moveNote({ note: 'Projects/Alpha.md', to: '.trash/Alpha.md' }), /dot folder/)
    await assert.rejects(() => vault.moveNote({ note: 'Projects/Alpha.md', to: 'Archive/Alpha.canvas' }), /not writable/)
    await assert.rejects(() => vault.moveNote({ note: 'Missing Note', to: 'X.md' }), /not found/)
    const readOnly = new ObsidianVault({ root: vault.root, ttlMs: 0, readOnly: true })
    await assert.rejects(() => readOnly.moveNote({ note: 'Projects/Alpha.md', to: 'Archive/' }), /read-only/)
  })
})

test('moveNote dryRun plans rewrites without touching anything', async () => {
  await withVault({}, async (vault, root) => {
    await vault.scan()
    const plan = await vault.moveNote({ note: 'Projects/Alpha.md', to: 'Projects/Alpha Renamed', dryRun: true })
    assert.equal(plan.dryRun, true)
    assert.equal(plan.to, 'Projects/Alpha Renamed.md')
    assert.equal(plan.linksUpdated, 2)
    assert.ok(plan.rewrites.some((rewrite) => rewrite.before === '[[Projects/Alpha]]' && rewrite.after === '[[Alpha Renamed]]'))
    assert.ok(plan.rewrites.some((rewrite) => rewrite.before === '[[Alpha]]' && rewrite.after === '[[Alpha Renamed]]'))
    // Nothing moved, nothing rewritten.
    assert.equal(await fsp.access(path.join(root, 'Projects/Alpha.md')).then(() => true, () => false), true)
    const welcome = await fsp.readFile(path.join(root, 'Welcome.md'), 'utf8')
    assert.ok(welcome.includes('[[Projects/Alpha]]'))
    assert.equal(await fsp.access(path.join(root, 'Projects/Alpha Renamed.md')).then(() => true, () => false), false)
  })
})

test('deleteNote moves a note into .trash and reports dangling backlinks', async () => {
  await withVault({}, async (vault, root) => {
    await vault.scan()
    const result = await vault.deleteNote({ note: 'Projects/Alpha.md' })
    assert.equal(result.permanent, false)
    assert.equal(result.trashTarget, '.trash/Projects/Alpha.md')
    assert.equal(result.backlinkCount >= 2, true)
    assert.ok(result.backlinks.some((backlink) => backlink.path === 'Welcome.md'))

    assert.equal(await fsp.access(path.join(root, 'Projects/Alpha.md')).then(() => true, () => false), false)
    const trashed = await fsp.readFile(path.join(root, '.trash/Projects/Alpha.md'), 'utf8')
    assert.ok(trashed.includes('# Alpha'))
    assert.equal(vault.findFile('Projects/Alpha.md'), null)
    assert.equal((await vault.search({ query: 'Alpha project notes', mode: 'phrase' })).total, 0)
  })
})

test('deleteNote permanent removes the file, dryRun only reports', async () => {
  await withVault({}, async (vault, root) => {
    await vault.scan()
    const plan = await vault.deleteNote({ note: 'Projects/Beta.md', dryRun: true })
    assert.equal(plan.dryRun, true)
    assert.ok(plan.trashTarget !== null)
    assert.equal(await fsp.access(path.join(root, 'Projects/Beta.md')).then(() => true, () => false), true)

    const done = await vault.deleteNote({ note: 'Projects/Beta.md', permanent: true })
    assert.equal(done.permanent, true)
    assert.equal(done.trashTarget, null)
    assert.equal(await fsp.access(path.join(root, 'Projects/Beta.md')).then(() => true, () => false), false)
    assert.equal(await fsp.access(path.join(root, '.trash/Projects/Beta.md')).then(() => true, () => false), false)

    const readOnly = new ObsidianVault({ root, ttlMs: 0, readOnly: true })
    await assert.rejects(() => readOnly.deleteNote({ note: 'Welcome.md' }), /read-only/)
  })
})

test('deleteNote collision in .trash gets a numeric suffix', async () => {
  await withVault({}, async (vault, root) => {
    await fsp.mkdir(path.join(root, '.trash', 'Projects'), { recursive: true })
    await fsp.writeFile(path.join(root, '.trash/Projects/Alpha.md'), 'older trash\n', 'utf8')
    await vault.scan()
    const result = await vault.deleteNote({ note: 'Projects/Alpha.md' })
    assert.equal(result.trashTarget, '.trash/Projects/Alpha.1.md')
    assert.equal(await fsp.readFile(path.join(root, '.trash/Projects/Alpha.md'), 'utf8'), 'older trash\n')
    assert.ok((await fsp.readFile(path.join(root, '.trash/Projects/Alpha.1.md'), 'utf8')).includes('# Alpha'))
  })
})

test('writeNote supports @daily for offline daily notes', async () => {
  await withVault({}, async (vault, root) => {
    await vault.scan()
    const appended = await vault.writeNote({ note: '@daily-2026-10-10', mode: 'append', content: 'late evening note' })
    assert.equal(appended.path, 'Daily/2026-10-10.md')
    const text = await fsp.readFile(path.join(root, 'Daily/2026-10-10.md'), 'utf8')
    assert.ok(text.includes('Standup notes.'))
    assert.ok(text.includes('late evening note'))

    const today = await vault.writeNote({ note: '@daily', content: '# Journal\n' })
    assert.equal(today.path, await vault.dailyPath(undefined))
    assert.ok(today.path.startsWith('Daily/'))
    assert.equal(today.created, true)

    await assert.rejects(() => vault.writeNote({ note: '@daily-2026-13-99', content: 'x' }), /invalid date/)
    await assert.rejects(() => vault.writeNote({ note: '@daily-2026-13-99-extra', content: 'x' }), /unknown "@daily" reference/)
  })
})

test('attachFile copies local files into the vault honoring the attachment settings', async () => {
  await withVault({}, async (vault, root) => {
    await vault.scan()
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-obsidian-src-'))
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
      await fsp.writeFile(path.join(outside, 'chart.png'), png)

      // app.json says attachmentFolderPath "attachments".
      const first = await vault.attachFile({ source: path.join(outside, 'chart.png') })
      assert.equal(first.path, 'attachments/chart.png')
      assert.equal(first.embed, '![[chart.png]]')
      assert.equal(first.bytes, png.length)
      assert.equal(await fsp.readFile(path.join(root, 'attachments/chart.png')).then((buffer) => buffer.equals(png)), true)

      const second = await vault.attachFile({ source: path.join(outside, 'chart.png') })
      assert.equal(second.path, 'attachments/chart-1.png')

      const renamed = await vault.attachFile({ source: path.join(outside, 'chart.png'), name: 'diagram', folder: 'Images/Deep' })
      assert.equal(renamed.path, 'Images/Deep/diagram.png')
      assert.equal(renamed.embed, '![[diagram.png]]')

      const noteRelative = await vault.attachFile({ source: path.join(outside, 'chart.png'), folder: './', note: 'Projects/Alpha.md' })
      assert.equal(noteRelative.path, 'Projects/chart.png')
      assert.equal(noteRelative.appendedToNote, true)
      const alpha = await fsp.readFile(path.join(root, 'Projects/Alpha.md'), 'utf8')
      assert.ok(alpha.includes('![[chart.png]]'))

      const plan = await vault.attachFile({ source: path.join(outside, 'chart.png'), dryRun: true })
      assert.equal(plan.dryRun, true)
      assert.equal(await fsp.access(path.join(root, 'attachments/chart-3.png')).then(() => true, () => false), false)

      await assert.rejects(() => vault.attachFile({ source: 'relative/path.png' }), /absolute local path/)
      await assert.rejects(() => vault.attachFile({ source: path.join(outside, 'missing.png') }), /does not exist/)
      await assert.rejects(() => vault.attachFile({ source: path.join(outside, 'chart.png'), name: 'evil.exe' }), /not allowed as an attachment/)
      const readOnly = new ObsidianVault({ root, ttlMs: 0, readOnly: true })
      await assert.rejects(() => readOnly.attachFile({ source: path.join(outside, 'chart.png') }), /read-only/)
    } finally {
      await fsp.rm(outside, { recursive: true, force: true })
    }
  })
})

test('the index and parse cache follow external edits', async () => {
  await withVault({}, async (vault, root) => {
    await vault.scan()
    assert.equal((await vault.search({ query: 'freshly added word' })).total, 0)
    await fsp.writeFile(path.join(root, 'Later.md'), '# Later\n\nfreshly added word\n', 'utf8')
    await vault.scan({ force: true })
    assert.equal((await vault.search({ query: 'freshly added word' })).total, 1)

    await fsp.writeFile(path.join(root, 'Projects/Beta.md'), '# Beta\n\nrewritten content zzz\n', 'utf8')
    await vault.scan({ force: true })
    assert.equal((await vault.search({ query: 'zzz' })).total, 1)
    assert.equal((await vault.search({ query: 'Beta project notes' })).total, 0)
  })
})

test('dailyPath honors the vault daily-notes settings and formatDate tokens', async () => {
  await withVault({}, async (vault) => {
    assert.equal(await vault.dailyPath('2026-10-10'), 'Daily/2026-10-10.md')
    assert.equal(formatDate(new Date(2026, 9, 10), 'YYYY-MM-DD'), '2026-10-10')
    assert.equal(formatDate(new Date(2026, 0, 5), 'DD.MM.YY'), '05.01.26')
    assert.equal(formatDate(new Date(2026, 0, 5), 'dddd, MMMM D'), 'Monday, January 5')
    await assert.rejects(() => vault.dailyPath('not-a-date'), ToolInputError)
  })
})

test('vaultInfo summarizes the vault', async () => {
  await withVault({}, async (vault) => {
    const info = await vault.vaultInfo()
    assert.equal(info.notes, 5)
    assert.equal(info.folders, 3)
    assert.equal(info.readOnly, false)
    assert.equal(info.dailyFolder, 'Daily')
  })
})

test('discoverVaults keeps existing directories only', async () => {
  const root = await makeVault({ 'a.md': '# a\n' })
  const previousAppData = process.env.APPDATA
  const fakeAppData = path.join(root, '..', `no-obsidian-${process.pid}`)
  try {
    // Isolate discovery from the machine's real Obsidian registry.
    process.env.APPDATA = fakeAppData
    const found = await discoverVaults({ vaults: [root, path.join(root, 'missing')] })
    assert.equal(found.length, 1)
    assert.equal(found[0].path, root)
    assert.deepEqual(found[0].sources, ['config'])
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = previousAppData
    await removeVault(root)
  }
})
