import assert from 'node:assert/strict'
import test from 'node:test'

import { ObsidianRest, discoverRest, encodeVaultPath } from '../lib/rest.js'
import { REST_DATA_FIXTURE, makeVault, removeVault } from './helpers/fixture.mjs'

test('discoverRest reads the Local REST API plugin data', async () => {
  const root = await makeVault({ '.obsidian/plugins/obsidian-local-rest-api/data.json': REST_DATA_FIXTURE })
  try {
    const endpoint = await discoverRest(root)
    assert.deepEqual(endpoint, {
      baseURL: 'http://127.0.0.1:27123',
      apiKey: 'test-key-0123456789',
      securePort: 27124,
      insecurePort: 27123,
      useInsecure: true,
    })
  } finally {
    await removeVault(root)
  }
})

test('discoverRest returns null without the plugin and prefers the secure port when insecure is disabled', async () => {
  const bare = await makeVault({ 'a.md': '# a\n' })
  try {
    assert.equal(await discoverRest(bare), null)
  } finally {
    await removeVault(bare)
  }
  const secure = await makeVault({
    '.obsidian/plugins/obsidian-local-rest-api/data.json': JSON.stringify({
      port: 27125,
      insecurePort: 27123,
      enableInsecureServer: false,
      apiKey: 'k',
    }),
  })
  try {
    const endpoint = await discoverRest(secure)
    assert.equal(endpoint.baseURL, 'https://127.0.0.1:27125')
  } finally {
    await removeVault(secure)
  }
})

test('discoverRest ignores data without an API key', async () => {
  const root = await makeVault({ '.obsidian/plugins/obsidian-local-rest-api/data.json': JSON.stringify({ port: 27124 }) })
  try {
    assert.equal(await discoverRest(root), null)
  } finally {
    await removeVault(root)
  }
})

test('encodeVaultPath encodes segments but keeps folder separators', () => {
  assert.equal(encodeVaultPath('Folder/My Note #1.md'), 'Folder/My%20Note%20%231.md')
  assert.equal(encodeVaultPath('/leading/slash.md'), 'leading/slash.md')
})

test('an unconfigured client reports that the plugin is missing', async () => {
  const client = new ObsidianRest({ baseURL: null, apiKey: null })
  assert.equal(client.configured, false)
  const probe = await client.probe()
  assert.equal(probe.available, false)
  assert.match(probe.error, /not configured/)
})

test('an unreachable endpoint reports a helpful error instead of hanging', async () => {
  const client = new ObsidianRest({ baseURL: 'http://127.0.0.1:1', apiKey: 'k', timeoutMs: 1500 })
  const probe = await client.probe()
  assert.equal(probe.available, false)
  assert.match(probe.error, /unreachable/)
})
