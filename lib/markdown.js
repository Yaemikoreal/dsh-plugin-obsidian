/**
 * Markdown and YAML-subset parsing for Obsidian notes.
 *
 * Deliberately small and dependency-free: frontmatter, tags, wikilinks, and
 * headings are all this plugin needs, and a hand-rolled subset keeps the
 * plugin installable into a profile without any package dependencies.
 *
 * @module dsh-plugin-obsidian/markdown
 */

import { uniqueStrings } from './util.js'

/** Split text into lines, normalizing CRLF and dropping one trailing blank. */
export function splitLines(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Blank out fenced code blocks and inline code while preserving line count, so
 * tag/link/heading scans keep reporting the real file line numbers.
 *
 * @param {string} text - raw markdown.
 * @returns {string} same-length text with code regions blanked.
 */
export function stripCodeBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let fence = null
  for (const line of lines) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence === null) {
      if (match !== null) {
        fence = match[1][0].repeat(3)
        out.push('')
        continue
      }
      out.push(line.replace(/`[^`]*`/g, (value) => ' '.repeat(value.length)))
      continue
    }
    if (match !== null && match[1].startsWith(fence)) fence = null
    out.push('')
  }
  return out.join('\n')
}

/**
 * Split a leading YAML frontmatter block from the note body.
 *
 * @param {string} text - raw note text.
 * @returns {{ frontmatter: Record<string, unknown> | null, frontmatterRaw: string | null, body: string, bodyLine: number }}
 *   parsed frontmatter, its raw text, the body, and the 1-based first body line.
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '')
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)
  if (match === null) {
    return { frontmatter: null, frontmatterRaw: null, body: source, bodyLine: 1 }
  }
  const raw = match[1]
  const parsed = parseYamlSubset(raw)
  const consumedLines = match[0].replace(/\r\n/g, '\n').split('\n').length - 1
  return {
    frontmatter: parsed,
    frontmatterRaw: raw,
    body: source.slice(match[0].length),
    bodyLine: consumedLines + 1,
  }
}

/**
 * Parse the YAML subset Obsidian users actually write in frontmatter:
 * `key: scalar`, nested maps by indentation, block and inline sequences,
 * `key: |` / `key: >` block scalars, quotes, and comments.
 *
 * @param {string} raw - frontmatter text without the `---` fences.
 * @returns {Record<string, unknown> | null} parsed mapping, or null when empty.
 */
export function parseYamlSubset(raw) {
  const records = []
  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    if (/^\s*#/.test(rawLine)) continue
    const indent = (rawLine.match(/^[ \t]*/) ?? [''])[0].replace(/\t/g, '  ').length
    records.push({ indent, content: rawLine.trim() })
  }
  if (records.length === 0) return null
  const { value } = parseBlock(records, 0, records[0].indent)
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function parseBlock(records, index, indent) {
  const first = records[index]
  if (first === undefined) return { value: null, index }
  if (first.content === '-' || first.content.startsWith('- ')) {
    return parseSequence(records, index, indent)
  }
  return parseMap(records, index, indent)
}

function parseMap(records, index, indent) {
  const map = {}
  let cursor = index
  while (cursor < records.length) {
    const line = records[cursor]
    if (line.indent < indent) break
    if (line.indent > indent) {
      cursor += 1
      continue
    }
    if (line.content === '-' || line.content.startsWith('- ')) break
    const pair = splitKeyValue(line.content)
    if (pair === null) {
      cursor += 1
      continue
    }
    if (pair.value === '|' || pair.value === '>') {
      const parts = []
      let next = cursor + 1
      while (next < records.length && records[next].indent > indent) {
        parts.push(records[next].content)
        next += 1
      }
      map[pair.key] = parts.join(pair.value === '|' ? '\n' : ' ')
      cursor = next
      continue
    }
    if (pair.value === '') {
      const next = records[cursor + 1]
      if (next !== undefined && next.indent > indent) {
        const nested = parseBlock(records, cursor + 1, next.indent)
        map[pair.key] = nested.value
        cursor = nested.index
      } else {
        map[pair.key] = null
        cursor += 1
      }
      continue
    }
    map[pair.key] = parseScalar(pair.value)
    cursor += 1
  }
  return { value: map, index: cursor }
}

function parseSequence(records, index, indent) {
  const list = []
  let cursor = index
  while (cursor < records.length) {
    const line = records[cursor]
    if (line.indent < indent) break
    if (line.indent > indent) {
      cursor += 1
      continue
    }
    if (!(line.content === '-' || line.content.startsWith('- '))) break
    const rest = line.content === '-' ? '' : line.content.slice(2).trim()
    if (rest === '') {
      const next = records[cursor + 1]
      if (next !== undefined && next.indent > indent) {
        const nested = parseBlock(records, cursor + 1, next.indent)
        list.push(nested.value)
        cursor = nested.index
      } else {
        list.push(null)
        cursor += 1
      }
      continue
    }
    const pair = splitKeyValue(rest)
    if (pair !== null) {
      const item = {}
      if (pair.value === '') {
        const next = records[cursor + 1]
        if (next !== undefined && next.indent > indent) {
          const nested = parseBlock(records, cursor + 1, next.indent)
          item[pair.key] = nested.value
          cursor = nested.index
        } else {
          item[pair.key] = null
          cursor += 1
        }
      } else {
        item[pair.key] = parseScalar(pair.value)
        cursor += 1
      }
      const continuation = records[cursor]
      if (continuation !== undefined && continuation.indent > indent
        && !(continuation.content === '-' || continuation.content.startsWith('- '))) {
        const nested = parseMap(records, cursor, continuation.indent)
        Object.assign(item, nested.value)
        cursor = nested.index
      }
      list.push(item)
      continue
    }
    list.push(parseScalar(rest))
    cursor += 1
  }
  return { value: list, index: cursor }
}

function splitKeyValue(content) {
  let quote = null
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    if (quote !== null) {
      if (char === quote && content[index - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ':' && (index + 1 === content.length || /\s/.test(content[index + 1]))) {
      const key = content.slice(0, index).trim().replace(/^["']|["']$/g, '')
      if (key === '') return null
      return { key, value: content.slice(index + 1).trim() }
    }
  }
  return null
}

function splitInlineList(text) {
  const parts = []
  let quote = null
  let depth = 0
  let current = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      current += char
      if (char === quote && text[index - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '[' || char === '{') depth += 1
    if (char === ']' || char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

function parseScalar(value) {
  const text = String(value ?? '').trim()
  if (text === '') return null
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    return splitInlineList(text.slice(1, -1)).map((entry) => parseScalar(entry))
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const map = {}
    for (const entry of splitInlineList(text.slice(1, -1))) {
      const pair = splitKeyValue(entry)
      if (pair !== null) map[pair.key] = parseScalar(pair.value)
    }
    return map
  }
  const plain = stripTrailingComment(text)
  const lower = plain.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  if (lower === 'null' || plain === '~') return null
  if (/^-?\d+$/.test(plain)) {
    const number = Number(plain)
    return Number.isSafeInteger(number) ? number : plain
  }
  if (/^-?\d+\.\d+$/.test(plain)) return Number(plain)
  return plain
}

function stripTrailingComment(text) {
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === quote && text[index - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && index > 0 && /\s/.test(text[index - 1])) return text.slice(0, index).trim()
  }
  return text.trim()
}

/**
 * Serialize a frontmatter mapping back to YAML with the `---` fences.
 *
 * @param {Record<string, unknown>} frontmatter - mapping to serialize.
 * @returns {string} a complete frontmatter block ending with a newline.
 */
export function stringifyFrontmatter(frontmatter) {
  return `---\n${stringifyMap(frontmatter, 0)}---\n`
}

function stringifyMap(map, indent) {
  const pad = ' '.repeat(indent)
  let out = ''
  for (const [key, value] of Object.entries(map ?? {})) {
    if (value === undefined) continue
    const rendered = stringifyValue(value, indent)
    out += rendered.multiline
      ? `${pad}${key}:\n${rendered.text}`
      : `${pad}${key}: ${rendered.text}\n`
  }
  return out
}

function stringifyValue(value, indent) {
  const pad = ' '.repeat(indent + 2)
  if (Array.isArray(value)) {
    if (value.length === 0) return { text: '[]', multiline: false }
    if (value.every((entry) => entry === null || typeof entry !== 'object')) {
      return { text: `[${value.map((entry) => stringifyScalar(entry)).join(', ')}]`, multiline: false }
    }
    let text = ''
    for (const entry of value) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        const lines = stringifyMap(entry, indent + 4).split('\n').filter((line) => line !== '')
        lines.forEach((line, index) => {
          const content = line.slice(indent + 4)
          text += index === 0 ? `${pad}- ${content}\n` : `${pad}  ${content}\n`
        })
      } else {
        text += `${pad}- ${stringifyScalar(entry)}\n`
      }
    }
    return { text, multiline: true }
  }
  if (value !== null && typeof value === 'object') {
    return { text: stringifyMap(value, indent + 2), multiline: true }
  }
  return { text: stringifyScalar(value), multiline: false }
}

function stringifyScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  const text = String(value)
  if (text === '') return '""'
  const needsQuote = /^\s|\s$/.test(text)
    || /[:#[\]{}",'|>&*!%@`]/.test(text)
    || /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(text)
    || text.includes('\n')
  if (!needsQuote) return text
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/**
 * Collect tags from frontmatter (`tags`/`tag`/`keywords`) and inline `#tags`.
 *
 * @param {string} text - raw note text.
 * @param {Record<string, unknown> | null} frontmatter - parsed frontmatter.
 * @returns {string[]} unique tag names without the leading `#`.
 */
export function extractTags(text, frontmatter) {
  const tags = []
  const pushValue = (value) => {
    if (typeof value !== 'string') return
    for (const part of value.split(/[,\s]+/)) {
      const tag = part.trim().replace(/^#/, '')
      if (tag !== '') tags.push(tag)
    }
  }
  if (frontmatter !== null && typeof frontmatter === 'object') {
    for (const key of ['tags', 'tag', 'Tags', 'TAGS', 'keywords']) {
      const value = frontmatter[key]
      if (value === undefined || value === null) continue
      if (Array.isArray(value)) value.forEach((entry) => pushValue(String(entry)))
      else pushValue(String(value))
    }
  }
  const stripped = stripCodeBlocks(text)
  const pattern = /(^|[\s([{>])#([\p{L}\p{N}_\-/]+)/gu
  let match = pattern.exec(stripped)
  while (match !== null) {
    const tag = match[2]
    if (!/^\d+$/.test(tag)) tags.push(tag)
    match = pattern.exec(stripped)
  }
  return uniqueStrings(tags)
}

/**
 * Extract wikilinks and markdown links to notes.
 *
 * @param {string} text - raw note text.
 * @returns {Array<{ target: string, heading: string | null, block: string | null, alias: string | null, embed: boolean, kind: 'wiki' | 'markdown', line: number, raw: string }>}
 *   every link occurrence in file order.
 */
export function extractLinks(text) {
  const lines = splitLines(stripCodeBlocks(text))
  const links = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const wiki = /(!?)\[\[([^[\]\n]+)\]\]/g
    let match = wiki.exec(line)
    while (match !== null) {
      const parsed = parseWikiTarget(match[2])
      if (parsed !== null) {
        links.push({
          target: parsed.target,
          heading: parsed.heading,
          block: parsed.block,
          alias: parsed.alias,
          embed: match[1] === '!',
          kind: 'wiki',
          line: index + 1,
          raw: match[0],
        })
      }
      match = wiki.exec(line)
    }
    const markdown = /\[([^\]\n]*)\]\(([^)\s]+?\.(?:md|markdown|txt))(?:\s+"[^"]*")?\)/gi
    match = markdown.exec(line)
    while (match !== null) {
      let target = match[2]
      try {
        target = decodeURIComponent(target)
      } catch {
        /* keep the raw target when it is not valid percent-encoding */
      }
      links.push({
        target,
        heading: null,
        block: null,
        alias: match[1] === '' ? null : match[1],
        embed: false,
        kind: 'markdown',
        line: index + 1,
        raw: match[0],
      })
      match = markdown.exec(line)
    }
  }
  return links
}

function parseWikiTarget(inner) {
  const pipe = inner.indexOf('|')
  const targetPart = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
  const alias = pipe === -1 ? null : inner.slice(pipe + 1).trim()
  if (targetPart === '') return null
  let target = targetPart
  let heading = null
  let block = null
  const hash = target.indexOf('#')
  if (hash !== -1) {
    heading = target.slice(hash + 1).trim() || null
    target = target.slice(0, hash)
  }
  const caret = target.indexOf('^')
  if (caret !== -1) {
    block = target.slice(caret + 1).trim() || null
    target = target.slice(0, caret)
  }
  return { target: target.trim(), heading, block, alias: alias === '' ? null : alias }
}

/**
 * Extract ATX headings with their 1-based line numbers.
 *
 * @param {string} text - raw note text.
 * @returns {Array<{ level: number, text: string, line: number, slug: string }>} headings in order.
 */
export function extractHeadings(text) {
  const lines = splitLines(stripCodeBlocks(text))
  const headings = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lines[index])
    if (match === null) continue
    const headingText = match[2].trim()
    headings.push({ level: match[1].length, text: headingText, line: index + 1, slug: slugify(headingText) })
  }
  return headings
}

/** Slugify heading text the way GitHub/Obsidian anchor links do. */
export function slugify(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

/**
 * Locate a heading's section so content can be inserted at its end.
 *
 * @param {string[]} lines - the note body lines.
 * @param {string} heading - heading text, with or without leading `#`.
 * @returns {{ startLine: number, endLine: number, insertIndex: number } | null}
 *   1-based section bounds and the 0-based line index to insert before.
 */
export function findHeadingSection(lines, heading) {
  const target = String(heading ?? '').trim().replace(/^#+/, '').trim()
  if (target === '') return null
  const targetLower = target.toLowerCase()
  const targetSlug = slugify(target)
  let found = -1
  let level = 0
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lines[index])
    if (match === null) continue
    const text = match[2].trim()
    if (found === -1) {
      if (text.toLowerCase() === targetLower || slugify(text) === targetSlug) {
        found = index
        level = match[1].length
      }
      continue
    }
    if (match[1].length <= level) return { startLine: found + 1, endLine: index, insertIndex: index }
  }
  if (found === -1) return null
  return { startLine: found + 1, endLine: lines.length, insertIndex: lines.length }
}

/** Join two markdown blocks with exactly one blank line between them. */
export function joinBlocks(left, right) {
  const a = String(left ?? '').replace(/\s+$/, '')
  const b = String(right ?? '').replace(/^\s+/, '')
  if (a === '') return b
  if (b === '') return a
  return `${a}\n\n${b}`
}

/** Insert `block` at a 0-based line index, keeping a blank line boundary. */
export function insertAtLine(lines, index, block) {
  const before = lines.slice(0, index)
  const after = lines.slice(index)
  while (before.length > 0 && before[before.length - 1].trim() === '') before.pop()
  while (after.length > 0 && after[0].trim() === '') after.shift()
  const inserted = String(block ?? '').replace(/^\s+|\s+$/g, '').split('\n')
  const merged = [...before]
  const lastLine = before.length > 0 ? before[before.length - 1] : ''
  const firstLine = inserted.length > 0 ? inserted[0] : ''
  // Appending a list item to a list keeps it in the same list; any other
  // boundary gets a blank line so the two blocks stay separate.
  if (before.length > 0 && inserted.length > 0 && !continuesSameList(lastLine, firstLine)) merged.push('')
  merged.push(...inserted)
  if (after.length > 0 && inserted.length > 0) merged.push('')
  return [...merged, ...after]
}

/** Whether two lines are items of the same markdown list kind. */
function continuesSameList(left, right) {
  const leftMatch = /^\s*([-*+]|\d+[.)])\s+/.exec(left)
  const rightMatch = /^\s*([-*+]|\d+[.)])\s+/.exec(right)
  if (leftMatch === null || rightMatch === null) return false
  const kind = (match) => (match[1].length === 1 ? 'bullet' : 'ordered')
  return kind(leftMatch) === kind(rightMatch)
}
