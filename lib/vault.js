/**
 * Obsidian vault access over the filesystem.
 *
 * The vault is read directly from disk so querying and writing work whether or
 * not Obsidian is running. An in-memory metadata index plus a byte-budgeted
 * parse cache keeps repeated searches fast; the index refreshes on a short TTL
 * and drops any cached note whose mtime or size changed.
 *
 * @module dsh-plugin-obsidian/vault
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  extractHeadings,
  extractLinks,
  extractTags,
  findHeadingSection,
  insertAtLine,
  joinBlocks,
  parseFrontmatter,
  replaceLinkOnLine,
  splitLines,
  stringifyFrontmatter,
  stripCodeBlocks,
} from './markdown.js'
import {
  ToolInputError,
  VaultPathError,
  baseName,
  clampInt,
  countOccurrences,
  describeFsError,
  globToRegExp,
  isUnderFolder,
  mapLimit,
  matchesAnyPattern,
  parentFolder,
  resolveInside,
  stripExtension,
  throwIfAborted,
  toPosix,
  tokenizeQuery,
  truncateText,
  uniqueStrings,
  unusableFileName,
} from './util.js'

/** Directories never indexed: Obsidian's own config, trash, and VCS noise. */
export const DEFAULT_EXCLUDES = ['.obsidian/**', '.trash/**', '.git/**', '**/node_modules/**', '**/.DS_Store']

/** Extensions indexed by default. */
export const DEFAULT_INDEX_EXTENSIONS = ['.md', '.markdown', '.txt']

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Candidate `obsidian.json` locations that list every vault the user opened. */
export function obsidianConfigPaths() {
  const paths = []
  const appData = process.env.APPDATA
  if (process.platform === 'win32' && typeof appData === 'string' && appData !== '') {
    paths.push(path.join(appData, 'obsidian', 'obsidian.json'))
  }
  const home = os.homedir()
  if (process.platform === 'darwin') {
    paths.push(path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json'))
  } else if (process.platform !== 'win32') {
    paths.push(path.join(home, '.config', 'obsidian', 'obsidian.json'))
  }
  return paths
}

/**
 * Discover Obsidian vaults from explicit configuration and Obsidian's own
 * registry. Non-existent and duplicate paths are dropped.
 *
 * @param {{ vault?: string, vaults?: string[], extra?: string[] }} [options] - explicit paths.
 * @returns {Promise<Array<{ path: string, name: string, open: boolean, sources: string[] }>>} discovered vaults.
 */
export async function discoverVaults(options = {}) {
  const found = new Map()
  const add = (candidate, source, open = false) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') return
    const abs = path.resolve(candidate.trim())
    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      return
    }
    if (!stat.isDirectory()) return
    const key = abs.toLowerCase()
    const existing = found.get(key)
    if (existing !== undefined) {
      existing.open = existing.open || open
      if (!existing.sources.includes(source)) existing.sources.push(source)
      return
    }
    found.set(key, { path: abs, name: path.basename(abs), open, sources: [source] })
  }
  add(options.vault, 'config')
  for (const entry of options.vaults ?? []) add(entry, 'config')
  for (const entry of options.extra ?? []) add(entry, 'settings')
  for (const configPath of obsidianConfigPaths()) {
    try {
      const parsed = JSON.parse(await fsp.readFile(configPath, 'utf8'))
      const vaults = parsed?.vaults
      if (vaults === null || typeof vaults !== 'object') continue
      for (const entry of Object.values(vaults)) {
        if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string') {
          add(entry.path, 'obsidian', entry.open === true)
        }
      }
    } catch {
      /* Obsidian is not installed or the registry is unreadable: not an error. */
    }
  }
  return [...found.values()]
}

/**
 * One Obsidian vault backed by the filesystem.
 */
export class ObsidianVault {
  /**
   * @param {object} options - vault configuration.
   * @param {string} options.root - absolute vault root directory.
   * @param {string} [options.name] - display name (defaults to the folder name).
   * @param {string[]} [options.excludes] - extra glob patterns to skip.
   * @param {string[]} [options.indexExtensions] - file extensions to index.
   * @param {string[]} [options.writableExtensions] - extensions this plugin may write.
   * @param {number} [options.ttlMs] - index freshness window in milliseconds.
   * @param {number} [options.maxCacheBytes] - parse-cache byte budget.
   * @param {boolean} [options.readOnly] - refuse every write when true.
   * @param {string} [options.dailyFolder] - daily-note folder override.
   * @param {string} [options.dailyFormat] - daily-note name format override.
   */
  constructor(options) {
    this.root = path.resolve(options.root)
    this.name = typeof options.name === 'string' && options.name !== '' ? options.name : path.basename(this.root)
    this.excludes = uniqueStrings([...DEFAULT_EXCLUDES, ...(options.excludes ?? [])])
    this.indexExtensions = (options.indexExtensions ?? DEFAULT_INDEX_EXTENSIONS).map((value) => value.toLowerCase())
    this.writableExtensions = (options.writableExtensions ?? this.indexExtensions).map((value) => value.toLowerCase())
    this.ttlMs = clampInt(options.ttlMs, 0, 600_000, 3000)
    this.maxCacheBytes = clampInt(options.maxCacheBytes, 1 << 20, 1 << 30, 48 * 1024 * 1024)
    this.readOnly = options.readOnly === true
    this.dailyFolder = typeof options.dailyFolder === 'string' ? options.dailyFolder : null
    this.dailyFormat = typeof options.dailyFormat === 'string' ? options.dailyFormat : null
    /** @type {Map<string, { rel: string, mtimeMs: number, size: number, ext: string }>} */
    this.files = new Map()
    /** @type {Map<string, object>} */
    this.cache = new Map()
    this.cacheBytes = 0
    this.lastScan = 0
    this.scanPromise = null
    this.warnings = []
    this.settingsCache = null
  }

  /** Compact index statistics. */
  get stats() {
    return {
      name: this.name,
      path: this.root,
      notes: this.files.size,
      readOnly: this.readOnly,
      lastScan: this.lastScan,
      cacheBytes: this.cacheBytes,
      warnings: this.warnings.slice(-3),
    }
  }

  warn(message) {
    this.warnings.push(String(message))
    if (this.warnings.length > 20) this.warnings.shift()
  }

  shouldSkipDir(name, rel) {
    if (name.startsWith('.')) return true
    return matchesAnyPattern(`${rel}/`, this.excludes)
  }

  /**
   * Refresh the metadata index when it is stale.
   *
   * @param {{ force?: boolean, signal?: AbortSignal }} [options] - refresh controls.
   * @returns {Promise<object>} {@link ObsidianVault#stats}.
   */
  async scan(options = {}) {
    throwIfAborted(options.signal)
    const fresh = this.lastScan !== 0 && Date.now() - this.lastScan < this.ttlMs
    if (options.force !== true && fresh) return this.stats
    if (this.scanPromise !== null) {
      await this.scanPromise
      return this.stats
    }
    this.scanPromise = this.walk(options.signal).finally(() => {
      this.scanPromise = null
    })
    await this.scanPromise
    return this.stats
  }

  async walk(signal) {
    const next = new Map()
    const stack = ['']
    while (stack.length > 0) {
      throwIfAborted(signal)
      const rel = stack.pop()
      const abs = rel === '' ? this.root : path.join(this.root, rel)
      let dir
      try {
        dir = await fsp.opendir(abs)
      } catch (error) {
        this.warn(`cannot read ${rel === '' ? '.' : rel}: ${error.message}`)
        continue
      }
      for await (const entry of dir) {
        const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) {
          if (this.shouldSkipDir(entry.name, entryRel)) continue
          stack.push(entryRel)
          continue
        }
        if (!entry.isFile()) continue
        if (matchesAnyPattern(entryRel, this.excludes)) continue
        const ext = path.extname(entry.name).toLowerCase()
        if (!this.indexExtensions.includes(ext)) continue
        let stat
        try {
          stat = await fsp.stat(path.join(this.root, entryRel))
        } catch {
          continue
        }
        next.set(entryRel, { rel: entryRel, mtimeMs: stat.mtimeMs, size: stat.size, ext })
      }
    }
    for (const [rel, cached] of [...this.cache]) {
      const meta = next.get(rel)
      if (meta === undefined || meta.mtimeMs !== cached.mtimeMs || meta.size !== cached.size) this.dropCache(rel)
    }
    this.files = next
    this.lastScan = Date.now()
  }

  putCache(rel, note) {
    this.dropCache(rel)
    this.cache.set(rel, note)
    this.cacheBytes += note.bytes
    while (this.cacheBytes > this.maxCacheBytes && this.cache.size > 1) {
      const oldest = this.cache.keys().next().value
      this.dropCache(oldest)
    }
  }

  dropCache(rel) {
    const entry = this.cache.get(rel)
    if (entry === undefined) return
    this.cacheBytes -= entry.bytes
    this.cache.delete(rel)
  }

  touchCache(rel, entry) {
    this.cache.delete(rel)
    this.cache.set(rel, entry)
  }

  /**
   * Read and parse one indexed note, reusing the cache while it stays valid.
   *
   * @param {string} rel - vault-relative note path.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object>} the parsed note.
   */
  async parsed(rel, signal) {
    throwIfAborted(signal)
    const meta = this.files.get(rel)
    if (meta === undefined) throw new VaultPathError(`note is not in the vault index: ${rel}`)
    const cached = this.cache.get(rel)
    if (cached !== undefined && cached.mtimeMs === meta.mtimeMs && cached.size === meta.size) {
      this.touchCache(rel, cached)
      return cached
    }
    const abs = path.join(this.root, rel)
    let text
    try {
      text = await fsp.readFile(abs, { encoding: 'utf8', signal })
    } catch (error) {
      throw new VaultPathError(`cannot read ${rel}: ${error.message}`)
    }
    const note = this.buildNote(rel, text, meta)
    this.putCache(rel, note)
    return note
  }

  buildNote(rel, text, meta) {
    const { frontmatter, body, bodyLine } = parseFrontmatter(text)
    const lines = splitLines(text)
    const headings = extractHeadings(text)
    const frontmatterTitle = frontmatter !== null && typeof frontmatter.title === 'string' ? frontmatter.title.trim() : ''
    const title = frontmatterTitle !== '' ? frontmatterTitle : (headings[0]?.text ?? stripExtension(baseName(rel), this.indexExtensions))
    const aliases = normalizeStringList(frontmatter?.aliases ?? frontmatter?.alias)
    return {
      rel,
      text,
      lines,
      lower: text.toLowerCase(),
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      frontmatter,
      body,
      bodyLine,
      title,
      aliases,
      tags: extractTags(text, frontmatter),
      links: extractLinks(text),
      headings,
      bytes: text.length * 2 + 256,
    }
  }

  /** Exact index lookup, case-insensitive; `files` defaults to the live index. */
  findFile(candidate, files = this.files) {
    const key = toPosix(candidate).replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase()
    if (key === '') return null
    for (const rel of files.keys()) {
      if (rel.toLowerCase() === key) return rel
    }
    return null
  }

  /**
   * Resolve a human note reference (path, basename, wikilink, or alias) to an
   * indexed vault-relative path.
   *
   * @param {string} name - caller-supplied note reference.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<string | null>} the vault-relative path, or null when nothing matches.
   */
  async resolveNote(name, signal) {
    if (typeof name !== 'string' || name.trim() === '') throw new ToolInputError('note must be a non-empty string')
    await this.scan({ signal })
    let candidate = name.trim()
    if (candidate.startsWith('[[') && candidate.endsWith(']]')) candidate = candidate.slice(2, -2)
    candidate = candidate.replace(/#.*$/, '').replace(/\^[^^]*$/, '').trim()
    if (candidate === '') throw new ToolInputError('note must name a file, not only a heading or block')
    for (const attempt of [candidate, ...this.indexExtensions.map((ext) => candidate + ext)]) {
      const found = this.findFile(attempt)
      if (found !== null) return found
    }
    const targetBase = stripExtension(baseName(candidate), this.indexExtensions).toLowerCase()
    if (targetBase === '') return null
    let best = null
    for (const rel of this.files.keys()) {
      if (stripExtension(baseName(rel), this.indexExtensions).toLowerCase() !== targetBase) continue
      if (best === null || rel.length < best.length) best = rel
    }
    if (best !== null) return best
    const parsedAll = await mapLimit([...this.files.keys()], 12, async (rel) => {
      try {
        return await this.parsed(rel, signal)
      } catch {
        return null
      }
    })
    const wanted = candidate.toLowerCase()
    for (const note of parsedAll) {
      if (note === null) continue
      if (note.title.toLowerCase() === wanted) return note.rel
      if (note.aliases.some((alias) => alias.toLowerCase() === wanted)) return note.rel
    }
    return null
  }

  /**
   * Resolve a wikilink target relative to the note that contains it. `files`
   * lets callers resolve against a hypothetical index (e.g. after a move).
   */
  resolveLinkTarget(target, fromRel, files = this.files) {
    for (const attempt of this.linkAttemptTargets(target, fromRel)) {
      for (const ext of ['', ...this.indexExtensions]) {
        const found = this.findFile(attempt + ext, files)
        if (found !== null) return found
      }
    }
    const clean = String(target ?? '').trim().replace(/\\/g, '/')
    if (clean === '') return fromRel
    const targetBase = stripExtension(baseName(clean), this.indexExtensions).toLowerCase()
    if (targetBase === '') return null
    let best = null
    for (const rel of files.keys()) {
      if (stripExtension(baseName(rel), this.indexExtensions).toLowerCase() !== targetBase) continue
      if (best === null || rel.length < best.length) best = rel
    }
    return best
  }

  /**
   * Resolve a wikilink target through its written path only — no basename
   * fallback. Used to tell "this link spells the note's path" apart from
   * "this link spells its name", which a move must treat differently.
   */
  resolveLinkTargetExact(target, fromRel, files = this.files) {
    for (const attempt of this.linkAttemptTargets(target, fromRel)) {
      for (const ext of ['', ...this.indexExtensions]) {
        const found = this.findFile(attempt + ext, files)
        if (found !== null) return found
      }
    }
    return null
  }

  /** The path-shaped candidates a link target tries, in resolution order. */
  linkAttemptTargets(target, fromRel) {
    const clean = String(target ?? '').trim().replace(/\\/g, '/')
    if (clean === '') return []
    const attempts = []
    const fromDir = parentFolder(fromRel)
    if (clean.startsWith('/')) attempts.push(clean.slice(1))
    else if (clean.startsWith('./') || clean.startsWith('../')) attempts.push(path.posix.normalize(path.posix.join(fromDir, clean)))
    else {
      if (fromDir !== '') attempts.push(path.posix.join(fromDir, clean))
      attempts.push(clean)
    }
    return attempts
  }

  lineMatches(note, predicate, max, contextLines) {
    const out = []
    for (let index = 0; index < note.lines.length; index += 1) {
      const line = note.lines[index]
      if (!predicate(line, line.toLowerCase())) continue
      const entry = { line: index + 1, text: truncateText(line.trim(), 300) }
      if (contextLines > 0) {
        const context = []
        const from = Math.max(0, index - contextLines)
        const to = Math.min(note.lines.length - 1, index + contextLines)
        for (let offset = from; offset <= to; offset += 1) {
          if (offset === index) continue
          context.push({ number: offset + 1, text: truncateText(note.lines[offset].trim(), 200) })
        }
        entry.context = context
      }
      out.push(entry)
      if (out.length >= max) break
    }
    return out
  }

  evaluateNote(note, options) {
    const caseSensitive = options.caseSensitive
    const text = caseSensitive ? note.text : note.lower
    const title = caseSensitive ? note.title : note.title.toLowerCase()
    const tags = note.tags.map((tag) => (caseSensitive ? tag : tag.toLowerCase()))
    const tagText = tags.join(' ')
    const { mode, maxPerFile, contextLines } = options
    let score = 0
    let matches = []

    if (mode === 'tag') {
      if (!tags.some((tag) => tag === options.tagValue)) return null
      score = 10
    } else if (mode === 'path') {
      score = 5
    } else if (mode === 'frontmatter') {
      const ok = options.frontmatterFilters.every((filter) => matchFrontmatterFilter(note.frontmatter, filter, caseSensitive))
      if (!ok) return null
      score = 7
    } else if (mode === 'title') {
      const needle = caseSensitive ? options.query : options.query.toLowerCase()
      if (needle === '' || !title.includes(needle)) return null
      score = 10 + Math.min(countOccurrences(title, needle), 10)
      matches = this.lineMatches(note, (line, lower) => (caseSensitive ? line : lower).includes(needle), maxPerFile, contextLines)
    } else if (mode === 'regex') {
      if (options.regex === null) return null
      const regex = options.regex
      matches = this.lineMatches(note, (line) => regex.test(line), maxPerFile, contextLines)
      if (matches.length === 0) return null
      score = 6 + matches.length
    } else if (mode === 'phrase') {
      const needle = caseSensitive ? options.query : options.query.toLowerCase()
      if (needle === '' || !text.includes(needle)) return null
      score = 8 + Math.min(countOccurrences(text, needle), 10)
      matches = this.lineMatches(note, (line, lower) => (caseSensitive ? line : lower).includes(needle), maxPerFile, contextLines)
    } else {
      if (options.terms.length === 0) return null
      const needles = []
      for (const term of options.terms) {
        const needle = caseSensitive ? term : term.toLowerCase()
        const inTitle = title.includes(needle)
        const inTags = tagText.includes(needle)
        const occurrences = countOccurrences(text, needle)
        if (!inTitle && !inTags && occurrences === 0) continue
        score += (inTitle ? 8 : 0) + (inTags ? 5 : 0) + Math.min(occurrences, 10)
        needles.push(needle)
      }
      const enough = mode === 'any' ? needles.length > 0 : needles.length === options.terms.length
      if (!enough) return null
      matches = this.lineMatches(
        note,
        (line, lower) => needles.some((needle) => (caseSensitive ? line : lower).includes(needle)),
        maxPerFile,
        contextLines,
      )
    }
    return { score, matches }
  }

  /**
   * Search the vault.
   *
   * @param {object} params - search parameters.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object>} ranked matches plus scan statistics.
   */
  async search(params, signal) {
    const startedAt = Date.now()
    const mode = typeof params.mode === 'string' ? params.mode : 'all'
    const query = typeof params.query === 'string' ? params.query : ''
    const caseSensitive = params.caseSensitive === true
    const limit = clampInt(params.limit, 1, 200, 25)
    const contextLines = clampInt(params.context, 0, 5, 0)
    const maxPerFile = clampInt(params.maxMatchesPerFile, 1, 50, 8)
    const tagValue = String(params.tag ?? query).trim().replace(/^#/, '').toLowerCase()
    if (mode === 'tag' && tagValue === '') throw new ToolInputError('tag search needs a tag name (query or tag)')
    if (mode === 'regex') {
      if (query === '') throw new ToolInputError('regex search needs a query')
      try {
        // eslint-disable-next-line no-new
        new RegExp(query)
      } catch (error) {
        throw new ToolInputError(`invalid regular expression: ${error.message}`)
      }
    }
    if ((mode === 'all' || mode === 'any' || mode === 'phrase' || mode === 'title') && query.trim() === '') {
      throw new ToolInputError(`mode "${mode}" needs a non-empty query`)
    }
    if (mode === 'path' && query.trim() === '') throw new ToolInputError('path search needs a glob query')
    if (mode === 'frontmatter' && query.trim() === '') throw new ToolInputError('frontmatter search needs a "key:value" query')

    await this.scan({ signal })
    let candidates = [...this.files.values()]
    if (typeof params.folder === 'string' && params.folder.trim() !== '') {
      candidates = candidates.filter((meta) => isUnderFolder(meta.rel, params.folder))
    }
    const pathFilter = typeof params.path === 'string' && params.path.trim() !== ''
      ? params.path
      : (mode === 'path' ? query : '')
    if (pathFilter !== '') {
      const matcher = globToRegExp(pathFilter)
      candidates = candidates.filter((meta) => matcher.test(meta.rel))
    }
    if (Array.isArray(params.exclude) && params.exclude.length > 0) {
      candidates = candidates.filter((meta) => !matchesAnyPattern(meta.rel, params.exclude))
    }

    const requiredTags = (Array.isArray(params.tags) ? params.tags : []).map((tag) => String(tag).replace(/^#/, '').toLowerCase())
    if (typeof params.tag === 'string' && params.tag.trim() !== '') {
      requiredTags.push(params.tag.trim().replace(/^#/, '').toLowerCase())
    }
    const options = {
      mode,
      query,
      caseSensitive,
      maxPerFile,
      contextLines,
      tagValue,
      terms: tokenizeQuery(query),
      regex: mode === 'regex' ? new RegExp(query, caseSensitive ? '' : 'i') : null,
      frontmatterFilters: parseFrontmatterFilters(query),
      requiredTags,
    }
    const parsed = await mapLimit(candidates, 12, async (meta) => {
      try {
        return await this.parsed(meta.rel, signal)
      } catch {
        return null
      }
    })
    const results = []
    let total = 0
    for (const note of parsed) {
      if (note === null) continue
      throwIfAborted(signal)
      if (options.requiredTags.length > 0) {
        const tags = note.tags.map((tag) => tag.toLowerCase())
        if (!options.requiredTags.every((tag) => tags.includes(tag))) continue
      }
      const outcome = this.evaluateNote(note, options)
      if (outcome === null) continue
      total += 1
      results.push({
        path: note.rel,
        title: note.title,
        score: outcome.score,
        tags: note.tags,
        mtimeMs: note.mtimeMs,
        matches: outcome.matches,
      })
    }
    results.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    const limited = results.slice(0, limit)
    return {
      vault: this.name,
      mode,
      query,
      matches: limited,
      total,
      truncated: total > limited.length,
      scanned: candidates.length,
      indexed: this.files.size,
      elapsedMs: Date.now() - startedAt,
    }
  }

  /**
   * Browse the vault as a flat list, a folder tree, a tag cloud, or a folder
   * list. All modes share one entry shape so the tool output stays uniform.
   *
   * @param {object} params - list parameters.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object>} entries plus totals.
   */
  async list(params, signal) {
    await this.scan({ signal })
    const mode = typeof params.mode === 'string' ? params.mode : 'tree'
    const limit = clampInt(params.limit, 1, 5000, 200)
    let files = [...this.files.values()]
    if (typeof params.folder === 'string' && params.folder.trim() !== '') {
      files = files.filter((meta) => isUnderFolder(meta.rel, params.folder))
    }
    if (typeof params.path === 'string' && params.path.trim() !== '') {
      const matcher = globToRegExp(params.path)
      files = files.filter((meta) => matcher.test(meta.rel))
    }
    if (Array.isArray(params.exclude) && params.exclude.length > 0) {
      files = files.filter((meta) => !matchesAnyPattern(meta.rel, params.exclude))
    }
    files.sort((left, right) => left.rel.localeCompare(right.rel))

    if (mode === 'tags') {
      const parsed = await mapLimit(files, 12, async (meta) => {
        try {
          return await this.parsed(meta.rel, signal)
        } catch {
          return null
        }
      })
      const counts = new Map()
      for (const note of parsed) {
        if (note === null) continue
        for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
      const entries = [...counts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, limit)
        .map(([tag, count]) => ({ path: `#${tag}`, name: tag, type: 'tag', depth: 0, count }))
      return { vault: this.name, mode, folder: params.folder ?? '', entries, total: counts.size, truncated: counts.size > entries.length, notes: this.files.size }
    }

    if (mode === 'folders') {
      const counts = new Map()
      for (const meta of files) {
        let folder = parentFolder(meta.rel)
        while (folder !== '') {
          counts.set(folder, (counts.get(folder) ?? 0) + 1)
          folder = parentFolder(folder)
        }
      }
      const entries = [...counts.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .slice(0, limit)
        .map(([folder, count]) => ({ path: folder, name: baseName(folder), type: 'folder', depth: folder.split('/').length - 1, count }))
      return { vault: this.name, mode, folder: params.folder ?? '', entries, total: counts.size, truncated: counts.size > entries.length, notes: this.files.size }
    }

    if (mode === 'flat') {
      const slice = files.slice(0, limit)
      const parsed = await mapLimit(slice, 12, async (meta) => {
        try {
          return await this.parsed(meta.rel, signal)
        } catch {
          return null
        }
      })
      const entries = slice.map((meta, index) => {
        const note = parsed[index]
        return {
          path: meta.rel,
          name: baseName(meta.rel),
          type: 'note',
          depth: meta.rel.split('/').length - 1,
          title: note === null ? stripExtension(baseName(meta.rel), this.indexExtensions) : note.title,
          tags: note === null ? [] : note.tags,
          size: meta.size,
          mtimeMs: meta.mtimeMs,
        }
      })
      return { vault: this.name, mode, folder: params.folder ?? '', entries, total: files.length, truncated: files.length > entries.length, notes: this.files.size }
    }

    const maxDepth = clampInt(params.depth, 1, 12, 3)
    const root = { path: '', name: this.name, type: 'folder', depth: 0, children: new Map(), count: files.length }
    const folders = new Map([['', root]])
    const ensureFolder = (folder) => {
      if (folder === '') return root
      const existing = folders.get(folder)
      if (existing !== undefined) return existing
      const parent = ensureFolder(parentFolder(folder))
      const node = { path: folder, name: baseName(folder), type: 'folder', depth: parent.depth + 1, children: new Map(), count: 0 }
      parent.children.set(node.name, node)
      folders.set(folder, node)
      return node
    }
    for (const meta of files) {
      const parent = ensureFolder(parentFolder(meta.rel))
      parent.children.set(baseName(meta.rel), { path: meta.rel, name: baseName(meta.rel), type: 'note', depth: parent.depth + 1, size: meta.size, mtimeMs: meta.mtimeMs })
      let folder = parentFolder(meta.rel)
      while (folder !== '') {
        const node = folders.get(folder)
        if (node !== undefined) node.count += 1
        folder = parentFolder(folder)
      }
    }
    const entries = []
    const stack = [...root.children.values()].sort(compareNodes).reverse()
    while (stack.length > 0) {
      const node = stack.pop()
      entries.push({
        path: node.path,
        name: node.name,
        type: node.type,
        depth: node.depth,
        count: node.type === 'folder' ? node.count : undefined,
        size: node.type === 'note' ? node.size : undefined,
        mtimeMs: node.type === 'note' ? node.mtimeMs : undefined,
      })
      if (node.type === 'folder' && node.depth < maxDepth) {
        const children = [...node.children.values()].sort(compareNodes).reverse()
        for (const child of children) stack.push(child)
      }
    }
    const limited = entries.slice(0, limit)
    return {
      vault: this.name,
      mode: 'tree',
      folder: params.folder ?? '',
      entries: limited.map((entry) => ({
        path: entry.path,
        name: entry.name,
        type: entry.type,
        depth: entry.depth,
        count: entry.count ?? null,
        size: entry.size ?? null,
        mtimeMs: entry.mtimeMs ?? null,
      })),
      total: entries.length,
      truncated: entries.length > limited.length,
      notes: this.files.size,
    }
  }

  async backlinksFor(rel, signal, limit) {
    const sources = [...this.files.keys()].filter((candidate) => candidate !== rel)
    const parsed = await mapLimit(sources, 12, async (candidate) => {
      try {
        return await this.parsed(candidate, signal)
      } catch {
        return null
      }
    })
    const incoming = []
    for (const note of parsed) {
      if (note === null) continue
      for (const link of note.links) {
        if (this.resolveLinkTarget(link.target, note.rel) !== rel) continue
        incoming.push({ path: note.rel, title: note.title, line: link.line, alias: link.alias })
        break
      }
      if (incoming.length >= limit) break
    }
    return incoming
  }

  /**
   * Read one note, optionally windowed, with its metadata.
   *
   * @param {object} params - read parameters.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object>} the note view.
   */
  async readNote(params, signal) {
    const rel = await this.resolveNote(params.note, signal)
    if (rel === null) throw new ToolInputError(`note not found in vault "${this.name}": ${params.note}`)
    const note = await this.parsed(rel, signal)
    const offset = clampInt(params.offset, 1, 1_000_000, 1)
    const limit = params.limit === undefined ? note.lines.length : clampInt(params.limit, 1, 5000, note.lines.length)
    const slice = note.lines.slice(offset - 1, offset - 1 + limit)
    const backlinks = params.backlinks === true ? await this.backlinksFor(rel, signal, 20) : null
    return {
      path: rel,
      title: note.title,
      aliases: note.aliases,
      exists: true,
      totalLines: note.lines.length,
      offset,
      lines: slice.map((text, index) => ({ number: offset + index, text })),
      truncated: offset - 1 + slice.length < note.lines.length,
      frontmatter: note.frontmatter,
      tags: note.tags,
      headings: note.headings,
      links: note.links.slice(0, 50).map((link) => {
        const target = this.resolveLinkTarget(link.target, rel)
        return {
          target: link.target,
          path: target,
          title: target === null ? null : (this.cache.get(target)?.title ?? stripExtension(baseName(target), this.indexExtensions)),
          alias: link.alias,
          heading: link.heading,
          embed: link.embed,
          line: link.line,
        }
      }),
      backlinks,
      size: note.size,
      mtimeMs: note.mtimeMs,
    }
  }

  /**
   * Link neighbourhood of one note.
   *
   * @param {object} params - link parameters.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object>} outgoing, incoming, and unresolved links.
   */
  async links(params, signal) {
    await this.scan({ signal })
    const rel = await this.resolveNote(params.note, signal)
    if (rel === null) throw new ToolInputError(`note not found in vault "${this.name}": ${params.note}`)
    const direction = typeof params.direction === 'string' ? params.direction : 'both'
    const limit = clampInt(params.limit, 1, 500, 100)
    const note = await this.parsed(rel, signal)
    const outgoing = []
    const unresolved = []
    if (direction !== 'incoming') {
      for (const link of note.links) {
        const target = this.resolveLinkTarget(link.target, rel)
        const entry = {
          target: link.target,
          path: target,
          title: target === null ? null : (this.cache.get(target)?.title ?? stripExtension(baseName(target), this.indexExtensions)),
          alias: link.alias,
          heading: link.heading,
          embed: link.embed,
          line: link.line,
        }
        if (target === null) unresolved.push(entry)
        else outgoing.push(entry)
        if (outgoing.length + unresolved.length >= limit) break
      }
    }
    const incoming = direction === 'outgoing' ? [] : await this.backlinksFor(rel, signal, limit)
    return {
      vault: this.name,
      note: rel,
      title: note.title,
      outgoing: outgoing.slice(0, limit),
      incoming: incoming.map((entry) => ({
        target: rel,
        path: entry.path,
        title: entry.title,
        alias: entry.alias,
        heading: null,
        embed: false,
        line: entry.line,
      })),
      unresolved: unresolved.slice(0, limit),
      total: outgoing.length + incoming.length + unresolved.length,
    }
  }

  normalizeNewPath(name) {
    let value = String(name ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
    if (value.startsWith('[[') && value.endsWith(']]')) value = value.slice(2, -2)
    value = value.replace(/#.*$/, '').trim().replace(/\/+$/, '')
    if (value === '' || /^\.+$/.test(value)) throw new ToolInputError('note path must name a file, not a folder')
    if (path.posix.extname(value) === '') value += '.md'
    const reason = unusableFileName(value)
    if (reason !== null) throw new ToolInputError(`cannot use that note path: ${reason} (${value})`)
    const { rel } = resolveInside(this.root, value)
    return rel
  }

  /**
   * Create or update a note with an atomic write.
   *
   * @param {object} params - write parameters.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object>} the applied (or previewed) change.
   */
  async writeNote(params, signal) {
    if (this.readOnly) throw new ToolInputError(`vault "${this.name}" is read-only (config readOnly: true)`)
    // A write with no explicit mode creates a new note, but a content-free call
    // (frontmatter-only update) updates the existing note instead of failing.
    const requestedMode = typeof params.mode === 'string'
      ? params.mode
      : (typeof params.content === 'string' ? 'create' : 'overwrite')
    const dryRun = params.dryRun === true
    await this.scan({ signal })

    // Resolve the target deterministically: a reference containing a path
    // separator is taken as an exact path (creating it when missing), while a
    // bare name may resolve to an existing note by file name, wikilink target,
    // or alias. Fuzzy matching must never retarget an explicit path — that
    // would silently write into a different note with the same basename.
    const reference = String(params.note ?? '').trim()
    const explicit = this.normalizeNewPath(reference)
    let rel = this.findFile(explicit)
    if (rel === null && !/[\\/]/.test(reference)) {
      rel = await this.resolveNote(reference, signal)
    }
    if (rel === null) rel = explicit
    const { rel: safeRel, abs } = resolveInside(this.root, rel)
    const ext = path.extname(safeRel).toLowerCase()
    if (!this.writableExtensions.includes(ext)) {
      throw new ToolInputError(`extension "${ext}" is not writable in this vault (writable: ${this.writableExtensions.join(', ')})`)
    }

    let oldText = null
    try {
      oldText = await fsp.readFile(abs, { encoding: 'utf8', signal })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new ToolInputError(`cannot read ${safeRel}: ${error.message}`)
    }
    const exists = oldText !== null

    let effectiveMode = requestedMode
    if (requestedMode === 'create' && exists) {
      const ifExists = typeof params.ifExists === 'string' ? params.ifExists : 'error'
      if (ifExists === 'error') {
        throw new ToolInputError(`note already exists: ${safeRel} (pass ifExists: "append", "overwrite", or "skip")`)
      }
      if (ifExists === 'skip') {
        const parsedSkipped = parseFrontmatter(oldText)
        return {
          path: safeRel,
          created: false,
          skipped: true,
          dryRun,
          mode: requestedMode,
          requestedMode,
          previousExists: true,
          bytes: Buffer.byteLength(oldText, 'utf8'),
          lines: splitLines(oldText).length,
          frontmatter: parsedSkipped.frontmatter,
          diff: null,
        }
      }
      effectiveMode = ifExists === 'append' ? 'append' : 'overwrite'
    }

    const parsedOld = oldText === null ? { frontmatter: null, body: '' } : parseFrontmatter(oldText)
    let frontmatter = parsedOld.frontmatter
    let content = typeof params.content === 'string' ? params.content : null
    // create/overwrite: the supplied content owns the frontmatter block. A block
    // inside the content is lifted out (so it is never written twice), and
    // content without one clears the previous frontmatter unless the caller
    // merged keys explicitly.
    if ((effectiveMode === 'create' || effectiveMode === 'overwrite') && content !== null) {
      const parsedContent = parseFrontmatter(content)
      if (parsedContent.frontmatter !== null) {
        content = parsedContent.body
        if (params.frontmatter === undefined || params.frontmatter === null) frontmatter = parsedContent.frontmatter
      } else if (params.frontmatter === undefined || params.frontmatter === null) {
        frontmatter = null
      }
    }
    if (params.frontmatter !== undefined && params.frontmatter !== null) {
      const merged = { ...(frontmatter ?? {}) }
      for (const [key, value] of Object.entries(params.frontmatter)) {
        if (value === null) delete merged[key]
        else merged[key] = value
      }
      frontmatter = Object.keys(merged).length > 0 ? merged : null
    }

    const bodyContent = content ?? ''
    let body = parsedOld.body
    if (effectiveMode === 'create' || effectiveMode === 'overwrite') {
      if (content !== null) body = content
    } else if (effectiveMode === 'append') {
      body = joinBlocks(body, bodyContent)
    } else if (effectiveMode === 'prepend') {
      body = joinBlocks(bodyContent, body)
    } else if (effectiveMode === 'insert') {
      const heading = typeof params.heading === 'string' ? params.heading : ''
      const lines = splitLines(body)
      const section = findHeadingSection(lines, heading)
      if (section === null) {
        const fallback = typeof params.headingFallback === 'string' ? params.headingFallback : 'end'
        if (fallback === 'error') throw new ToolInputError(`heading not found in ${safeRel}: ${heading}`)
        body = joinBlocks(body, bodyContent)
      } else {
        body = insertAtLine(lines, section.insertIndex, bodyContent).join('\n')
      }
    } else {
      throw new ToolInputError(`unsupported mode: ${requestedMode}`)
    }

    const trimmedBody = body.replace(/^\n+/, '')
    let newText = frontmatter !== null ? `${stringifyFrontmatter(frontmatter)}${trimmedBody}` : trimmedBody
    const endsWithNewline = oldText === null ? true : oldText.endsWith('\n')
    if (endsWithNewline && newText !== '' && !newText.endsWith('\n')) newText += '\n'
    if (newText !== '' && !endsWithNewline) newText = newText.replace(/\n+$/, '')

    const result = {
      path: safeRel,
      created: !exists,
      skipped: false,
      dryRun,
      mode: effectiveMode,
      requestedMode,
      previousExists: exists,
      bytes: Buffer.byteLength(newText, 'utf8'),
      lines: splitLines(newText).length,
      frontmatter: frontmatter ?? null,
      diff: {
        oldText: oldText === null ? null : truncateText(oldText, 100_000),
        newText: truncateText(newText, 100_000),
      },
    }
    if (dryRun) return result

    await this.atomicWrite(abs, newText, safeRel, signal)
    const stat = await fsp.stat(abs)
    this.files.set(safeRel, { rel: safeRel, mtimeMs: stat.mtimeMs, size: stat.size, ext: path.extname(safeRel).toLowerCase() })
    this.dropCache(safeRel)
    return result
  }

  /**
   * Write text to an absolute path atomically: same-directory temp file plus a
   * rename, cleaning the temp file up when anything fails. The vault index is
   * not touched here.
   */
  async atomicWrite(abs, text, label, signal) {
    await fsp.mkdir(path.dirname(abs), { recursive: true }).catch((error) => {
      throw new ToolInputError(`cannot create the folder for ${label}: ${describeFsError(error)}`)
    })
    const tmp = `${abs}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`
    try {
      await fsp.writeFile(tmp, text, { encoding: 'utf8', signal })
      try {
        await fsp.rename(tmp, abs)
      } catch {
        await fsp.rm(abs, { force: true })
        await fsp.rename(tmp, abs)
      }
    } catch (error) {
      // Cancellation must stay a cancellation; everything else is a clean,
      // self-correctable tool error. The temp file never survives the attempt.
      await fsp.rm(tmp, { force: true }).catch(() => {})
      if (error?.name === 'AbortError') throw error
      throw new ToolInputError(`cannot write ${label}: ${describeFsError(error)}`)
    }
  }

  /**
   * The target text that still resolves to `destRel` under `files`, following
   * Obsidian's "shortest path when possible" convention: the bare name when it
   * is unambiguous, the full extension-less vault path otherwise.
   */
  idealLinkTargetFor(destRel, files) {
    const displayStem = stripExtension(baseName(destRel), this.indexExtensions)
    const stem = displayStem.toLowerCase()
    let sameStem = 0
    for (const rel of files.keys()) {
      if (stripExtension(baseName(rel), this.indexExtensions).toLowerCase() === stem) sameStem += 1
    }
    return sameStem <= 1 ? displayStem : stripExtension(destRel, this.indexExtensions)
  }

  /**
   * Normalize a model-supplied move destination into a vault-relative file path.
   *
   * Accepted shapes: a folder (trailing `/` or an existing directory) keeps the
   * source file name; a path with an extension is used exactly; anything else
   * is a file path (extension appended, same folder as the source when the
   * reference carries no folder part).
   */
  normalizeMoveTarget(value, sourceRel) {
    let raw = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
    if (raw.startsWith('[[') && raw.endsWith(']]')) raw = raw.slice(2, -2)
    raw = raw.trim()
    if (raw === '') throw new ToolInputError('move needs a destination in "to"')
    const sourceExt = path.posix.extname(sourceRel)
    let candidate = raw.replace(/\/+$/, '')
    const folderIntent = raw.endsWith('/') || (candidate !== '' && this.isExistingFolder(candidate))
    if (folderIntent) {
      candidate = candidate === '' ? baseName(sourceRel) : `${candidate}/${baseName(sourceRel)}`
    } else if (path.posix.extname(candidate) === '') {
      const stem = candidate + sourceExt
      candidate = candidate.includes('/') ? stem : (parentFolder(sourceRel) === '' ? stem : `${parentFolder(sourceRel)}/${stem}`)
    }
    if (candidate.split('/').some((segment) => segment.startsWith('.'))) {
      throw new ToolInputError(`move destination must not live in a dot folder: ${candidate}`)
    }
    return this.normalizeNewPath(candidate)
  }

  /** Whether `rel` names an existing directory inside the vault. */
  isExistingFolder(rel) {
    try {
      return fs.statSync(path.join(this.root, rel)).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * Plan the link rewrites a move requires: one entry per link occurrence that
   * would stop resolving (or change meaning) once `sourceRel` becomes
   * `destRel`. Entries are grouped per file, already keyed by the file's
   * post-move path (the moved note itself rewrites at its destination).
   *
   * @returns {Promise<Array<{ path: string, entries: Array<{ line: number, before: string, after: string }> }>>}
   */
  async planLinkRewrites(sourceRel, destRel, signal) {
    const before = this.files
    const after = new Map(before)
    after.delete(sourceRel)
    after.set(destRel, before.get(sourceRel))
    /** @type {Map<string, Array<{ line: number, before: string, after: string }>>} */
    const groups = new Map()
    const push = (path, entry) => {
      const list = groups.get(path)
      if (list === undefined) groups.set(path, [entry])
      else list.push(entry)
    }
    for (const rel of before.keys()) {
      const note = await this.parsed(rel, signal).catch(() => null)
      if (note === null) continue
      const isMovedNote = rel === sourceRel
      for (const link of note.links) {
        // A link that spells a path (any separator) is rewritten when that path
        // stops pointing at the note; a bare-name link is rewritten only when
        // it stops resolving to the moved note outright.
        const spellsPath = /[\\/]/.test(link.target)
        if (isMovedNote) {
          // Links inside the moved note: relative targets change meaning.
          const meant = this.resolveLinkTarget(link.target, sourceRel, before)
          if (meant === null || meant === sourceRel) continue
          const stale = spellsPath
            ? this.resolveLinkTargetExact(link.target, destRel, after) !== meant
            : this.resolveLinkTarget(link.target, destRel, after) !== meant
          if (!stale) continue
          const target = link.kind === 'markdown'
            ? encodeURI(markdownRelative(parentFolder(destRel), meant))
            : this.idealLinkTargetFor(meant, after)
          push(destRel, { line: link.line, before: link.raw, after: rebuildLink(link, target) })
          continue
        }
        if (this.resolveLinkTarget(link.target, rel, before) !== sourceRel) continue
        const stale = spellsPath
          ? this.resolveLinkTargetExact(link.target, rel, after) !== destRel
          : this.resolveLinkTarget(link.target, rel, after) !== destRel
        if (!stale) continue
        const target = link.kind === 'markdown'
          ? encodeURI(markdownRelative(parentFolder(rel), destRel))
          : this.idealLinkTargetFor(destRel, after)
        push(rel, { line: link.line, before: link.raw, after: rebuildLink(link, target) })
      }
    }
    return [...groups.entries()].map(([path, entries]) => ({ path, entries }))
  }

  /** Apply planned link rewrites to one file and refresh its index entry. */
  async applyRewrites(rel, entries, signal) {
    const abs = path.join(this.root, rel)
    const text = await fsp.readFile(abs, { encoding: 'utf8', signal })
    const strippedLines = stripCodeBlocks(text).split('\n')
    const rawLines = text.split('\n')
    let changed = false
    for (const entry of entries) {
      const index = entry.line - 1
      if (index < 0 || index >= rawLines.length) continue
      const rewritten = replaceLinkOnLine(rawLines[index], strippedLines[index] ?? '', entry.before, entry.after)
      if (rewritten !== rawLines[index]) {
        rawLines[index] = rewritten
        changed = true
      }
    }
    if (!changed) return false
    await this.atomicWrite(abs, rawLines.join('\n'), rel, signal)
    const stat = await fsp.stat(abs)
    this.files.set(rel, { rel, mtimeMs: stat.mtimeMs, size: stat.size, ext: path.extname(rel).toLowerCase() })
    this.dropCache(rel)
    return true
  }

  /**
   * Move or rename one note inside the vault, optionally rewriting the links
   * that reference it (and the moved note's own relative links) so they keep
   * resolving — the filesystem equivalent of Obsidian's rename with link
   * updates.
   *
   * @param {object} params - move parameters (`note`, `to`, `updateLinks`, `dryRun`).
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object>} the applied (or previewed) move.
   */
  async moveNote(params, signal) {
    if (this.readOnly) throw new ToolInputError(`vault "${this.name}" is read-only (config readOnly: true)`)
    const dryRun = params.dryRun === true
    const updateLinks = params.updateLinks !== false
    await this.scan({ signal })

    const sourceRel = await this.resolveNote(String(params.note ?? '').trim(), signal)
    if (sourceRel === null) throw new ToolInputError(`note not found in vault "${this.name}": ${params.note}`)
    const destRel = this.normalizeMoveTarget(params.to, sourceRel)
    if (destRel.toLowerCase() === sourceRel.toLowerCase()) {
      throw new ToolInputError(`destination is the same as the source: ${destRel}`)
    }
    const destExt = path.posix.extname(destRel).toLowerCase()
    if (!this.writableExtensions.includes(destExt)) {
      throw new ToolInputError(`extension "${destExt}" is not writable in this vault (writable: ${this.writableExtensions.join(', ')})`)
    }
    let destExists = this.findFile(destRel) !== null
    if (!destExists) {
      destExists = await fsp.access(path.join(this.root, destRel)).then(() => true, () => false)
    }
    if (destExists) throw new ToolInputError(`destination already exists: ${destRel}`)

    const groups = updateLinks ? await this.planLinkRewrites(sourceRel, destRel, signal) : []
    const rewrites = groups.flatMap((group) => group.entries.map((entry) => ({ path: group.path, ...entry })))
    const result = {
      vault: this.name,
      from: sourceRel,
      to: destRel,
      renamed: baseName(sourceRel) !== baseName(destRel),
      moved: parentFolder(sourceRel) !== parentFolder(destRel),
      dryRun,
      updateLinks,
      linksUpdated: rewrites.length,
      filesUpdated: groups.length,
      rewrites: rewrites.slice(0, 50),
      rewritesTruncated: rewrites.length > 50,
    }
    if (dryRun) return result

    const sourceAbs = path.join(this.root, sourceRel)
    const destAbs = path.join(this.root, destRel)
    await fsp.mkdir(path.dirname(destAbs), { recursive: true }).catch((error) => {
      throw new ToolInputError(`cannot create the folder for ${destRel}: ${describeFsError(error)}`)
    })
    try {
      await fsp.rename(sourceAbs, destAbs)
    } catch (error) {
      throw new ToolInputError(`cannot move ${sourceRel} to ${destRel}: ${describeFsError(error)}`)
    }
    this.files.delete(sourceRel)
    this.dropCache(sourceRel)
    const stat = await fsp.stat(destAbs)
    this.files.set(destRel, { rel: destRel, mtimeMs: stat.mtimeMs, size: stat.size, ext: destExt })

    for (const group of groups) {
      await this.applyRewrites(group.path, group.entries, signal)
    }
    return result
  }

  /**
   * Remove one note. By default it moves into the vault's `.trash/` folder
   * (mirroring Obsidian's local trash, recoverable by hand); `permanent: true`
   * deletes the file outright. Either way the note's inbound links are
   * reported: they will dangle afterwards.
   *
   * @param {object} params - delete parameters (`note`, `permanent`, `dryRun`).
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object>} the applied (or previewed) deletion.
   */
  async deleteNote(params, signal) {
    if (this.readOnly) throw new ToolInputError(`vault "${this.name}" is read-only (config readOnly: true)`)
    const dryRun = params.dryRun === true
    const permanent = params.permanent === true
    await this.scan({ signal })

    const rel = await this.resolveNote(String(params.note ?? '').trim(), signal)
    if (rel === null) throw new ToolInputError(`note not found in vault "${this.name}": ${params.note}`)

    const backlinks = []
    for (const candidate of this.files.keys()) {
      if (candidate === rel) continue
      const note = await this.parsed(candidate, signal).catch(() => null)
      if (note === null) continue
      for (const link of note.links) {
        if (this.resolveLinkTarget(link.target, candidate) === rel) {
          backlinks.push({ path: candidate, title: note.title, line: link.line })
          break
        }
      }
    }

    let trashTarget = null
    if (!permanent) trashTarget = await this.trashTarget(rel, signal)
    const result = {
      vault: this.name,
      path: rel,
      permanent,
      trashTarget,
      dryRun,
      backlinkCount: backlinks.length,
      backlinks: backlinks.slice(0, 20),
      backlinksTruncated: backlinks.length > 20,
    }
    if (dryRun) return result

    const abs = path.join(this.root, rel)
    if (permanent) {
      try {
        await fsp.rm(abs, { force: true, signal })
      } catch (error) {
        throw new ToolInputError(`cannot delete ${rel}: ${describeFsError(error)}`)
      }
    } else {
      const trashAbs = path.join(this.root, trashTarget)
      try {
        await fsp.mkdir(path.dirname(trashAbs), { recursive: true })
        await fsp.rename(abs, trashAbs)
      } catch (error) {
        throw new ToolInputError(`cannot move ${rel} to the trash: ${describeFsError(error)}`)
      }
    }
    this.files.delete(rel)
    this.dropCache(rel)
    return result
  }

  /** Vault-relative trash path for a note, collision-safe. */
  async trashTarget(rel, signal) {
    throwIfAborted(signal)
    const ext = path.posix.extname(rel)
    const base = `.trash/${rel}`
    let candidate = base
    let suffix = 0
    for (;;) {
      const taken = await fsp.access(path.join(this.root, candidate)).then(() => true, () => false)
      if (!taken) return candidate
      suffix += 1
      candidate = `.trash/${stripExtension(rel, [ext])}.${suffix}${ext}`
    }
  }

  /** Read this vault's Obsidian settings, cached for the plugin's lifetime. */
  async settings() {
    if (this.settingsCache !== null) return this.settingsCache
    const read = async (name) => {
      try {
        return JSON.parse(await fsp.readFile(path.join(this.root, '.obsidian', name), 'utf8'))
      } catch {
        return null
      }
    }
    const [app, daily, templates] = await Promise.all([read('app.json'), read('daily-notes.json'), read('templates.json')])
    this.settingsCache = { app, daily, templates }
    return this.settingsCache
  }

  /** Vault-relative path of a daily note, honoring Obsidian's own settings. */
  async dailyPath(dateValue, signal) {
    throwIfAborted(signal)
    const settings = await this.settings()
    const format = this.dailyFormat ?? (typeof settings.daily?.format === 'string' ? settings.daily.format : 'YYYY-MM-DD')
    const folder = this.dailyFolder ?? (typeof settings.daily?.folder === 'string' ? settings.daily.folder : '')
    const date = parseDateArgument(dateValue)
    const name = formatDate(date, format)
    const candidate = folder === '' ? `${name}.md` : `${folder.replace(/\/+$/, '')}/${name}.md`
    const { rel } = resolveInside(this.root, candidate)
    return rel
  }

  /** Compact description of this vault for the status tool. */
  async vaultInfo(signal) {
    await this.scan({ signal })
    const folders = new Set()
    for (const meta of this.files.keys()) {
      let folder = parentFolder(meta)
      while (folder !== '') {
        folders.add(folder)
        folder = parentFolder(folder)
      }
    }
    const settings = await this.settings()
    return {
      name: this.name,
      path: this.root,
      notes: this.files.size,
      folders: folders.size,
      readOnly: this.readOnly,
      dailyFolder: this.dailyFolder ?? (typeof settings.daily?.folder === 'string' ? settings.daily.folder : ''),
      dailyFormat: this.dailyFormat ?? (typeof settings.daily?.format === 'string' ? settings.daily.format : 'YYYY-MM-DD'),
      lastScan: this.lastScan,
      warnings: this.warnings.slice(-3),
    }
  }
}

function compareNodes(left, right) {
  if (left.type !== right.type) return left.type === 'folder' ? -1 : 1
  return left.name.localeCompare(right.name)
}

/**
 * Rebuild one link occurrence around a new target, preserving the parts the
 * author wrote (embed marker, heading, block, alias). Wikilinks keep their
 * syntax; markdown links are rebuilt as `[alias](href)`.
 */
function rebuildLink(link, target) {
  if (link.kind === 'markdown') {
    return `[${link.alias ?? ''}](${target})`
  }
  const inner = `${target}${link.heading === null ? '' : `#${link.heading}`}${link.block === null ? '' : `^${link.block}`}${link.alias === null ? '' : `|${link.alias}`}`
  return `${link.embed ? '!' : ''}[[${inner}]]`
}

/** A markdown-link href from the folder of the linking note to a vault-relative path. */
function markdownRelative(fromFolder, relPath) {
  const href = path.posix.relative(fromFolder === '' ? '.' : fromFolder, relPath).replace(/\\/g, '/')
  return href.startsWith('./') || href.startsWith('../') ? href : `./${href}`
}

function normalizeStringList(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter((entry) => entry !== '')
  if (typeof value === 'string') return value.split(/[,\s]+/).map((entry) => entry.trim()).filter((entry) => entry !== '')
  return []
}

function parseFrontmatterFilters(query) {
  const parts = String(query ?? '').match(/"[^"]*"|\S+/g) ?? []
  return parts.map((part) => {
    const index = part.indexOf(':')
    if (index === -1) return { key: part.replace(/"/g, ''), value: null }
    return { key: part.slice(0, index).replace(/"/g, ''), value: part.slice(index + 1).replace(/^"|"$/g, '') }
  })
}

function matchFrontmatterFilter(frontmatter, filter, caseSensitive) {
  if (frontmatter === null || typeof frontmatter !== 'object') return false
  const key = Object.keys(frontmatter).find((candidate) => (
    caseSensitive ? candidate === filter.key : candidate.toLowerCase() === filter.key.toLowerCase()
  ))
  if (key === undefined) return false
  const raw = frontmatter[key]
  if (filter.value === null) return raw !== null && raw !== undefined
  const values = Array.isArray(raw) ? raw.map((entry) => String(entry)) : [String(raw ?? '')]
  const wanted = caseSensitive ? filter.value : filter.value.toLowerCase()
  return values.some((entry) => (caseSensitive ? entry : entry.toLowerCase()).includes(wanted))
}

function parseDateArgument(value) {
  if (value === undefined || value === null || value === '') return new Date()
  if (typeof value !== 'string') throw new ToolInputError('date must be a string like "2026-10-10"')
  const trimmed = value.trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (match !== null) {
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    if (Number.isNaN(date.getTime())) throw new ToolInputError(`invalid date: ${value}`)
    return date
  }
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) throw new ToolInputError(`invalid date: ${value}`)
  return parsed
}

/** Format a date with the Obsidian daily-note token subset. */
export function formatDate(date, format) {
  const pad = (value) => String(value).padStart(2, '0')
  const tokens = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MMMM: MONTH_NAMES[date.getMonth()],
    MMM: MONTH_NAMES[date.getMonth()].slice(0, 3),
    MM: pad(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    DD: pad(date.getDate()),
    D: String(date.getDate()),
    dddd: DAY_NAMES[date.getDay()],
    ddd: DAY_NAMES[date.getDay()].slice(0, 3),
    HH: pad(date.getHours()),
    H: String(date.getHours()),
    mm: pad(date.getMinutes()),
    m: String(date.getMinutes()),
    ss: pad(date.getSeconds()),
    s: String(date.getSeconds()),
  }
  return String(format ?? 'YYYY-MM-DD').replace(/YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm|m|ss|s/g, (token) => tokens[token] ?? token)
}
