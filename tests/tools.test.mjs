import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { Config, apply, normalizeConfig } from '../lib/index.js'
import { OUTPUT_SCHEMAS, PARAMETER_SCHEMAS, RENDERERS, createObsidianTools } from '../lib/tools.js'
import { ToolInputError, validateArgs } from '../lib/util.js'
import { assertSchema, loadContract, validateValue } from './helpers/contract.mjs'
import { REST_DATA_FIXTURE_OFFLINE, SAMPLE_FILES, makeVault, removeVault } from './helpers/fixture.mjs'

const contract = await loadContract()

/** Run one plugin instance against a fresh fixture vault with a hermetic harness home. */
async function withPlugin(options, run) {
  const root = await makeVault({ ...SAMPLE_FILES, ...(options?.files ?? {}) })
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-obsidian-state-'))
  const previousAppData = process.env.APPDATA
  process.env.APPDATA = path.join(stateDir, 'appdata')
  await fsp.mkdir(process.env.APPDATA, { recursive: true })
  const registered = new Map()
  const sections = []
  const ctx = {
    tools: {
      register(definition) {
        if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    inject(services, mount) {
      if (services.includes('systemPrompt')) {
        // Mimics real cordis: the callback receives an injected context view
        // whose services are properties, not the service instance itself.
        mount({ systemPrompt: { section(section) { sections.push(section); return () => {} } } })
      }
    },
  }
  const config = normalizeConfig({ vault: root, stateDir, ...(options?.config ?? {}) })
  apply(ctx, config)
  const signal = new AbortController().signal
  const call = async (name, args) => {
    const definition = registered.get(name)
    assert.ok(definition !== undefined, `tool ${name} must be registered`)
    const value = await definition.execute(args, { signal })
    const violations = validateValue(contract, definition.output.schema, value, name)
    assert.deepEqual(violations, [], `${name} produced invalid output: ${violations.join('; ')}`)
    const content = definition.output.render(args, value)
    assert.ok(Array.isArray(content) && content.length > 0, `${name} must render content`)
    assert.equal(typeof content[0].text, 'string')
    return { definition, value, content }
  }
  try {
    await run({ registered, call, root, stateDir, config, sections })
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = previousAppData
    await removeVault(root)
    await fsp.rm(stateDir, { recursive: true, force: true })
  }
}

test('registers every tool with schemas inside the enforced JSON-Schema subset', async () => {
  await withPlugin({}, async ({ registered }) => {
    assert.deepEqual([...registered.keys()].sort(), [
      'obsidian_app',
      'obsidian_attach',
      'obsidian_delete',
      'obsidian_links',
      'obsidian_list',
      'obsidian_move',
      'obsidian_read',
      'obsidian_search',
      'obsidian_tasks',
      'obsidian_vaults',
      'obsidian_write',
    ])
    for (const [name, definition] of registered) {
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length > 20, `${name} needs a useful description`)
      assertSchema(contract, definition.parameters, `${name}.parameters`)
      assertSchema(contract, definition.output.schema, `${name}.output.schema`)
      assert.equal(typeof definition.output.render, 'function')
      const properties = definition.parameters.properties ?? {}
      for (const key of definition.parameters.required ?? []) {
        assert.ok(Object.hasOwn(properties, key), `${name}.parameters.required names ${key}`)
      }
      for (const [key, node] of Object.entries(properties)) {
        assert.ok(node.type !== undefined || Array.isArray(node.oneOf), `${name}.${key} declares a type`)
      }
      const mutating = ['obsidian_write', 'obsidian_move', 'obsidian_delete', 'obsidian_attach'].includes(name)
      assert.equal(definition.isConcurrencySafe(mutating ? {} : { action: 'search' }), !mutating)
    }
  })
})

test('validateArgs rejects missing and mistyped arguments', async () => {
  await withPlugin({}, async ({ call, registered }) => {
    await assert.rejects(() => call('obsidian_search', {}), /missing required argument "query"/)
    await assert.rejects(() => call('obsidian_search', { query: 'a', limit: 'many' }), /must be an integer/)
    await assert.rejects(() => call('obsidian_search', { query: 'a', limit: 1.5 }), /must be an integer/)
    await assert.rejects(() => call('obsidian_search', { query: 'a', limit: Number.NaN }), /must be an integer/)
    await assert.rejects(() => call('obsidian_search', { query: 'a', mode: 'nonsense' }), /must be one of/)
    await assert.rejects(() => call('obsidian_read', { note: 42 }), /must be a string/)
    await assert.rejects(() => call('obsidian_read', { note: null }), /must not be null/)
    // Undeclared keys are dropped rather than forwarded.
    const definition = registered.get('obsidian_search')
    const value = await definition.execute({ query: 'alpha', bogus: 'x' }, { signal: new AbortController().signal })
    assert.equal(value.total > 0, true)
  })
})

test('validateArgs only honors own properties and never pollutes prototypes', () => {
  const schema = PARAMETER_SCHEMAS.obsidian_search
  // An inherited value is not caller-supplied data.
  assert.throws(() => validateArgs(schema, Object.create({ query: 'a' })), /missing required argument "query"/)
  // An own "__proto__" key is dropped and cannot reach Object.prototype.
  const hostile = JSON.parse('{"__proto__": {"polluted": true}, "query": "a"}')
  assert.deepEqual(validateArgs(schema, hostile), { query: 'a' })
  assert.equal({}.polluted, undefined)
  // Nested objects follow the same rule.
  const nested = validateArgs({ type: 'object', properties: { fm: { type: 'object', properties: { title: { type: 'string' } } } } }, {
    fm: JSON.parse('{"__proto__": {"polluted": true}, "title": "ok"}'),
  })
  assert.deepEqual(nested, { fm: { title: 'ok' } })
  assert.equal({}.polluted, undefined)
})

test('search, read, list, and links work end to end through the tools', async () => {
  await withPlugin({}, async ({ call }) => {
    const search = await call('obsidian_search', { query: 'alpha', context: 1 })
    assert.equal(search.value.source, 'vault')
    assert.ok(search.value.matches.some((match) => match.path === 'Projects/Alpha.md'))
    assert.ok(search.content[0].text.includes('Projects/Alpha.md'))

    const read = await call('obsidian_read', { note: 'Welcome', limit: 5 })
    assert.equal(read.value.path, 'Welcome.md')
    assert.equal(read.value.lines.length, 5)
    assert.ok(read.content[0].text.includes('title: Welcome Home'))

    const list = await call('obsidian_list', { mode: 'flat' })
    assert.equal(list.value.total, 5)
    assert.ok(list.content[0].text.includes('Welcome.md'))

    const links = await call('obsidian_links', { note: 'Alpha' })
    assert.deepEqual(links.value.outgoing.map((entry) => entry.path), ['Welcome.md'])
    assert.deepEqual(links.value.unresolved.map((entry) => entry.target), ['Missing Note'])
  })
})

test('write creates, appends, and previews with a valid canonical output', async () => {
  await withPlugin({}, async ({ call, root }) => {
    const created = await call('obsidian_write', { note: 'Inbox/New', content: '# New\n\nbody\n' })
    assert.equal(created.value.path, 'Inbox/New.md')
    assert.equal(created.value.created, true)
    assert.equal(created.value.openedInApp, false)
    assert.equal(created.value.appError, null)
    assert.equal(await fsp.readFile(path.join(root, 'Inbox/New.md'), 'utf8'), '# New\n\nbody\n')

    const appended = await call('obsidian_write', { note: 'Inbox/New', mode: 'append', content: 'APPENDED-TOKEN' })
    assert.equal(appended.value.mode, 'append')
    assert.equal(await fsp.readFile(path.join(root, 'Inbox/New.md'), 'utf8'), '# New\n\nbody\n\nAPPENDED-TOKEN\n')

    const preview = await call('obsidian_write', { note: 'Inbox/New', mode: 'append', content: 'dry', dryRun: true })
    assert.equal(preview.value.dryRun, true)
    assert.equal((await fsp.readFile(path.join(root, 'Inbox/New.md'), 'utf8')).includes('dry'), false)

    const searched = await call('obsidian_search', { query: 'APPENDED-TOKEN' })
    assert.deepEqual(searched.value.matches.map((match) => match.path), ['Inbox/New.md'])
  })
})

test('move and delete work end to end with valid canonical outputs', async () => {
  await withPlugin({}, async ({ call, root }) => {
    const plan = await call('obsidian_move', { note: 'Projects/Alpha.md', to: 'Projects/Alpha Renamed', dryRun: true })
    assert.equal(plan.value.dryRun, true)
    assert.equal(plan.value.to, 'Projects/Alpha Renamed.md')
    assert.ok(plan.value.linksUpdated >= 2)
    assert.ok(plan.content[0].text.includes('Would move'))

    const moved = await call('obsidian_move', { note: 'Projects/Alpha.md', to: 'Archive/' })
    assert.equal(moved.value.from, 'Projects/Alpha.md')
    assert.equal(moved.value.to, 'Archive/Alpha.md')
    assert.equal(moved.value.renamed, false)
    assert.ok(moved.value.linksUpdated >= 1)
    assert.equal(await fsp.access(path.join(root, 'Projects/Alpha.md')).then(() => true, () => false), false)
    assert.equal(await fsp.readFile(path.join(root, 'Archive/Alpha.md'), 'utf8').then((text) => text.includes('# Alpha')), true)

    const trashPlan = await call('obsidian_delete', { note: 'Archive/Alpha.md', dryRun: true })
    assert.equal(trashPlan.value.dryRun, true)
    assert.ok(trashPlan.value.backlinkCount >= 1)
    assert.match(trashPlan.content[0].text, /Would remove/)

    const trashed = await call('obsidian_delete', { note: 'Archive/Alpha.md' })
    assert.equal(trashed.value.permanent, false)
    assert.equal(trashed.value.trashTarget, '.trash/Archive/Alpha.md')
    assert.equal(await fsp.access(path.join(root, 'Archive/Alpha.md')).then(() => true, () => false), false)
    assert.equal(await fsp.access(path.join(root, '.trash/Archive/Alpha.md')).then(() => true, () => false), true)
    assert.match(trashed.content[0].text, /Moved to trash/)
  })
})

test('move and delete reject invalid input through the tool surface', async () => {
  await withPlugin({}, async ({ call }) => {
    await assert.rejects(() => call('obsidian_move', { note: 'Projects/Alpha.md' }), /missing required argument "to"/)
    await assert.rejects(() => call('obsidian_move', { note: 'Projects/Alpha.md', to: 'Projects/Beta.md' }), /already exists/)
    await assert.rejects(() => call('obsidian_move', { note: 'Ghost', to: 'X.md' }), /not found/)
    await assert.rejects(() => call('obsidian_delete', {}), /missing required argument "note"/)
    await assert.rejects(() => call('obsidian_delete', { note: 'Ghost' }), /not found/)
    await assert.rejects(() => call('obsidian_delete', { note: 'Projects/Alpha.md', permanent: 'yes' }), /must be a boolean/)
  })
})

test('tasks collection works end to end with a valid canonical output', async () => {
  await withPlugin({}, async ({ call }) => {
    const tasks = await call('obsidian_tasks', { status: 'open' })
    assert.equal(tasks.value.status, 'open')
    assert.ok(tasks.value.tasks.some((task) => task.path === 'Projects/Alpha.md' && task.text === 'task one'))
    assert.ok(tasks.content[0].text.includes('task one'))

    const done = await call('obsidian_tasks', { status: 'done' })
    assert.equal(done.value.total, 0)

    const queried = await call('obsidian_tasks', { status: 'all', query: 'task one' })
    assert.equal(queried.value.total, 1)
    assert.equal(queried.value.tasks[0].line, 14)
  })
})

test('write reports an app-bridge note when Obsidian Local REST API is absent', async () => {
  await withPlugin({}, async ({ call }) => {
    const written = await call('obsidian_write', { note: 'Inbox/Open.md', content: 'hi\n', open: true })
    assert.equal(written.value.openedInApp, false)
    assert.match(written.value.appError, /Local REST API/)
  })
})

test('obsidian_vaults lists, adds, and switches vaults', async () => {
  await withPlugin({}, async ({ call, root }) => {
    const listed = await call('obsidian_vaults', {})
    assert.equal(listed.value.vaults.length, 1)
    assert.equal(listed.value.active.path, root)
    assert.equal(listed.value.rest.available, false)
    assert.match(listed.value.rest.error, /Local REST API/)

    const other = await makeVault({ 'Other.md': '# Other\n\nother vault body\n' })
    try {
      const added = await call('obsidian_vaults', { action: 'add', path: other })
      assert.equal(added.value.vaults.length, 2)
      const used = await call('obsidian_vaults', { action: 'use', vault: other })
      assert.equal(used.value.active.path, other)
      const searched = await call('obsidian_search', { query: 'other vault body' })
      assert.deepEqual(searched.value.matches.map((match) => match.path), ['Other.md'])
      const byName = await call('obsidian_vaults', { action: 'use', vault: path.basename(other) })
      assert.equal(byName.value.active.path, other)
      const restored = await call('obsidian_vaults', { action: 'use', vault: root })
      assert.equal(restored.value.active.path, root)
    } finally {
      await removeVault(other)
    }
  })
})

test('obsidian_app degrades with an actionable message without the REST plugin', async () => {
  await withPlugin({}, async ({ call }) => {
    const status = await call('obsidian_app', { action: 'status' })
    assert.equal(status.value.available, false)
    assert.match(status.value.message, /Local REST API/)
    const search = await call('obsidian_app', { action: 'search', query: 'alpha' })
    assert.equal(search.value.available, false)
    assert.equal(search.value.results, null)
  })
})

test('vaults are discovered from Obsidian\'s registry and the open one becomes active', async () => {
  const vaultA = await makeVault({ 'A.md': '# A\n' })
  const vaultB = await makeVault({ 'B.md': '# B\n' })
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-obsidian-state-'))
  const previousAppData = process.env.APPDATA
  try {
    process.env.APPDATA = path.join(stateDir, 'appdata')
    await fsp.mkdir(path.join(process.env.APPDATA, 'obsidian'), { recursive: true })
    await fsp.writeFile(path.join(process.env.APPDATA, 'obsidian', 'obsidian.json'), JSON.stringify({
      vaults: {
        aaa: { path: vaultA, open: true, ts: 1 },
        bbb: { path: vaultB, open: false, ts: 2 },
      },
    }), 'utf8')

    const registered = new Map()
    const sections = []
    const ctx = {
      tools: { register(definition) { registered.set(definition.name, definition); return () => {} } },
      inject(services, mount) {
        if (services.includes('systemPrompt')) {
          mount({ systemPrompt: { section(section) { sections.push(section); return () => {} } } })
        }
      },
    }
    apply(ctx, normalizeConfig({ stateDir }))
    assert.equal(sections.length, 1)
    const value = await registered.get('obsidian_vaults').execute({}, { signal: new AbortController().signal })
    assert.equal(value.vaults.length, 2)
    assert.equal(value.active.path, vaultA)
    assert.ok(value.vaults.every((vault) => vault.sources.includes('obsidian')))
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = previousAppData
    await removeVault(vaultA)
    await removeVault(vaultB)
    await fsp.rm(stateDir, { recursive: true, force: true })
  }
})

test('rest discovery reads the Local REST API plugin data', async () => {
  await withPlugin({
    files: { '.obsidian/plugins/obsidian-local-rest-api/data.json': REST_DATA_FIXTURE_OFFLINE },
  }, async ({ call }) => {
    const status = await call('obsidian_app', { action: 'status' })
    assert.equal(status.value.baseURL, 'http://127.0.0.1:27923')
    assert.equal(status.value.available, false)
    assert.match(status.value.message, /unreachable|Local REST API/)
  })
})

test('presenters are pure, replayable, and shaped for the UI cards', async () => {
  await withPlugin({}, async ({ call }) => {
    const search = await call('obsidian_search', { query: 'alpha' })
    const frozenArgs = JSON.parse(JSON.stringify({ query: 'alpha' }))
    const metaOne = search.definition.output.presentationMeta({ query: 'alpha' }, search.value)
    const metaTwo = search.definition.output.presentationMeta({ query: 'alpha' }, search.value)
    assert.deepEqual(metaOne, metaTwo)
    assert.equal(metaOne.shape, 'matches')
    assert.ok(metaOne.files.length > 0)
    assert.ok(metaOne.files[0].matches.every((match) => typeof match.lineNumber === 'number' && typeof match.line === 'string'))
    const view = search.definition.presentResult({ query: 'alpha' }, { content: search.content, isError: false, meta: metaOne })
    assert.equal(view.card, 'search')
    assert.equal(view.shape, 'matches')
    assert.deepEqual(view.files, metaOne.files)
    const callView = search.definition.presentCall({ query: 'alpha' })
    assert.equal(callView.card, 'generic')
    assert.equal(callView.kind, 'search')

    const read = await call('obsidian_read', { note: 'Welcome', limit: 4 })
    const readMeta = read.definition.output.presentationMeta({ note: 'Welcome', limit: 4 }, read.value)
    const readView = read.definition.presentResult({ note: 'Welcome', limit: 4 }, { content: read.content, isError: false, meta: readMeta })
    assert.equal(readView.card, 'read')
    assert.equal(readView.path, 'Welcome.md')
    assert.equal(readView.lines[0].number, 1)

    const write = await call('obsidian_write', { note: 'Cards.md', content: 'card body\n' })
    const writeMeta = write.definition.output.presentationMeta({ note: 'Cards.md', content: 'card body\n' }, write.value)
    const writeView = write.definition.presentResult({ note: 'Cards.md' }, { content: write.content, isError: false, meta: writeMeta })
    assert.equal(writeView.card, 'diff')
    assert.equal(writeView.diffs[0].path, 'Cards.md')
    assert.equal(writeView.diffs[0].oldText, null)
    const writeCall = write.definition.presentCall({ note: 'Cards.md', content: 'card body\n' })
    assert.equal(writeCall.card, 'diff')
    assert.equal(writeCall.diffs[0].newText, 'card body\n')

    assert.deepEqual(JSON.parse(JSON.stringify({ query: 'alpha' })), frozenArgs)
  })
})

test('renderers stay total for empty and unusual results', async () => {
  await withPlugin({}, async ({ call }) => {
    const empty = await call('obsidian_search', { query: 'nothing-matches-this-xyz' })
    assert.equal(empty.value.matches.length, 0)
    assert.match(empty.content[0].text, /No matches/)

    const list = await call('obsidian_list', { mode: 'tags' })
    assert.ok(list.content[0].text.includes('#project'))

    for (const name of Object.keys(RENDERERS)) {
      assert.equal(typeof RENDERERS[name], 'function')
    }
    const definitions = createObsidianTools({ state: null })
    assert.equal(definitions.length, 11)
    for (const definition of definitions) {
      assert.ok(Object.hasOwn(PARAMETER_SCHEMAS, definition.name))
      assert.ok(Object.hasOwn(OUTPUT_SCHEMAS, definition.name))
    }
  })
})

test('apply injects the agent-guidance prompt section through systemPrompt', async () => {
  await withPlugin({}, async ({ sections }) => {
    assert.equal(sections.length, 1)
    const section = sections[0]
    assert.equal(section.name, 'obsidian:agent-guidance')
    assert.equal(typeof section.order, 'number')
    assert.ok(section.text.includes('Consult the vault'))
    assert.ok(section.text.includes('daily note'))
    // The section guides behavior without duplicating tool parameter details.
    assert.ok(!section.text.includes('dryRun'))
  })
})

test('agentGuidance can be disabled in config', async () => {
  await withPlugin({ config: { agentGuidance: false } }, async ({ sections }) => {
    assert.equal(sections.length, 0)
  })
})

test('normalizeConfig validates types and rejects unknown keys', () => {
  assert.deepEqual(normalizeConfig(undefined).vault, null)
  assert.equal(normalizeConfig({ readOnly: true }).readOnly, true)
  assert.deepEqual(normalizeConfig({ vaults: ['C:/a'] }).vaults, ['C:/a'])
  assert.equal(normalizeConfig({ rest: { enabled: false } }).rest.enabled, false)
  assert.throws(() => normalizeConfig({ nope: 1 }), /unknown obsidian config key/)
  assert.throws(() => normalizeConfig({ vault: 5 }), /must be a string/)
  assert.throws(() => normalizeConfig({ vaults: 'x' }), /must be an array/)
  assert.throws(() => normalizeConfig({ indexTtlMs: -1 }), /positive integer/)
  assert.throws(() => normalizeConfig({ rest: { nope: true } }), /unknown obsidian config key/)
})

test('the Config standard schema validates and reports issues', () => {
  const good = Config['~standard'].validate({ vault: '/tmp/x' })
  assert.deepEqual(good.value, {
    vault: '/tmp/x',
    vaults: [],
    excludes: [],
    indexExtensions: [],
    writableExtensions: [],
    attachmentExtensions: [],
    attachmentFolder: null,
    readOnly: false,
    indexTtlMs: null,
    maxCacheBytes: null,
    dailyFolder: null,
    dailyFormat: null,
    agentGuidance: true,
    stateDir: null,
    debug: false,
    rest: { enabled: true, baseURL: null, apiKey: null },
  })
  const bad = Config['~standard'].validate({ vault: 5 })
  assert.ok(Array.isArray(bad.issues) && bad.issues.length === 1)
  assert.match(bad.issues[0].message, /must be a string/)
})
