/**
 * Live integration test against the real Obsidian installation on this machine.
 *
 * Everything here is read-only: it never opens notes, switches the active note,
 * runs commands, or writes files, so running the suite cannot disturb a vault
 * the user has open. Each test skips itself when Obsidian or the Local REST API
 * plugin is not reachable.
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { Config, apply } from '../lib/index.js'
import { ObsidianRest, discoverRest } from '../lib/rest.js'
import { discoverVaults } from '../lib/vault.js'

const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-obsidian-live-'))
const discovered = await discoverVaults({})
const openVault = discovered.find((entry) => entry.open === true) ?? discovered[0] ?? null
const endpoint = openVault === null ? null : await discoverRest(openVault.path)
const client = endpoint === null ? null : new ObsidianRest({ baseURL: endpoint.baseURL, apiKey: endpoint.apiKey, timeoutMs: 4000 })
const probe = client === null ? { available: false, error: 'no vault or plugin' } : await client.probe()
const live = probe.available === true
/** The filesystem half needs only a vault on disk, not a running Obsidian. */
const vaultSkip = openVault === null ? 'no Obsidian vault found on this machine' : false
/** The app half additionally needs the Local REST API to answer. */
const skip = live ? false : `Obsidian Local REST API not reachable (${probe.error ?? 'unknown'})`

function toolset() {
  const registered = new Map()
  const ctx = {
    tools: { register(definition) { registered.set(definition.name, definition); return () => {} } },
    inject(services, mount) {
      if (services.includes('systemPrompt')) {
        mount({ section() { return () => {} } })
      }
    },
  }
  apply(ctx, Config['~standard'].validate({ stateDir }).value)
  return registered
}

const call = async (registered, name, args) => {
  const definition = registered.get(name)
  assert.ok(definition !== undefined, `${name} is registered`)
  return await definition.execute(args, { signal: new AbortController().signal })
}

test('the live bridge reports an authenticated Local REST API', { skip }, async () => {
  const registered = toolset()
  const status = await call(registered, 'obsidian_app', { action: 'status' })
  assert.equal(status.available, true)
  assert.equal(status.authenticated, true)
  assert.match(status.message, /Local REST API/)
})

test('the active note and tags come back from the running app', { skip }, async () => {
  const registered = toolset()
  const active = await call(registered, 'obsidian_app', { action: 'active' })
  assert.equal(active.available, true)
  assert.ok(active.note === null || typeof active.note === 'string')
  const tags = await call(registered, 'obsidian_app', { action: 'tags' })
  assert.equal(Array.isArray(tags.tagCounts), true)
  const commands = await call(registered, 'obsidian_app', { action: 'command', query: 'open' })
  assert.equal(Array.isArray(commands.commands), true)
})

test('Obsidian live search answers with the normalized result shape', { skip }, async () => {
  const registered = toolset()
  const result = await call(registered, 'obsidian_app', { action: 'search', query: 'the' })
  assert.equal(Array.isArray(result.results), true)
  for (const entry of result.results) {
    assert.equal(typeof entry.path, 'string')
    assert.equal(Array.isArray(entry.matches), true)
  }
  const viaSearch = await call(registered, 'obsidian_search', { query: 'the', source: 'app' })
  assert.equal(viaSearch.source, 'app')
  assert.equal(Array.isArray(viaSearch.matches), true)
})

test('filesystem search finds notes the vault listing reports', { skip: vaultSkip }, async () => {
  const registered = toolset()
  const listed = await call(registered, 'obsidian_list', { mode: 'flat', limit: 5 })
  assert.ok(listed.entries.length > 0, 'the live vault must contain notes')
  const first = listed.entries[0]
  const searched = await call(registered, 'obsidian_search', { query: first.name.replace(/\.[^.]+$/, ''), limit: 10 })
  assert.ok(searched.matches.some((match) => match.path === first.path), `search should find ${first.path}`)
})

test('reading the first listed note returns its lines', { skip: vaultSkip }, async () => {
  const registered = toolset()
  const listed = await call(registered, 'obsidian_list', { mode: 'flat', limit: 1 })
  const note = await call(registered, 'obsidian_read', { note: listed.entries[0].path, limit: 20 })
  assert.equal(note.exists, true)
  assert.ok(note.lines.length > 0)
  assert.equal(note.lines[0].number, 1)
})

test.after(async () => {
  await fsp.rm(stateDir, { recursive: true, force: true })
})
