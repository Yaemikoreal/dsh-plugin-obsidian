/**
 * Model-facing Obsidian tools.
 *
 * Definitions are raw `ToolDefinition` objects (no `@deepseek-ai/*` imports) so
 * the plugin can be installed into a profile as a linked local checkout. The
 * registry validates canonical outputs against `output.schema`; because raw
 * registration leaves argument validation to the tool, every `execute` first
 * runs `validateArgs` against its own `parameters` schema.
 *
 * @module dsh-plugin-obsidian/tools
 */

import { ToolInputError, prettyJson, truncateText, validateArgs } from './util.js'

/** A nullable JSON-Schema node, expressed through the enforced `oneOf` subset. */
const nullable = (node) => ({ oneOf: [{ type: 'null' }, node] })
const stringArray = { type: 'array', items: { type: 'string' } }

const VAULT_PARAM = { type: 'string', description: 'Vault name or absolute path (defaults to the active vault).' }

const SEARCH_PARAMETERS = {
  type: 'object',
  required: ['query'],
  properties: {
    query: {
      type: 'string',
      description: 'Search text. Terms are space-separated; wrap a phrase in double quotes. For mode "tag" this is the tag name, for "path" a glob, and for "frontmatter" a "key:value" pair.',
    },
    mode: {
      type: 'string',
      enum: ['all', 'any', 'phrase', 'regex', 'tag', 'path', 'frontmatter', 'title'],
      description: 'Matching mode (default "all": every term must appear).',
    },
    limit: { type: 'integer', description: 'Maximum notes to return (default 25, max 200).' },
    context: { type: 'integer', description: 'Context lines to include around each match (0-5, default 0).' },
    maxMatchesPerFile: { type: 'integer', description: 'Maximum matching lines per note (default 8).' },
    caseSensitive: { type: 'boolean', description: 'Match case-sensitively (default false).' },
    folder: { type: 'string', description: 'Restrict to a vault folder.' },
    path: { type: 'string', description: 'Restrict by glob, e.g. "projects/**/*.md".' },
    exclude: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to exclude.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Require every listed tag.' },
    tag: { type: 'string', description: 'Require this tag (alternative to mode "tag").' },
    source: {
      type: 'string',
      enum: ['auto', 'vault', 'app'],
      description: '"vault" searches the indexed files (works when Obsidian is closed, default); "app" uses Obsidian\'s own live search; "auto" prefers the vault index.',
    },
    vault: VAULT_PARAM,
  },
}

const SEARCH_OUTPUT = {
  type: 'object',
  required: ['vault', 'mode', 'query', 'source', 'matches', 'total', 'truncated', 'scanned', 'indexed', 'elapsedMs'],
  properties: {
    vault: { type: 'string' },
    mode: { type: 'string' },
    query: { type: 'string' },
    source: { type: 'string' },
    total: { type: 'integer' },
    truncated: { type: 'boolean' },
    scanned: { type: 'integer' },
    indexed: { type: 'integer' },
    elapsedMs: { type: 'integer' },
    matches: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'title', 'score', 'tags', 'mtimeMs', 'matches'],
        properties: {
          path: { type: 'string' },
          title: { type: 'string' },
          score: { type: 'number' },
          mtimeMs: { type: 'number' },
          tags: stringArray,
          matches: {
            type: 'array',
            items: {
              type: 'object',
              required: ['line', 'text'],
              properties: {
                line: { type: 'integer', description: '1-based line number, or 0 when the source does not report one (Obsidian app search).' },
                text: { type: 'string' },
                context: nullable({
                  type: 'array',
                  items: { type: 'object', required: ['number', 'text'], properties: { number: { type: 'integer' }, text: { type: 'string' } } },
                }),
              },
            },
          },
        },
      },
    },
  },
}

const READ_PARAMETERS = {
  type: 'object',
  required: ['note'],
  properties: {
    note: { type: 'string', description: 'Note path, file name, wikilink target, or frontmatter alias.' },
    offset: { type: 'integer', description: '1-based first line to return (default 1).' },
    limit: { type: 'integer', description: 'Maximum lines to return (default all).' },
    backlinks: { type: 'boolean', description: 'Also compute the notes linking here (default false).' },
    vault: VAULT_PARAM,
  },
}

const LINK_ENTRY = {
  type: 'object',
  required: ['target', 'path', 'title', 'alias', 'heading', 'embed', 'line'],
  properties: {
    target: { type: 'string' },
    path: nullable({ type: 'string' }),
    title: nullable({ type: 'string' }),
    alias: nullable({ type: 'string' }),
    heading: nullable({ type: 'string' }),
    embed: { type: 'boolean' },
    line: { type: 'integer' },
  },
}

const READ_OUTPUT = {
  type: 'object',
  required: ['path', 'title', 'aliases', 'exists', 'totalLines', 'offset', 'lines', 'truncated', 'frontmatter', 'tags', 'headings', 'links', 'backlinks', 'size', 'mtimeMs'],
  properties: {
    path: { type: 'string' },
    title: { type: 'string' },
    aliases: stringArray,
    exists: { type: 'boolean' },
    totalLines: { type: 'integer' },
    offset: { type: 'integer' },
    truncated: { type: 'boolean' },
    size: { type: 'integer' },
    mtimeMs: { type: 'number' },
    lines: {
      type: 'array',
      items: { type: 'object', required: ['number', 'text'], properties: { number: { type: 'integer' }, text: { type: 'string' } } },
    },
    frontmatter: nullable({ type: 'object' }),
    tags: stringArray,
    headings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['level', 'text', 'line', 'slug'],
        properties: { level: { type: 'integer' }, text: { type: 'string' }, line: { type: 'integer' }, slug: { type: 'string' } },
      },
    },
    links: { type: 'array', items: LINK_ENTRY },
    backlinks: nullable({
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'title', 'line', 'alias'],
        properties: { path: { type: 'string' }, title: { type: 'string' }, line: { type: 'integer' }, alias: nullable({ type: 'string' }) },
      },
    }),
  },
}

const LIST_PARAMETERS = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['tree', 'flat', 'tags', 'folders'], description: 'Listing mode (default "tree").' },
    folder: { type: 'string', description: 'Restrict to a vault folder.' },
    path: { type: 'string', description: 'Restrict by glob.' },
    exclude: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to exclude.' },
    depth: { type: 'integer', description: 'Tree depth (default 3).' },
    limit: { type: 'integer', description: 'Maximum entries (default 200).' },
    vault: VAULT_PARAM,
  },
}

const LIST_OUTPUT = {
  type: 'object',
  required: ['vault', 'mode', 'folder', 'entries', 'total', 'truncated', 'notes'],
  properties: {
    vault: { type: 'string' },
    mode: { type: 'string' },
    folder: { type: 'string' },
    total: { type: 'integer' },
    truncated: { type: 'boolean' },
    notes: { type: 'integer' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'name', 'type', 'depth', 'count', 'size', 'mtimeMs', 'title', 'tags'],
        properties: {
          path: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['note', 'folder', 'tag'] },
          depth: { type: 'integer' },
          count: nullable({ type: 'integer' }),
          size: nullable({ type: 'integer' }),
          mtimeMs: nullable({ type: 'number' }),
          title: nullable({ type: 'string' }),
          tags: nullable(stringArray),
        },
      },
    },
  },
}

const LINKS_PARAMETERS = {
  type: 'object',
  required: ['note'],
  properties: {
    note: { type: 'string', description: 'Note path, file name, wikilink target, or alias.' },
    direction: { type: 'string', enum: ['both', 'outgoing', 'incoming'], description: 'Which links to return (default "both").' },
    limit: { type: 'integer', description: 'Maximum links per direction (default 100).' },
    vault: VAULT_PARAM,
  },
}

const LINKS_OUTPUT = {
  type: 'object',
  required: ['vault', 'note', 'title', 'outgoing', 'incoming', 'unresolved', 'total'],
  properties: {
    vault: { type: 'string' },
    note: { type: 'string' },
    title: { type: 'string' },
    total: { type: 'integer' },
    outgoing: { type: 'array', items: LINK_ENTRY },
    incoming: { type: 'array', items: LINK_ENTRY },
    unresolved: { type: 'array', items: LINK_ENTRY },
  },
}

const WRITE_PARAMETERS = {
  type: 'object',
  required: ['note'],
  properties: {
    note: { type: 'string', description: 'Target note path; a missing ".md" extension is added. A reference containing "/" is used exactly; a bare name may resolve to an existing note by file name, wikilink target, or alias. "@daily" targets today\'s daily note and "@daily-YYYY-MM-DD" a specific day, resolved from the vault\'s daily-notes settings (works offline).' },
    content: { type: 'string', description: 'Markdown to write. Omit to change only frontmatter (or to append nothing).' },
    mode: {
      type: 'string',
      enum: ['create', 'overwrite', 'append', 'prepend', 'insert'],
      description: 'create (default when content is given, fails when the note exists), overwrite, append to the end, prepend after frontmatter, or insert after a heading. Omitting mode together with content updates only the frontmatter of an existing note.',
    },
    heading: { type: 'string', description: 'Heading text for mode "insert".' },
    headingFallback: { type: 'string', enum: ['end', 'error'], description: 'What to do when the heading is missing (default "end").' },
    frontmatter: { type: 'object', description: 'Frontmatter keys to merge; a null value deletes the key.' },
    ifExists: {
      type: 'string',
      enum: ['error', 'append', 'overwrite', 'skip'],
      description: 'Behaviour when mode "create" finds an existing note (default "error").',
    },
    dryRun: { type: 'boolean', description: 'Return the diff without writing (default false).' },
    open: { type: 'boolean', description: 'Reveal the note in the running Obsidian app afterwards (default false).' },
    vault: VAULT_PARAM,
  },
}

const WRITE_OUTPUT = {
  type: 'object',
  required: ['path', 'created', 'skipped', 'dryRun', 'mode', 'requestedMode', 'previousExists', 'bytes', 'lines', 'frontmatter', 'diff', 'openedInApp', 'appError'],
  properties: {
    path: { type: 'string' },
    created: { type: 'boolean' },
    skipped: { type: 'boolean' },
    dryRun: { type: 'boolean' },
    mode: { type: 'string' },
    requestedMode: { type: 'string' },
    previousExists: { type: 'boolean' },
    bytes: { type: 'integer' },
    lines: { type: 'integer' },
    openedInApp: { type: 'boolean' },
    appError: nullable({ type: 'string' }),
    frontmatter: nullable({ type: 'object' }),
    diff: nullable({
      type: 'object',
      required: ['oldText', 'newText'],
      properties: { oldText: nullable({ type: 'string' }), newText: { type: 'string' } },
    }),
  },
}

const LINK_REWRITE = {
  type: 'object',
  required: ['path', 'line', 'before', 'after'],
  properties: {
    path: { type: 'string', description: 'File whose text was (or would be) rewritten.' },
    line: { type: 'integer', description: '1-based line of the rewritten link.' },
    before: { type: 'string', description: 'The link occurrence as it was.' },
    after: { type: 'string', description: 'The link occurrence as it is now.' },
  },
}

const MOVE_PARAMETERS = {
  type: 'object',
  required: ['note', 'to'],
  properties: {
    note: { type: 'string', description: 'Note to move or rename: path, file name, wikilink target, or alias.' },
    to: {
      type: 'string',
      description: 'Destination: a folder (end with "/" or name an existing folder) to keep the file name, or a full destination path (missing extension is appended; a bare name renames within the same folder). Folders are created as needed.',
    },
    updateLinks: {
      type: 'boolean',
      description: 'Rewrite wikilinks and markdown links that reference the note — and the note\'s own relative links — so they keep resolving (default true).',
    },
    dryRun: { type: 'boolean', description: 'Plan the move and report the link rewrites without touching files (default false).' },
    vault: VAULT_PARAM,
  },
}

const MOVE_OUTPUT = {
  type: 'object',
  required: ['vault', 'from', 'to', 'renamed', 'moved', 'dryRun', 'updateLinks', 'linksUpdated', 'filesUpdated', 'rewrites', 'rewritesTruncated'],
  properties: {
    vault: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    renamed: { type: 'boolean' },
    moved: { type: 'boolean' },
    dryRun: { type: 'boolean' },
    updateLinks: { type: 'boolean' },
    linksUpdated: { type: 'integer' },
    filesUpdated: { type: 'integer' },
    rewrites: { type: 'array', items: LINK_REWRITE },
    rewritesTruncated: { type: 'boolean' },
  },
}

const DELETE_PARAMETERS = {
  type: 'object',
  required: ['note'],
  properties: {
    note: { type: 'string', description: 'Note to remove: path, file name, wikilink target, or alias.' },
    permanent: {
      type: 'boolean',
      description: 'Delete the file outright instead of moving it into the vault\'s .trash folder (default false: trash, recoverable by hand).',
    },
    dryRun: { type: 'boolean', description: 'Report what would be removed and which links would dangle, without touching files (default false).' },
    vault: VAULT_PARAM,
  },
}

const DELETE_OUTPUT = {
  type: 'object',
  required: ['vault', 'path', 'permanent', 'trashTarget', 'dryRun', 'backlinkCount', 'backlinks', 'backlinksTruncated'],
  properties: {
    vault: { type: 'string' },
    path: { type: 'string' },
    permanent: { type: 'boolean' },
    trashTarget: nullable({ type: 'string', description: 'Vault-relative .trash path when the note was (or would be) trashed.' }),
    dryRun: { type: 'boolean' },
    backlinkCount: { type: 'integer' },
    backlinks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'title', 'line'],
        properties: { path: { type: 'string' }, title: { type: 'string' }, line: { type: 'integer' } },
      },
    },
    backlinksTruncated: { type: 'boolean' },
  },
}

const ATTACH_PARAMETERS = {
  type: 'object',
  required: ['source'],
  properties: {
    source: { type: 'string', description: 'Absolute local file path to copy into the vault (e.g. an image this session generated or downloaded).' },
    name: { type: 'string', description: 'Target file name inside the vault (default: the source file name; missing extension is appended).' },
    folder: {
      type: 'string',
      description: 'Vault-relative destination folder for this call (default: the vault\'s own attachment setting from .obsidian/app.json; "./" means the folder of the "note", "/" the vault root).',
    },
    note: { type: 'string', description: 'Note path, file name, wikilink target, or alias. When given, the ready-made embed link is appended to this note.' },
    dryRun: { type: 'boolean', description: 'Plan the copy and report the destination and embed link without touching files (default false).' },
    vault: VAULT_PARAM,
  },
}

const ATTACH_OUTPUT = {
  type: 'object',
  required: ['vault', 'source', 'path', 'name', 'folder', 'bytes', 'embed', 'note', 'appendedToNote', 'dryRun'],
  properties: {
    vault: { type: 'string' },
    source: { type: 'string' },
    path: { type: 'string' },
    name: { type: 'string' },
    folder: { type: 'string' },
    bytes: { type: 'integer' },
    embed: { type: 'string' },
    note: nullable({ type: 'string' }),
    appendedToNote: { type: 'boolean' },
    dryRun: { type: 'boolean' },
  },
}

const VAULTS_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'use', 'add', 'status', 'refresh'],
      description: 'list (default), use a vault as active, add a vault by path, status of the active vault, or refresh discovery.',
    },
    vault: VAULT_PARAM,
    path: { type: 'string', description: 'Absolute vault directory for action "add".' },
    refresh: { type: 'boolean', description: 'Force a fresh index scan for action "status".' },
  },
}

const VAULTS_OUTPUT = {
  type: 'object',
  required: ['active', 'vaults', 'rest', 'settingsPath'],
  properties: {
    settingsPath: { type: 'string' },
    active: nullable({
      type: 'object',
      required: ['name', 'path', 'notes', 'readOnly'],
      properties: { name: { type: 'string' }, path: { type: 'string' }, notes: { type: 'integer' }, readOnly: { type: 'boolean' } },
    }),
    rest: {
      type: 'object',
      required: ['available', 'authenticated', 'baseURL', 'error'],
      properties: {
        available: { type: 'boolean' },
        authenticated: { type: 'boolean' },
        baseURL: nullable({ type: 'string' }),
        error: nullable({ type: 'string' }),
      },
    },
    vaults: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'path', 'active', 'open', 'notes', 'readOnly', 'sources'],
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          active: { type: 'boolean' },
          open: { type: 'boolean' },
          notes: { type: 'integer' },
          readOnly: { type: 'boolean' },
          sources: stringArray,
        },
      },
    },
  },
}

const APP_PARAMETERS = {
  type: 'object',
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'open', 'active', 'search', 'daily', 'command', 'tags'],
      description: 'Live Obsidian app action: status, open a note, read the active note, Obsidian search, open the daily note, list/run commands, or list tags.',
    },
    note: { type: 'string', description: 'Note to open (action "open").' },
    query: { type: 'string', description: 'Search text (action "search") or a command-name filter (action "command").' },
    command: { type: 'string', description: 'Command id to run (action "command"). Omit to list commands.' },
    date: { type: 'string', description: 'Date like "2026-10-10" for action "daily" (default today).' },
    contextLength: { type: 'integer', description: 'Context characters for action "search" (default 120).' },
    limit: { type: 'integer', description: 'Maximum items to return (default 50).' },
    vault: VAULT_PARAM,
  },
}

const APP_OUTPUT = {
  type: 'object',
  required: ['vault', 'action', 'available', 'authenticated', 'baseURL', 'message', 'note', 'content', 'frontmatter', 'tags', 'tagCounts', 'commands', 'results'],
  properties: {
    vault: { type: 'string' },
    action: { type: 'string' },
    available: { type: 'boolean' },
    authenticated: { type: 'boolean' },
    baseURL: nullable({ type: 'string' }),
    message: nullable({ type: 'string' }),
    note: nullable({ type: 'string' }),
    content: nullable({ type: 'string' }),
    frontmatter: nullable({ type: 'object' }),
    tags: nullable(stringArray),
    tagCounts: nullable({
      type: 'array',
      items: { type: 'object', required: ['name', 'count'], properties: { name: { type: 'string' }, count: { type: 'integer' } } },
    }),
    commands: nullable({
      type: 'array',
      items: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } },
    }),
    results: nullable({
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'matches'],
        properties: {
          path: { type: 'string' },
          matches: {
            type: 'array',
            items: { type: 'object', required: ['line', 'text'], properties: { line: { type: 'integer' }, text: { type: 'string' } } },
          },
        },
      },
    }),
  },
}

/**
 * Build every Obsidian tool definition.
 *
 * @param {{ state: object }} deps - plugin state accessors created by the entry module.
 * @returns {object[]} raw `ToolDefinition` objects ready for `ctx.tools.register`.
 */
export function createObsidianTools({ state }) {
  return [
    vaultsTool(state),
    searchTool(state),
    readTool(state),
    listTool(state),
    linksTool(state),
    writeTool(state),
    moveTool(state),
    deleteTool(state),
    attachTool(state),
    appTool(state),
  ]
}

function vaultsTool(state) {
  return {
    name: 'obsidian_vaults',
    description: 'List, inspect, add, or switch the Obsidian vaults this harness can read and write. Also reports whether the live Obsidian app bridge (Local REST API) is available.',
    parameters: VAULTS_PARAMETERS,
    output: {
      schema: VAULTS_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderVaults(value) }],
    },
    isConcurrencySafe: (args) => args?.action !== 'refresh',
    async execute(rawArgs, exec) {
      const args = validateArgs(VAULTS_PARAMETERS, rawArgs)
      const action = args.action ?? 'list'
      if (action === 'add') {
        if (typeof args.path !== 'string' || args.path.trim() === '') {
          throw new ToolInputError('action "add" needs an absolute vault path in "path"')
        }
        await state.addVault(args.path)
      } else if (action === 'use') {
        if (typeof args.vault !== 'string' || args.vault.trim() === '') {
          throw new ToolInputError('action "use" needs a vault name or path in "vault"')
        }
        await state.useVault(args.vault)
      } else if (action === 'refresh') {
        await state.refresh()
      }
      if (action === 'status' && args.refresh === true) {
        const vault = await state.getVault(args.vault)
        await vault.scan({ force: true, signal: exec.signal })
      }
      const status = await state.status({ vault: args.vault, signal: exec.signal })
      return {
        settingsPath: state.settingsPath,
        active: status.active,
        rest: status.rest,
        vaults: status.vaults,
      }
    },
  }
}

function searchTool(state) {
  return {
    name: 'obsidian_search',
    description: 'Search Obsidian notes fast: full text (all/any/phrase/regex), tags, paths, frontmatter, or titles. Searches the indexed vault by default and works even when Obsidian is closed; set source "app" to use Obsidian\'s own live search instead.',
    parameters: SEARCH_PARAMETERS,
    output: {
      schema: SEARCH_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderSearch(value) }],
      presentationMeta: (_args, value) => ({
        shape: 'matches',
        title: `Obsidian search: ${value.query}`,
        truncated: value.truncated,
        total: value.total,
        files: value.matches.slice(0, 50).map((match) => ({
          path: match.path,
          matches: match.matches.map((entry) => ({ lineNumber: entry.line, line: entry.text })),
        })),
      }),
    },
    isConcurrencySafe: () => true,
    presentCall(args) {
      return { card: 'generic', kind: 'search', title: `Obsidian search: ${String(args?.query ?? '')}` }
    },
    presentResult(_args, result) {
      const meta = result?.meta
      if (meta === null || typeof meta !== 'object' || !Array.isArray(meta.files)) return undefined
      return {
        card: 'search',
        shape: 'matches',
        title: typeof meta.title === 'string' ? meta.title : 'Obsidian search',
        files: meta.files,
        truncated: meta.truncated === true,
        total: typeof meta.total === 'number' ? meta.total : meta.files.length,
      }
    },
    async execute(rawArgs, exec) {
      const args = validateArgs(SEARCH_PARAMETERS, rawArgs)
      const vault = await state.getVault(args.vault)
      const source = args.source ?? 'auto'
      if (source === 'app') {
        const rest = await state.getRest(args.vault)
        if (rest === null) throw new ToolInputError('source "app" needs the Obsidian Local REST API plugin; use source "vault" for filesystem search')
        const raw = await rest.searchSimple(args.query, { contextLength: 120, signal: exec.signal })
        return normalizeAppSearch(vault.name, args.query, raw, args.limit)
      }
      const result = await vault.search(args, exec.signal)
      return {
        vault: result.vault,
        mode: result.mode,
        query: result.query,
        source: 'vault',
        matches: result.matches,
        total: result.total,
        truncated: result.truncated,
        scanned: result.scanned,
        indexed: result.indexed,
        elapsedMs: result.elapsedMs,
      }
    },
  }
}

function readTool(state) {
  return {
    name: 'obsidian_read',
    description: 'Read one Obsidian note by path, file name, wikilink target, or alias. Returns the requested line window plus frontmatter, tags, headings, links, and optionally backlinks.',
    parameters: READ_PARAMETERS,
    output: {
      schema: READ_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderRead(value) }],
      presentationMeta: (_args, value) => ({
        path: value.path,
        offset: value.offset,
        totalLines: value.totalLines,
        lines: value.lines.slice(0, 400).map((line) => ({ number: line.number, text: line.text })),
      }),
    },
    isConcurrencySafe: () => true,
    presentCall(args) {
      return { card: 'generic', kind: 'read', title: `Obsidian read: ${String(args?.note ?? '')}` }
    },
    presentResult(_args, result) {
      const meta = result?.meta
      if (meta === null || typeof meta !== 'object' || typeof meta.path !== 'string') return undefined
      return {
        card: 'read',
        title: `Obsidian: ${meta.path}`,
        path: meta.path,
        offset: typeof meta.offset === 'number' ? meta.offset : 1,
        totalLines: typeof meta.totalLines === 'number' ? meta.totalLines : 0,
        lines: Array.isArray(meta.lines) ? meta.lines : [],
        lang: 'markdown',
      }
    },
    async execute(rawArgs, exec) {
      const args = validateArgs(READ_PARAMETERS, rawArgs)
      const vault = await state.getVault(args.vault)
      return await vault.readNote(args, exec.signal)
    },
  }
}

function listTool(state) {
  return {
    name: 'obsidian_list',
    description: 'Browse an Obsidian vault: folder tree, flat note list, tag cloud with counts, or folder list with note counts.',
    parameters: LIST_PARAMETERS,
    output: {
      schema: LIST_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderList(value) }],
      presentationMeta: (_args, value) => ({
        paths: value.entries.slice(0, 200).map((entry) => entry.path),
        truncated: value.truncated,
        total: value.total,
      }),
    },
    isConcurrencySafe: () => true,
    presentCall(args) {
      return { card: 'generic', kind: 'search', title: `Obsidian list: ${String(args?.mode ?? 'tree')} ${String(args?.folder ?? '')}`.trim() }
    },
    presentResult(_args, result) {
      const meta = result?.meta
      if (meta === null || typeof meta !== 'object' || !Array.isArray(meta.paths)) return undefined
      return {
        card: 'search',
        shape: 'paths',
        title: 'Obsidian vault',
        paths: meta.paths,
        truncated: meta.truncated === true,
        total: typeof meta.total === 'number' ? meta.total : meta.paths.length,
      }
    },
    async execute(rawArgs, exec) {
      const args = validateArgs(LIST_PARAMETERS, rawArgs)
      const vault = await state.getVault(args.vault)
      const result = await vault.list(args, exec.signal)
      return {
        ...result,
        entries: result.entries.map((entry) => ({
          path: entry.path,
          name: entry.name,
          type: entry.type,
          depth: entry.depth,
          count: entry.count ?? null,
          size: entry.size ?? null,
          mtimeMs: entry.mtimeMs ?? null,
          title: entry.title ?? null,
          tags: entry.tags ?? null,
        })),
      }
    },
  }
}

function linksTool(state) {
  return {
    name: 'obsidian_links',
    description: 'Show the link neighbourhood of a note: outgoing wikilinks and markdown links, incoming backlinks, and links that point at notes which do not exist yet.',
    parameters: LINKS_PARAMETERS,
    output: {
      schema: LINKS_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderLinks(value) }],
    },
    isConcurrencySafe: () => true,
    presentCall(args) {
      return { card: 'generic', kind: 'search', title: `Obsidian links: ${String(args?.note ?? '')}` }
    },
    async execute(rawArgs, exec) {
      const args = validateArgs(LINKS_PARAMETERS, rawArgs)
      const vault = await state.getVault(args.vault)
      return await vault.links(args, exec.signal)
    },
  }
}

function writeTool(state) {
  return {
    name: 'obsidian_write',
    description: 'Create or update an Obsidian note with an atomic write: create, overwrite, append, prepend, or insert after a heading, with optional frontmatter merge and a dry-run diff preview. Optionally reveals the note in the running Obsidian app.',
    parameters: WRITE_PARAMETERS,
    output: {
      schema: WRITE_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderWrite(value) }],
      presentationMeta: (_args, value) => ({
        path: value.path,
        oldText: value.diff === null ? null : value.diff.oldText,
        newText: value.diff === null ? '' : value.diff.newText,
        created: value.created,
        dryRun: value.dryRun,
      }),
    },
    isConcurrencySafe: () => false,
    presentCall(args) {
      const note = String(args?.note ?? 'note')
      return {
        card: 'diff',
        title: `Obsidian write: ${note}`,
        diffs: [{ path: note, oldText: null, newText: String(args?.content ?? '') }],
      }
    },
    presentResult(_args, result) {
      const meta = result?.meta
      if (meta === null || typeof meta !== 'object' || typeof meta.path !== 'string') return undefined
      return {
        card: 'diff',
        title: `Obsidian write: ${meta.path}`,
        diffs: [{ path: meta.path, oldText: meta.oldText ?? null, newText: meta.newText ?? '' }],
      }
    },
    async execute(rawArgs, exec) {
      const args = validateArgs(WRITE_PARAMETERS, rawArgs)
      const vault = await state.getVault(args.vault)
      const result = await vault.writeNote(args, exec.signal)
      let openedInApp = false
      let appError = null
      if (args.open === true && result.dryRun !== true && result.skipped !== true) {
        try {
          const rest = await state.getRest(args.vault)
          if (rest === null) appError = 'Obsidian Local REST API is not available'
          else {
            await rest.open(result.path, { signal: exec.signal })
            openedInApp = true
          }
        } catch (error) {
          appError = error.message
        }
      }
      return { ...result, openedInApp, appError }
    },
  }
}

function moveTool(state) {
  return {
    name: 'obsidian_move',
    description: 'Move or rename an Obsidian note inside the vault (folders are created as needed) and rewrite the wikilinks and markdown links that reference it — plus the moved note\'s own relative links — so everything keeps resolving, like Obsidian\'s own rename. Supports a dry-run preview. To remove a note use obsidian_delete.',
    parameters: MOVE_PARAMETERS,
    output: {
      schema: MOVE_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderMove(value) }],
    },
    isConcurrencySafe: () => false,
    presentCall(args) {
      return { card: 'generic', kind: 'other', title: `Obsidian move: ${String(args?.note ?? '')} → ${String(args?.to ?? '')}` }
    },
    async execute(rawArgs, exec) {
      const args = validateArgs(MOVE_PARAMETERS, rawArgs)
      const vault = await state.getVault(args.vault)
      return await vault.moveNote(args, exec.signal)
    },
  }
}

function deleteTool(state) {
  return {
    name: 'obsidian_delete',
    description: 'Remove an Obsidian note. By default the note is moved into the vault\'s .trash folder (recoverable by hand); pass permanent: true to delete the file outright. Reports the notes that link to it, because their links will dangle. Preview with dryRun: true first.',
    parameters: DELETE_PARAMETERS,
    output: {
      schema: DELETE_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderDelete(value) }],
    },
    isConcurrencySafe: () => false,
    presentCall(args) {
      return { card: 'generic', kind: 'other', title: `Obsidian delete: ${String(args?.note ?? '')}` }
    },
    async execute(rawArgs, exec) {
      const args = validateArgs(DELETE_PARAMETERS, rawArgs)
      const vault = await state.getVault(args.vault)
      return await vault.deleteNote(args, exec.signal)
    },
  }
}

function attachTool(state) {
  return {
    name: 'obsidian_attach',
    description: 'Copy a local file (image, PDF, audio, ...) into the Obsidian vault as an attachment, honoring the vault\'s own attachment-folder setting; returns the vault-relative path and a ready-to-paste `![[name]]` embed link, and can append that link to a note in the same call. Network files must be downloaded to a local path first.',
    parameters: ATTACH_PARAMETERS,
    output: {
      schema: ATTACH_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderAttach(value) }],
    },
    isConcurrencySafe: () => false,
    presentCall(args) {
      return { card: 'generic', kind: 'other', title: `Obsidian attach: ${String(args?.source ?? '')}` }
    },
    async execute(rawArgs, exec) {
      const args = validateArgs(ATTACH_PARAMETERS, rawArgs)
      const vault = await state.getVault(args.vault)
      return await vault.attachFile(args, exec.signal)
    },
  }
}

function appTool(state) {
  return {
    name: 'obsidian_app',
    description: 'Talk to the running Obsidian app through the Local REST API plugin: check the bridge, open a note, read the active note, run Obsidian\'s live search, open the daily note, list or run commands, and list tags.',
    parameters: APP_PARAMETERS,
    output: {
      schema: APP_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderApp(value) }],
    },
    isConcurrencySafe: (args) => args?.action === 'status' || args?.action === 'active' || args?.action === 'tags' || args?.action === 'search',
    presentCall(args) {
      return { card: 'generic', kind: 'other', title: `Obsidian app: ${String(args?.action ?? 'status')}` }
    },
    async execute(rawArgs, exec) {
      const args = validateArgs(APP_PARAMETERS, rawArgs)
      const vault = await state.getVault(args.vault)
      const action = args.action
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 500) : 50
      const rest = await state.getRest(args.vault)
      const base = {
        vault: vault.name,
        action,
        // `available` reports whether the running app actually answered.
        available: false,
        authenticated: false,
        baseURL: rest === null ? null : rest.baseURL,
        message: null,
        note: null,
        content: null,
        frontmatter: null,
        tags: null,
        tagCounts: null,
        commands: null,
        results: null,
      }
      if (rest === null) {
        return {
          ...base,
          message: 'The Obsidian Local REST API plugin is not installed in this vault. Install and enable "Local REST API" in Obsidian, then retry. Filesystem tools (obsidian_search/read/write/list/links) work without it.',
        }
      }
      const probe = await rest.probe(exec.signal)
      if (probe.available !== true) {
        return { ...base, message: `${probe.error ?? 'Obsidian is not reachable'} — filesystem tools still work.` }
      }
      base.available = true
      base.authenticated = probe.authenticated === true
      if (action === 'status') {
        return { ...base, message: `Connected to ${probe.service} (${(probe.versions ?? []).join(', ') || 'unknown version'})` }
      }
      if (action === 'open') {
        if (typeof args.note !== 'string' || args.note.trim() === '') throw new ToolInputError('action "open" needs "note"')
        const rel = await vault.resolveNote(args.note, exec.signal)
        const target = rel ?? vault.normalizeNewPath(args.note)
        await rest.open(target, { signal: exec.signal })
        return { ...base, note: target, message: `Opened ${target} in Obsidian` }
      }
      if (action === 'active') {
        const note = await rest.active(exec.signal)
        const notePath = typeof note?.path === 'string' ? note.path : null
        return {
          ...base,
          note: notePath,
          content: typeof note?.content === 'string' ? truncateText(note.content, 20000) : null,
          frontmatter: note?.frontmatter !== null && typeof note?.frontmatter === 'object' ? note.frontmatter : null,
          tags: Array.isArray(note?.tags) ? note.tags.map(String) : null,
          message: notePath === null ? 'No active note' : `Active note: ${notePath}`,
        }
      }
      if (action === 'search') {
        if (typeof args.query !== 'string' || args.query.trim() === '') throw new ToolInputError('action "search" needs "query"')
        const contextLength = Number.isInteger(args.contextLength) ? Math.max(0, Math.min(args.contextLength, 1000)) : 120
        const raw = await rest.searchSimple(args.query, { contextLength, signal: exec.signal })
        const results = normalizeAppSearchResults(raw, limit)
        return { ...base, results, message: `${results.length} note(s) matched in the running app` }
      }
      if (action === 'daily') {
        const rel = await vault.dailyPath(args.date, exec.signal)
        const response = await rest.daily(args.date, exec.signal)
        return { ...base, note: rel, message: `Opened daily note ${rel} (${JSON.stringify(response).slice(0, 200)})` }
      }
      if (action === 'command') {
        if (typeof args.command === 'string' && args.command !== '') {
          const response = await rest.runCommand(args.command, exec.signal)
          return { ...base, message: `Ran command ${args.command} (status ${response.status})` }
        }
        const payload = await rest.commands(exec.signal)
        const all = Array.isArray(payload?.commands) ? payload.commands : []
        const filter = typeof args.query === 'string' ? args.query.toLowerCase() : ''
        const commands = all
          .filter((command) => filter === '' || String(command?.name ?? '').toLowerCase().includes(filter) || String(command?.id ?? '').toLowerCase().includes(filter))
          .slice(0, limit)
          .map((command) => ({ id: String(command?.id ?? ''), name: String(command?.name ?? '') }))
        return { ...base, commands, message: `${commands.length} of ${all.length} command(s)` }
      }
      if (action === 'tags') {
        const payload = await rest.tags(exec.signal)
        const all = Array.isArray(payload?.tags) ? payload.tags : []
        const tagCounts = all
          .slice(0, limit)
          .map((tag) => ({ name: String(tag?.name ?? ''), count: Number.isFinite(tag?.count) ? Math.trunc(tag.count) : 0 }))
        return { ...base, tagCounts, message: `${all.length} tag(s) in the running app` }
      }
      throw new ToolInputError(`unsupported action: ${action}`)
    },
  }
}

function normalizeAppSearch(vaultName, query, raw, limit) {
  const matches = normalizeAppSearchResults(raw, Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 25)
  return {
    vault: vaultName,
    mode: 'app',
    query,
    source: 'app',
    matches: matches.map((entry) => ({
      path: entry.path,
      title: entry.path.replace(/\.[^./]+$/, ''),
      score: entry.matches.length,
      tags: [],
      mtimeMs: 0,
      matches: entry.matches,
    })),
    total: matches.length,
    truncated: matches.length >= (Number.isInteger(limit) ? limit : 25),
    scanned: matches.length,
    indexed: 0,
    elapsedMs: 0,
  }
}

function normalizeAppSearchResults(raw, limit) {
  const list = Array.isArray(raw) ? raw : []
  return list.slice(0, limit).map((item) => {
    const file = typeof item?.filename === 'string' ? item.filename : (typeof item?.path === 'string' ? item.path : '')
    const rawMatches = Array.isArray(item?.matches) ? item.matches : []
    return {
      path: file,
      matches: rawMatches.slice(0, 8).map((match) => ({
        line: Number.isInteger(match?.line) ? match.line : 0,
        text: truncateText(String(match?.context ?? match?.match ?? '').trim().replace(/\s+/g, ' '), 300),
      })),
    }
  })
}

function renderVaults(value) {
  const lines = [`Obsidian vaults (${value.vaults.length}) — settings: ${value.settingsPath}`]
  for (const vault of value.vaults) {
    lines.push(`${vault.active ? '*' : ' '} ${vault.name} — ${vault.path} (${vault.notes} notes${vault.open ? ', open in Obsidian' : ''}${vault.readOnly ? ', read-only' : ''})`)
  }
  lines.push(`Live app bridge: ${value.rest.available ? `available at ${value.rest.baseURL}` : `unavailable${value.rest.error === null ? '' : ` (${value.rest.error})`}`}`)
  return truncateText(lines.join('\n'), 20000)
}

function renderSearch(value) {
  if (value.matches.length === 0) {
    return `No matches for ${JSON.stringify(value.query)} in vault "${value.vault}" (mode ${value.mode}, scanned ${value.scanned} of ${value.indexed} notes, ${value.elapsedMs}ms).`
  }
  const lines = [`${value.total} note(s) matched ${JSON.stringify(value.query)} in vault "${value.vault}" (mode ${value.mode}, source ${value.source}, ${value.elapsedMs}ms)`]
  for (const match of value.matches) {
    lines.push(`${match.path}  [score ${match.score}]${match.tags.length > 0 ? `  #${match.tags.join(' #')}` : ''}`)
    for (const entry of match.matches.slice(0, 6)) {
      lines.push(`  ${entry.line === 0 ? '?' : entry.line}: ${entry.text}`)
    }
  }
  if (value.truncated) lines.push(`… showing ${value.matches.length} of ${value.total} notes`)
  return truncateText(lines.join('\n'), 20000)
}

function renderRead(value) {
  const lines = [`${value.path} — "${value.title}" (${value.totalLines} lines, ${value.size} bytes${value.aliases.length > 0 ? `, aliases: ${value.aliases.join(', ')}` : ''})`]
  if (value.tags.length > 0) lines.push(`tags: ${value.tags.map((tag) => `#${tag}`).join(' ')}`)
  if (value.frontmatter !== null) lines.push(`frontmatter: ${JSON.stringify(value.frontmatter)}`)
  lines.push('')
  for (const line of value.lines) lines.push(`${String(line.number).padStart(4)}| ${line.text}`)
  if (value.truncated) lines.push(`… window ends at line ${value.offset + value.lines.length - 1} of ${value.totalLines}`)
  if (value.backlinks !== null) {
    lines.push('', `backlinks (${value.backlinks.length}):`)
    for (const backlink of value.backlinks) lines.push(`  ${backlink.path}:${backlink.line}`)
  }
  return truncateText(lines.join('\n'), 20000)
}

function renderList(value) {
  const lines = [`vault "${value.vault}" — ${value.mode} listing (${value.total} entries, ${value.notes} notes)`]
  for (const entry of value.entries) {
    if (entry.type === 'note') lines.push(`${'  '.repeat(entry.depth)}- ${entry.name}${entry.title === null ? '' : ` (${entry.title})`}`)
    else if (entry.type === 'tag') lines.push(`#${entry.name} (${entry.count ?? 0})`)
    else lines.push(`${'  '.repeat(entry.depth)}${entry.name}/${entry.count === null ? '' : ` (${entry.count})`}`)
  }
  if (value.truncated) lines.push(`… showing ${value.entries.length} of ${value.total} entries`)
  return truncateText(lines.join('\n'), 20000)
}

function renderLinks(value) {
  const lines = [`${value.note} — "${value.title}"`]
  lines.push(`outgoing (${value.outgoing.length}):`)
  for (const link of value.outgoing) lines.push(`  → ${link.path}${link.alias === null ? '' : ` (${link.alias})`}`)
  lines.push(`incoming (${value.incoming.length}):`)
  for (const link of value.incoming) lines.push(`  ← ${link.path}:${link.line}`)
  if (value.unresolved.length > 0) {
    lines.push(`unresolved (${value.unresolved.length}):`)
    for (const link of value.unresolved) lines.push(`  ? [[${link.target}]] at line ${link.line}`)
  }
  return truncateText(lines.join('\n'), 20000)
}

function renderWrite(value) {
  if (value.skipped) return `Skipped ${value.path} (already exists, ifExists "skip")`
  const verb = value.dryRun ? 'Would write' : (value.created ? 'Created' : 'Updated')
  const lines = [`${verb} ${value.path} (mode ${value.mode}, ${value.lines} lines, ${value.bytes} bytes)`]
  if (value.frontmatter !== null) lines.push(`frontmatter: ${JSON.stringify(value.frontmatter)}`)
  if (value.openedInApp) lines.push('Opened in Obsidian')
  if (value.appError !== null) lines.push(`Obsidian app note: ${value.appError}`)
  if (value.dryRun && value.diff !== null) lines.push('', truncateText(value.diff.newText, 4000))
  return truncateText(lines.join('\n'), 20000)
}

function renderMove(value) {
  const verb = value.dryRun ? 'Would move' : 'Moved'
  const what = value.renamed && value.moved ? 'moved + renamed' : (value.renamed ? 'renamed' : (value.moved ? 'moved' : 'changed'))
  const lines = [`${verb} ${value.from} → ${value.to} (${what}${value.updateLinks ? '' : ', links untouched'})`]
  if (value.linksUpdated === 0) {
    if (value.updateLinks) lines.push('No links needed updating.')
  } else {
    lines.push(`link rewrites: ${value.linksUpdated} in ${value.filesUpdated} file(s)`)
    for (const rewrite of value.rewrites.slice(0, 20)) {
      lines.push(`  ${rewrite.path}:${rewrite.line}  ${rewrite.before} → ${rewrite.after}`)
    }
    if (value.rewritesTruncated) lines.push('  … more rewrites not shown')
  }
  return truncateText(lines.join('\n'), 20000)
}

function renderDelete(value) {
  const verb = value.dryRun ? 'Would remove' : (value.permanent ? 'Permanently deleted' : 'Moved to trash')
  const lines = [`${verb} ${value.path}${value.trashTarget === null ? '' : ` → ${value.trashTarget}`}`]
  if (value.backlinkCount === 0) lines.push('No other note links here.')
  else {
    lines.push(`dangling backlinks after removal: ${value.backlinkCount}`)
    for (const backlink of value.backlinks) lines.push(`  ${backlink.path}:${backlink.line} (${backlink.title})`)
    if (value.backlinksTruncated) lines.push('  … more not shown')
  }
  return truncateText(lines.join('\n'), 20000)
}

function renderAttach(value) {
  const verb = value.dryRun ? 'Would attach' : 'Attached'
  const lines = [`${verb} ${value.source} → ${value.path} (${value.bytes} bytes)`]
  lines.push(`embed link: ${value.embed}`)
  if (value.note !== null) {
    lines.push(value.appendedToNote ? `Appended to ${value.note}` : `Would append to ${value.note}`)
  }
  return truncateText(lines.join('\n'), 20000)
}

function renderApp(value) {
  const lines = [`Obsidian app — ${value.action} (vault "${value.vault}")`]
  lines.push(`bridge: ${value.available ? `available at ${value.baseURL}` : 'unavailable'}${value.authenticated ? ', authenticated' : ''}`)
  if (value.message !== null) lines.push(value.message)
  if (value.note !== null) lines.push(`note: ${value.note}`)
  if (value.frontmatter !== null) lines.push(`frontmatter: ${JSON.stringify(value.frontmatter)}`)
  if (value.tags !== null) lines.push(`tags: ${value.tags.join(', ')}`)
  if (value.tagCounts !== null) lines.push(value.tagCounts.map((tag) => `#${tag.name} (${tag.count})`).join(' '))
  if (value.commands !== null) {
    for (const command of value.commands.slice(0, 50)) lines.push(`  ${command.id} — ${command.name}`)
  }
  if (value.results !== null) {
    for (const result of value.results) {
      lines.push(result.path)
      for (const match of result.matches.slice(0, 5)) lines.push(`  ${match.line === 0 ? '?' : match.line}: ${match.text}`)
    }
  }
  if (value.content !== null) lines.push('', truncateText(value.content, 4000))
  return truncateText(lines.join('\n'), 20000)
}

/** Exposed for tests: the raw parameter schemas. */
export const PARAMETER_SCHEMAS = {
  obsidian_vaults: VAULTS_PARAMETERS,
  obsidian_search: SEARCH_PARAMETERS,
  obsidian_read: READ_PARAMETERS,
  obsidian_list: LIST_PARAMETERS,
  obsidian_links: LINKS_PARAMETERS,
  obsidian_write: WRITE_PARAMETERS,
  obsidian_move: MOVE_PARAMETERS,
  obsidian_delete: DELETE_PARAMETERS,
  obsidian_attach: ATTACH_PARAMETERS,
  obsidian_app: APP_PARAMETERS,
}

/** Exposed for tests: the canonical output schemas. */
export const OUTPUT_SCHEMAS = {
  obsidian_vaults: VAULTS_OUTPUT,
  obsidian_search: SEARCH_OUTPUT,
  obsidian_read: READ_OUTPUT,
  obsidian_list: LIST_OUTPUT,
  obsidian_links: LINKS_OUTPUT,
  obsidian_write: WRITE_OUTPUT,
  obsidian_move: MOVE_OUTPUT,
  obsidian_delete: DELETE_OUTPUT,
  obsidian_attach: ATTACH_OUTPUT,
  obsidian_app: APP_OUTPUT,
}

/** Exposed for tests: the renderers, keyed by tool name. */
export const RENDERERS = {
  obsidian_vaults: renderVaults,
  obsidian_search: renderSearch,
  obsidian_read: renderRead,
  obsidian_list: renderList,
  obsidian_links: renderLinks,
  obsidian_write: renderWrite,
  obsidian_move: renderMove,
  obsidian_delete: renderDelete,
  obsidian_attach: renderAttach,
  obsidian_app: renderApp,
}

export { prettyJson }
