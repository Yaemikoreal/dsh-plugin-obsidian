/**
 * dsh-plugin-obsidian — DeepSeek Harness ⇄ Obsidian.
 *
 * Registers model-facing tools that read and write an Obsidian vault over the
 * filesystem (fast local index, works while Obsidian is closed) and, when the
 * vault has the community "Local REST API" plugin, drive the running Obsidian
 * app as well (open notes, active note, live search, daily notes, commands).
 *
 * The vault is auto-discovered from Obsidian's own registry, so no
 * configuration is required in the common case.
 *
 * @module dsh-plugin-obsidian
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { ObsidianRest, discoverRest } from './rest.js'
import { createObsidianTools } from './tools.js'
import { ToolInputError } from './util.js'
import { ObsidianVault, discoverVaults } from './vault.js'

/** Cordis plugin name. */
export const name = 'obsidian'

/** The tool registry must exist before tools can be registered. */
export const inject = ['tools']

/** Settings file (under the harness home) that remembers vaults and the active one. */
const SETTINGS_FILE = 'obsidian-plugin.json'
const SETTINGS_VERSION = 1

const KNOWN_KEYS = new Set([
  'vault',
  'vaults',
  'excludes',
  'indexExtensions',
  'writableExtensions',
  'attachmentExtensions',
  'attachmentFolder',
  'readOnly',
  'indexTtlMs',
  'maxCacheBytes',
  'dailyFolder',
  'dailyFormat',
  'agentGuidance',
  'stateDir',
  'rest',
  'debug',
])

/**
 * Config schema (Standard Schema v1, so the loader validates and normalizes
 * `config:` from the profile patch without pulling in a schema library).
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugin-obsidian',
    validate(value) {
      try {
        return { value: normalizeConfig(value) }
      } catch (error) {
        return { issues: [{ message: error.message, path: [] }] }
      }
    },
  },
}

/**
 * Normalize and validate plugin configuration.
 *
 * @param {unknown} value - raw `config:` value from the profile patch.
 * @returns {object} normalized configuration.
 * @throws {Error} when a field has the wrong type.
 */
export function normalizeConfig(value) {
  const raw = value === null || value === undefined ? {} : value
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('obsidian config must be an object')
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`unknown obsidian config key "${key}" (known: ${[...KNOWN_KEYS].join(', ')})`)
  }
  const config = {
    vault: optionalString(raw.vault, 'vault'),
    vaults: stringList(raw.vaults, 'vaults'),
    excludes: stringList(raw.excludes, 'excludes'),
    indexExtensions: stringList(raw.indexExtensions, 'indexExtensions'),
    writableExtensions: stringList(raw.writableExtensions, 'writableExtensions'),
    attachmentExtensions: stringList(raw.attachmentExtensions, 'attachmentExtensions'),
    attachmentFolder: optionalString(raw.attachmentFolder, 'attachmentFolder'),
    readOnly: raw.readOnly === true,
    indexTtlMs: optionalPositiveInt(raw.indexTtlMs, 'indexTtlMs'),
    maxCacheBytes: optionalPositiveInt(raw.maxCacheBytes, 'maxCacheBytes'),
    dailyFolder: optionalString(raw.dailyFolder, 'dailyFolder'),
    dailyFormat: optionalString(raw.dailyFormat, 'dailyFormat'),
    agentGuidance: raw.agentGuidance !== false,
    stateDir: optionalString(raw.stateDir, 'stateDir'),
    debug: raw.debug === true,
    rest: normalizeRest(raw.rest),
  }
  return config
}

function normalizeRest(value) {
  if (value === null || value === undefined) return { enabled: true, baseURL: null, apiKey: null }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('obsidian config "rest" must be an object')
  for (const key of Object.keys(value)) {
    if (key !== 'enabled' && key !== 'baseURL' && key !== 'apiKey') {
      throw new Error(`unknown obsidian config key "rest.${key}"`)
    }
  }
  return {
    enabled: value.enabled !== false,
    baseURL: optionalString(value.baseURL, 'rest.baseURL'),
    apiKey: optionalString(value.apiKey, 'rest.apiKey'),
  }
}

function optionalString(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`obsidian config "${field}" must be a string`)
  return value
}

function stringList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`obsidian config "${field}" must be an array of strings`)
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new Error(`obsidian config "${field}" must be an array of strings`)
    return entry
  })
}

function optionalPositiveInt(value, field) {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value <= 0) throw new Error(`obsidian config "${field}" must be a positive integer`)
  return value
}

/**
 * Behavioral guidance injected into the system prompt: when the model should
 * consult the vault, and when finishing a conversation it should consider
 * recording what is worth keeping. It names no tool parameters — the tool
 * definitions own those — only when and why.
 */
const GUIDANCE_SECTION = {
  name: 'obsidian:agent-guidance',
  order: 2350,
  text: [
    '### Obsidian vault',
    '',
    'The user\'s Obsidian vault is connected through the obsidian_* tools, and querying it is fast and offline-safe.',
    '',
    '- Consult the vault whenever it can ground an answer: the user mentions their notes, past discussions, plans, or decisions; reusing what they already recorded would save them re-explaining; or before claiming something was never discussed or decided. A quick search (full-text, tags, tasks, or frontmatter) is cheaper than a wrong assumption.',
    '- After finishing a substantive conversation or task, briefly judge on your own whether anything is worth keeping in the vault: decisions and their reasons, solutions and debugging findings, project progress, references worth revisiting, or meeting minutes. When something is worth keeping, record it without asking: append a dated line to today\'s daily note (note "@daily"), or create or update a note in the folder that matches its topic. Skip small talk, transient Q&A, and anything the user would not want stored.',
    '- Search before creating: reuse or extend an existing note instead of spawning a near-duplicate, and keep new notes in the vault\'s existing folder structure.',
  ].join('\n'),
}

/**
 * Cordis plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [config] - validated plugin configuration.
 */
export function apply(ctx, config) {
  const state = createState(config ?? {})
  state.ready = initialize(state).catch((error) => {
    state.initError = error
    log(ctx, state, `initialization failed: ${error.message}`)
  })
  const definitions = createObsidianTools({ state })
  for (const definition of definitions) {
    ctx.tools.register(definition)
  }
  // Optional weak dependency: profiles without the system-prompt service keep
  // working, they just do not get the behavioral guidance. A host without
  // ctx.inject (minimal test doubles) is tolerated the same way.
  // The inject callback receives an injected CONTEXT view whose services are
  // properties — not the service instance itself (verified against
  // @deepseek-ai/cordis 4.0.5: treating it as the service throws
  // `cannot get property "section" without inject`).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (injected) => {
      if (state.config.agentGuidance !== true) return
      injected.systemPrompt?.section(GUIDANCE_SECTION)
    })
  }
  log(ctx, state, `registered ${definitions.length} tools`)
}

function createState(config) {
  const home = config.stateDir ?? process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  const state = {
    config,
    settingsPath: path.join(home, SETTINGS_FILE),
    /** @type {Promise<void> | null} */
    ready: null,
    initError: null,
    /** @type {Array<{ path: string, name: string, open: boolean, sources: string[] }>} */
    discovered: [],
    /** @type {Map<string, ObsidianVault>} */
    vaults: new Map(),
    /** @type {ObsidianVault | null} */
    activeVault: null,
    /** @type {Map<string, ObsidianRest | null>} */
    restCache: new Map(),
    persisted: { active: null, vaults: [] },
  }
  state.getVault = (vaultArg) => getVault(state, vaultArg)
  state.getRest = (vaultArg) => getRest(state, vaultArg)
  state.status = (options) => status(state, options)
  state.useVault = (nameOrPath) => useVault(state, nameOrPath)
  state.addVault = (vaultPath) => addVault(state, vaultPath)
  state.refresh = () => refresh(state)
  return state
}

async function initialize(state) {
  const persisted = await readSettings(state.settingsPath)
  state.persisted = persisted
  const discovered = await discoverVaults({
    vault: state.config.vault,
    vaults: state.config.vaults,
    extra: persisted.vaults,
  })
  state.discovered = discovered
  state.vaults = new Map()
  for (const entry of discovered) {
    state.vaults.set(entry.path.toLowerCase(), createVault(state, entry))
  }
  state.activeVault = pickActive(state, persisted)
}

function createVault(state, entry) {
  const config = state.config
  return new ObsidianVault({
    root: entry.path,
    name: entry.name,
    excludes: config.excludes,
    indexExtensions: config.indexExtensions.length > 0 ? config.indexExtensions : undefined,
    writableExtensions: config.writableExtensions.length > 0 ? config.writableExtensions : undefined,
    attachmentExtensions: config.attachmentExtensions.length > 0 ? config.attachmentExtensions : undefined,
    attachmentFolder: config.attachmentFolder ?? undefined,
    readOnly: config.readOnly,
    ttlMs: config.indexTtlMs ?? undefined,
    maxCacheBytes: config.maxCacheBytes ?? undefined,
    dailyFolder: config.dailyFolder ?? undefined,
    dailyFormat: config.dailyFormat ?? undefined,
  })
}

function pickActive(state, persisted) {
  const vaults = [...state.vaults.values()]
  if (vaults.length === 0) return null
  const byPath = (candidate) => {
    if (typeof candidate !== 'string' || candidate === '') return null
    const key = path.resolve(candidate).toLowerCase()
    return state.vaults.get(key) ?? null
  }
  return byPath(persisted.active)
    ?? byPath(state.config.vault)
    ?? vaults.find((vault) => state.discovered.find((entry) => entry.path.toLowerCase() === vault.root.toLowerCase())?.open === true)
    ?? vaults[0]
}

async function getVault(state, vaultArg) {
  await state.ready
  if (state.vaults.size === 0) {
    throw new ToolInputError(
      'No Obsidian vault found. Open a vault in Obsidian (or pass an absolute path to obsidian_vaults action "add"), then retry.'
      + (state.initError === null ? '' : ` Discovery error: ${state.initError.message}`),
    )
  }
  if (vaultArg === undefined || vaultArg === null || String(vaultArg).trim() === '') {
    return state.activeVault ?? [...state.vaults.values()][0]
  }
  const key = String(vaultArg).trim()
  for (const vault of state.vaults.values()) {
    if (vault.name.toLowerCase() === key.toLowerCase()) return vault
  }
  const byPath = state.vaults.get(path.resolve(key).toLowerCase())
  if (byPath !== undefined) return byPath
  for (const [vaultPath, vault] of state.vaults) {
    if (vaultPath.includes(key.toLowerCase())) return vault
  }
  throw new ToolInputError(`Unknown vault "${key}". Known vaults: ${[...state.vaults.values()].map((vault) => vault.name).join(', ')}`)
}

async function getRest(state, vaultArg) {
  const vault = await getVault(state, vaultArg)
  if (state.config.rest.enabled !== true) return null
  const key = vault.root.toLowerCase()
  if (state.restCache.has(key)) return state.restCache.get(key)
  let endpoint = null
  if (state.config.rest.baseURL !== null && state.config.rest.apiKey !== null) {
    endpoint = { baseURL: state.config.rest.baseURL, apiKey: state.config.rest.apiKey }
  } else {
    endpoint = await discoverRest(vault.root)
  }
  const client = endpoint === null
    ? null
    : new ObsidianRest({ baseURL: endpoint.baseURL, apiKey: endpoint.apiKey, label: vault.name })
  state.restCache.set(key, client)
  return client
}

async function status(state, options = {}) {
  await state.ready
  const active = state.activeVault
  const vaults = []
  for (const entry of state.discovered) {
    const vault = state.vaults.get(entry.path.toLowerCase())
    if (vault === undefined) continue
    if (vault.files.size === 0 && vault.lastScan === 0) {
      try {
        await vault.scan({ signal: options.signal })
      } catch {
        /* an unreadable vault still reports its identity */
      }
    }
    vaults.push({
      name: vault.name,
      path: vault.root,
      active: active !== null && active.root.toLowerCase() === vault.root.toLowerCase(),
      open: entry.open === true,
      notes: vault.files.size,
      readOnly: vault.readOnly,
      sources: entry.sources,
    })
  }
  const rest = { available: false, authenticated: false, baseURL: null, error: null }
  if (active !== null) {
    const client = await getRest(state, active.root)
    if (client === null) {
      rest.error = 'Obsidian Local REST API plugin not detected in this vault'
    } else {
      const probe = await client.probe(options.signal)
      rest.available = probe.available === true
      rest.authenticated = probe.authenticated === true
      rest.baseURL = client.baseURL
      rest.error = probe.available === true ? null : (probe.error ?? 'unreachable')
    }
  }
  return {
    active: active === null ? null : { name: active.name, path: active.root, notes: active.files.size, readOnly: active.readOnly },
    vaults,
    rest,
  }
}

async function useVault(state, nameOrPath) {
  const vault = await getVault(state, nameOrPath)
  state.activeVault = vault
  await persist(state)
  return vault
}

async function addVault(state, vaultPath) {
  if (typeof vaultPath !== 'string' || vaultPath.trim() === '') throw new ToolInputError('vault path must be a non-empty string')
  const absolute = path.resolve(vaultPath.trim())
  let stat
  try {
    stat = await fsp.stat(absolute)
  } catch {
    throw new ToolInputError(`vault path does not exist: ${absolute}`)
  }
  if (!stat.isDirectory()) throw new ToolInputError(`vault path is not a directory: ${absolute}`)
  const key = absolute.toLowerCase()
  if (!state.vaults.has(key)) {
    const entry = { path: absolute, name: path.basename(absolute), open: false, sources: ['settings'] }
    state.discovered.push(entry)
    const vault = createVault(state, entry)
    state.vaults.set(key, vault)
    if (state.activeVault === null) state.activeVault = vault
  }
  await persist(state)
  return state.vaults.get(key)
}

async function refresh(state) {
  const previousActive = state.activeVault === null ? null : state.activeVault.root
  state.restCache.clear()
  await initialize(state)
  if (previousActive !== null) {
    const restored = state.vaults.get(previousActive.toLowerCase())
    if (restored !== undefined) state.activeVault = restored
  }
  return state.activeVault
}

async function persist(state) {
  const extra = state.discovered.filter((entry) => entry.sources.includes('settings')).map((entry) => entry.path)
  const payload = {
    version: SETTINGS_VERSION,
    active: state.activeVault === null ? null : state.activeVault.root,
    vaults: extra,
    updatedAt: new Date().toISOString(),
  }
  try {
    await fsp.mkdir(path.dirname(state.settingsPath), { recursive: true })
    await fsp.writeFile(state.settingsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch (error) {
    log(null, state, `cannot persist settings: ${error.message}`)
  }
}

async function readSettings(settingsPath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(settingsPath, 'utf8'))
    return {
      active: typeof parsed?.active === 'string' ? parsed.active : null,
      vaults: Array.isArray(parsed?.vaults) ? parsed.vaults.filter((entry) => typeof entry === 'string') : [],
    }
  } catch {
    return { active: null, vaults: [] }
  }
}

function log(ctx, state, message) {
  if (state !== null && state.config.debug !== true) return
  const line = `[dsh-plugin-obsidian] ${message}`
  try {
    if (ctx !== null && typeof ctx.logger === 'function') {
      ctx.logger('obsidian').info(line)
      return
    }
  } catch {
    /* the logger service is optional */
  }
  if (state === null || state.config.debug === true) console.debug(line)
}
