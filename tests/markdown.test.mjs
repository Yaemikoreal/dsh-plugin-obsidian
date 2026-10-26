import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractHeadings,
  extractLinks,
  extractTags,
  findHeadingSection,
  insertAtLine,
  joinBlocks,
  parseFrontmatter,
  parseYamlSubset,
  replaceLinkOnLine,
  slugify,
  splitLines,
  stringifyFrontmatter,
  stripCodeBlocks,
} from '../lib/markdown.js'

test('replaceLinkOnLine rewrites real links but leaves code regions alone', () => {
  const line = 'See [[Projects/Alpha]] and `[[Projects/Alpha]]` here.'
  const stripped = stripCodeBlocks(line)
  assert.equal(
    replaceLinkOnLine(line, stripped, '[[Projects/Alpha]]', '[[Alpha]]'),
    'See [[Alpha]] and `[[Projects/Alpha]]` here.',
  )
  // Every real occurrence is replaced.
  assert.equal(
    replaceLinkOnLine('[[A]] and [[A]] again', stripCodeBlocks('[[A]] and [[A]] again'), '[[A]]', '[[B]]'),
    '[[B]] and [[B]] again',
  )
  // No occurrence (or empty needle) → the line comes back untouched.
  assert.equal(replaceLinkOnLine('nothing here', 'nothing here', '[[x]]', '[[y]]'), 'nothing here')
  assert.equal(replaceLinkOnLine('text', 'text', '', '[[y]]'), 'text')
})

test('parseFrontmatter separates frontmatter, body, and body line', () => {
  const text = '---\ntitle: Hi\ntags: [a, b]\n---\n# Body\n\ntext\n'
  const parsed = parseFrontmatter(text)
  assert.deepEqual(parsed.frontmatter, { title: 'Hi', tags: ['a', 'b'] })
  assert.equal(parsed.bodyLine, 5)
  assert.equal(parsed.body.startsWith('# Body'), true)
})

test('parseFrontmatter handles notes without frontmatter', () => {
  const parsed = parseFrontmatter('# Plain\n\ntext\n')
  assert.equal(parsed.frontmatter, null)
  assert.equal(parsed.bodyLine, 1)
  assert.equal(parsed.body, '# Plain\n\ntext\n')
})

test('parseYamlSubset covers the shapes Obsidian users write', () => {
  const parsed = parseYamlSubset([
    'title: My note',
    'draft: false',
    'count: 3',
    'ratio: 1.5',
    'date: 2026-10-10',
    'empty:',
    'quoted: "a: b # c"',
    'tags:',
    '  - one',
    '  - two',
    'nested:',
    '  key: value',
    '  list: [x, y]',
    'people:',
    '  - name: Ada',
    '    role: author',
    'summary: |',
    '  line one',
    '  line two',
  ].join('\n'))
  assert.equal(parsed.title, 'My note')
  assert.equal(parsed.draft, false)
  assert.equal(parsed.count, 3)
  assert.equal(parsed.ratio, 1.5)
  assert.equal(parsed.date, '2026-10-10')
  assert.equal(parsed.empty, null)
  assert.equal(parsed.quoted, 'a: b # c')
  assert.deepEqual(parsed.tags, ['one', 'two'])
  assert.deepEqual(parsed.nested, { key: 'value', list: ['x', 'y'] })
  assert.deepEqual(parsed.people, [{ name: 'Ada', role: 'author' }])
  assert.equal(parsed.summary, 'line one\nline two')
})

test('frontmatter round-trips through stringifyFrontmatter', () => {
  const frontmatter = {
    title: 'A: title',
    tags: ['one', 'two'],
    draft: false,
    count: 2,
    nested: { key: 'value' },
    list: [{ name: 'Ada' }],
  }
  const text = `${stringifyFrontmatter(frontmatter)}\nbody\n`
  const parsed = parseFrontmatter(text)
  assert.deepEqual(parsed.frontmatter, frontmatter)
})

test('stripCodeBlocks blanks code while preserving line count', () => {
  const text = 'before `inline` #tag\n```\n#not-a-tag [[NotALink]]\n```\nafter #real\n'
  const stripped = stripCodeBlocks(text)
  assert.equal(stripped.split('\n').length, text.split('\n').length)
  assert.equal(stripped.includes('not-a-tag'), false)
  assert.equal(stripped.includes('#tag'), true)
})

test('extractTags merges frontmatter and inline tags', () => {
  const text = '---\ntags: [alpha, beta]\n---\n# Heading\n\ntext #gamma and #alpha again\n'
  const tags = extractTags(text, parseFrontmatter(text).frontmatter)
  assert.deepEqual(tags, ['alpha', 'beta', 'gamma'])
})

test('extractLinks reads wikilinks, aliases, headings, and markdown links', () => {
  const text = 'See [[Note|alias]], [[Folder/Other#Section]], ![[Embed]] and [md](other.md).\n'
  const links = extractLinks(text)
  assert.equal(links.length, 4)
  assert.deepEqual(links[0], { target: 'Note', heading: null, block: null, alias: 'alias', embed: false, kind: 'wiki', line: 1, raw: '[[Note|alias]]' })
  assert.equal(links[1].target, 'Folder/Other')
  assert.equal(links[1].heading, 'Section')
  assert.equal(links[2].embed, true)
  assert.equal(links[3].target, 'other.md')
  assert.equal(links[3].kind, 'markdown')
})

test('extractHeadings reports level, line, and slug', () => {
  const text = '# One\n\ntext\n\n## Two Words\n\n```\n# not a heading\n```\n'
  const headings = extractHeadings(text)
  assert.deepEqual(headings.map((heading) => [heading.level, heading.text, heading.line]), [[1, 'One', 1], [2, 'Two Words', 5]])
  assert.equal(headings[1].slug, 'two-words')
  assert.equal(slugify('Hello, World!'), 'hello-world')
})

test('findHeadingSection and insertAtLine place content inside a section', () => {
  const lines = splitLines('# Top\n\nalpha\n\n## Sub\n\nbeta\n\n# Next\n\ngamma\n')
  const section = findHeadingSection(lines, 'Sub')
  assert.equal(section.startLine, 5)
  assert.equal(section.insertIndex, 8)
  const merged = insertAtLine(lines, section.insertIndex, 'inserted')
  assert.equal(merged.join('\n').includes('beta\n\ninserted\n\n# Next'), true)
  assert.equal(findHeadingSection(lines, 'Missing'), null)
})

test('insertAtLine keeps an appended list item inside the same list', () => {
  const lines = splitLines('# Top\n\n## List\n\n- one\n- two\n\n## Next\n\nx\n')
  const section = findHeadingSection(lines, 'List')
  const merged = insertAtLine(lines, section.insertIndex, '- three')
  assert.equal(merged.join('\n').includes('- one\n- two\n- three\n\n## Next'), true)
  // A non-list block still gets its own paragraph.
  const paragraph = insertAtLine(lines, section.insertIndex, 'plain text')
  assert.equal(paragraph.join('\n').includes('- two\n\nplain text\n\n## Next'), true)
})

test('joinBlocks normalizes blank-line boundaries', () => {
  assert.equal(joinBlocks('a\n\n', '\nb'), 'a\n\nb')
  assert.equal(joinBlocks('', 'b'), 'b')
  assert.equal(joinBlocks('a', ''), 'a')
})
