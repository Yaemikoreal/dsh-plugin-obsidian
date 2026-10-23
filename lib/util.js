/**
 * Shared helpers for dsh-plugin-obsidian.
 *
 * Everything here is dependency-free (node: builtins only) so the plugin keeps
 * working when it is installed into a profile as a linked local checkout, where
 * bare `@deepseek-ai/*` imports would not resolve from the checkout's own path.
 *
 * @module dsh-plugin-obsidian/util
 */

import path from 'node:path'

/** Invalid or missing model-supplied argument. Surfaces as a tool error. */
export class ToolInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ToolInputError'
  }
}

/** A path that escapes the vault root or is not usable as a note path. */
export class VaultPathError extends Error {
  constructor(message) {
    super(message)
    this.name = 'VaultPathError'
  }
}

/** Escape one literal string for embedding in a RegExp source. */
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile a small glob (`*`, `**`, `?`, `{a,b}`) into an anchored RegExp.
 * Paths are matched in posix form, always case-insensitively on Windows-style
 * vaults (Obsidian itself is case-insensitive about note names).
 *
 * @param {string} pattern - glob pattern, using `/` separators.
 * @returns {RegExp} anchored, case-insensitive matcher.
 */
export function globToRegExp(pattern) {
  const source = String(pattern ?? '').replace(/\\/g, '/')
  let out = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '*') {
      if (source[index + 1] === '*') {
        index += 1
        if (source[index + 1] === '/') {
          index += 1
          out += '(?:[^/]+/)*'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    if (char === '{') {
      const close = source.indexOf('}', index)
      if (close === -1) {
        out += '\\{'
        continue
      }
      const alternatives = source
        .slice(index + 1, close)
        .split(',')
        .map((entry) => escapeRegExp(entry.trim()))
      out += `(?:${alternatives.join('|')})`
      index = close
      continue
    }
    out += escapeRegExp(char)
  }
  return new RegExp(`^${out}$`, 'i')
}

/**
 * Whether a posix-style relative path matches any glob in the list.
 *
 * @param {string} relative - vault-relative path in posix form.
 * @param {readonly string[]} patterns - glob patterns.
 * @returns {boolean} true when at least one pattern matches.
 */
export function matchesAnyPattern(relative, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  const value = toPosix(relative)
  return patterns.some((pattern) => globToRegExp(pattern).test(value))
}

/** Convert a platform path to forward slashes. */
export function toPosix(value) {
  return String(value).replace(/\\/g, '/')
}

/** Return the vault-relative posix parent folder ('' for vault root). */
export function parentFolder(relative) {
  const value = toPosix(relative)
  const index = value.lastIndexOf('/')
  return index === -1 ? '' : value.slice(0, index)
}

/** Return the file name of a vault-relative posix path. */
export function baseName(relative) {
  const value = toPosix(relative)
  const index = value.lastIndexOf('/')
  return index === -1 ? value : value.slice(index + 1)
}

/** Strip a known text extension from a note name. */
export function stripExtension(relative, extensions = ['.md', '.markdown', '.txt']) {
  const value = toPosix(relative)
  const lower = value.toLowerCase()
  for (const extension of extensions) {
    if (lower.endsWith(extension)) return value.slice(0, value.length - extension.length)
  }
  return value
}

/** Whether `relative` is the folder itself or lives inside it. */
export function isUnderFolder(relative, folder) {
  const value = toPosix(relative)
  const target = toPosix(folder).replace(/^\/+/, '').replace(/\/+$/, '')
  if (target === '') return true
  return value === target || value.startsWith(`${target}/`)
}

/**
 * Resolve a model-supplied note path inside a vault root, refusing absolute
 * paths and any traversal that would leave the vault.
 *
 * @param {string} root - absolute vault root.
 * @param {string} relative - caller-supplied note path.
 * @returns {{ rel: string, abs: string }} vault-relative posix path and absolute path.
 * @throws {VaultPathError} when the path is empty, absolute, or escapes the vault.
 */
export function resolveInside(root, relative) {
  if (typeof relative !== 'string' || relative.trim() === '') {
    throw new VaultPathError('note path must be a non-empty string')
  }
  if (relative.includes('\0')) {
    throw new VaultPathError('note path must not contain NUL bytes')
  }
  let cleaned = toPosix(relative).trim()
  if (/^[A-Za-z]:/.test(cleaned) || cleaned.startsWith('//')) {
    throw new VaultPathError(`absolute paths are not allowed inside a vault: ${relative}`)
  }
  cleaned = cleaned.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/')
  const abs = path.resolve(root, cleaned)
  const rest = path.relative(root, abs)
  // `..foo.md` is a legal file name inside the vault; only a real parent hop
  // (`..` itself or a `../` segment) escapes it.
  if (rest === '' || rest === '..' || rest.startsWith(`..${path.sep}`) || path.isAbsolute(rest)) {
    throw new VaultPathError(`path escapes the vault: ${relative}`)
  }
  return { rel: toPosix(rest), abs }
}

/** Windows device names are not usable as file names, whatever the extension. */
const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Whether a vault-relative file name is unusable on the current platform.
 *
 * @param {string} relative - vault-relative posix path.
 * @returns {string | null} a human reason, or null when the name is fine.
 */
export function unusableFileName(relative) {
  const name = baseName(relative)
  if (name === '' || /^\.+$/.test(name)) return 'a note needs a real file name'
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) return 'the file name contains characters this filesystem rejects'
  if (process.platform === 'win32' && WINDOWS_DEVICE_NAMES.test(name)) return 'the file name is reserved by Windows'
  if (name.endsWith('.') || name.endsWith(' ')) return 'the file name must not end with a dot or a space'
  return null
}

/** Turn a filesystem error into an actionable message. */
export function describeFsError(error) {
  switch (error?.code) {
    case 'EEXIST':
    case 'ENOTDIR':
      return 'a file in that path is not a directory'
    case 'EISDIR':
      return 'that path is a directory'
    case 'EACCES':
    case 'EPERM':
      return 'permission denied'
    case 'EROFS':
      return 'the filesystem is read-only'
    case 'ENOSPC':
      return 'no space left on the device'
    case 'ENAMETOOLONG':
      return 'the path is too long'
    default:
      return error?.message ?? String(error)
  }
}

/** Clamp an optional integer argument into a range with a fallback. */
export function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const integer = Math.trunc(value)
  if (integer < min) return min
  if (integer > max) return max
  return integer
}

/** Truncate text to a byte-ish character budget with an explicit marker. */
export function truncateText(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n… [truncated ${value.length - max} characters]`
}

/** Count non-overlapping occurrences of a plain (already lower-cased) needle. */
export function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** Deduplicate strings, preserving the first occurrence. */
export function uniqueStrings(values) {
  const seen = new Set()
  const out = []
  for (const value of values ?? []) {
    if (typeof value !== 'string' || value === '') continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/** Run an async mapper over items with bounded concurrency, preserving order. */
export async function mapLimit(items, limit, mapper) {
  const list = Array.from(items)
  const size = Math.max(1, Math.min(limit, list.length || 1))
  const results = new Array(list.length)
  let cursor = 0
  const workers = new Array(size).fill(undefined).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= list.length) return
      results[index] = await mapper(list[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** Split a query into terms, honoring double-quoted phrases. */
export function tokenizeQuery(query) {
  const terms = []
  const source = String(query ?? '')
  const pattern = /"([^"]+)"|(\S+)/g
  let match = pattern.exec(source)
  while (match !== null) {
    const value = (match[1] ?? match[2] ?? '').trim()
    if (value !== '') terms.push(value)
    match = pattern.exec(source)
  }
  return terms
}

/** JSON-stringify a value for a tool's native text content, never throwing. */
export function prettyJson(value, max = 20000) {
  try {
    return truncateText(JSON.stringify(value, null, 2), max)
  } catch {
    return String(value)
  }
}

/**
 * Validate and normalize model-supplied arguments against a raw JSON Schema
 * object. Raw-registered tools own their input validation: the registry only
 * validates canonical *output* values.
 *
 * Only the enforced schema subset is honored (type/oneOf/properties/required/
 * additionalProperties/items/enum/const), which is exactly what the tool
 * schemas in this plugin declare. Undeclared keys are dropped.
 *
 * @param {Record<string, unknown>} schema - the tool's `parameters` schema.
 * @param {unknown} args - model-supplied arguments.
 * @returns {Record<string, unknown>} a detached, validated argument object.
 * @throws {ToolInputError} when a value violates the schema.
 */
export function validateArgs(schema, args) {
  const input = args === undefined || args === null ? {} : args
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ToolInputError('arguments must be an object')
  }
  const properties = isRecord(schema?.properties) ? schema.properties : {}
  const required = Array.isArray(schema?.required) ? schema.required : []
  for (const key of required) {
    const node = properties[key]
    // Only own properties count: an inherited value is not caller-supplied data.
    if (!Object.hasOwn(input, key)) throw new ToolInputError(`missing required argument "${key}"`)
    const value = input[key]
    if (value === undefined) throw new ToolInputError(`missing required argument "${key}"`)
    if (value === null && node?.type !== 'null') {
      throw new ToolInputError(`argument "${key}" must not be null`)
    }
  }
  const out = {}
  for (const [key, node] of Object.entries(properties)) {
    if (!Object.hasOwn(input, key)) continue
    const value = input[key]
    if (value === undefined) continue
    out[key] = checkValue(node, value, key, 0)
  }
  return out
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkValue(node, value, where, depth) {
  if (depth > 12) throw new ToolInputError(`argument "${where}" is nested too deeply`)
  if (!isRecord(node)) return value
  if (Array.isArray(node.oneOf)) {
    const matches = node.oneOf.filter((branch) => {
      try {
        checkValue(branch, value, where, depth + 1)
        return true
      } catch {
        return false
      }
    })
    if (matches.length !== 1) {
      throw new ToolInputError(`argument "${where}" must match exactly one accepted shape (matched ${matches.length})`)
    }
    return checkValue(matches[0], value, where, depth + 1)
  }
  const type = typeof node.type === 'string' ? node.type : undefined
  if (type !== undefined) {
    if (type === 'string' && typeof value !== 'string') throw typeError(where, 'a string')
    if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw typeError(where, 'a finite number')
    if (type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) throw typeError(where, 'an integer')
    if (type === 'boolean' && typeof value !== 'boolean') throw typeError(where, 'a boolean')
    if (type === 'null' && value !== null) throw typeError(where, 'null')
    if (type === 'array' && !Array.isArray(value)) throw typeError(where, 'an array')
    if (type === 'object' && !isRecord(value)) throw typeError(where, 'an object')
  }
  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    throw new ToolInputError(`argument "${where}" must be one of ${JSON.stringify(node.enum)}`)
  }
  if (Object.hasOwn(node, 'const') && value !== node.const) {
    throw new ToolInputError(`argument "${where}" must be ${JSON.stringify(node.const)}`)
  }
  if (type === 'array') {
    const itemNode = isRecord(node.items) ? node.items : undefined
    if (itemNode === undefined) return value.slice()
    return value.map((entry, index) => checkValue(itemNode, entry, `${where}[${index}]`, depth + 1))
  }
  if (type === 'object') {
    const properties = isRecord(node.properties) ? node.properties : {}
    const required = Array.isArray(node.required) ? node.required : []
    for (const key of required) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) {
        throw new ToolInputError(`missing required argument "${where}.${key}"`)
      }
    }
    const out = {}
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) continue
      out[key] = checkValue(child, value[key], `${where}.${key}`, depth + 1)
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          throw new ToolInputError(`argument "${where}.${key}" is not accepted`)
        }
      }
    } else {
      for (const [key, child] of Object.entries(value)) {
        if (Object.hasOwn(properties, key)) continue
        out[key] = child
      }
    }
    return out
  }
  return value
}

function typeError(where, expected) {
  return new ToolInputError(`argument "${where}" must be ${expected}`)
}

/** AbortError-shaped rejection so cancellation is not reported as a tool bug. */
export function abortError(reason = 'operation aborted') {
  const error = new Error(reason)
  error.name = 'AbortError'
  return error
}

/** Throw when the caller's signal has fired. */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}
