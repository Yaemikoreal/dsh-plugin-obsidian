/**
 * Obsidian Local REST API client.
 *
 * Optional layer: when the community plugin `obsidian-local-rest-api` is
 * installed in the vault, DeepSeek Harness can also drive the running Obsidian
 * app — open notes, read the active note, use Obsidian's own search (which sees
 * unsaved editor state), reach daily notes, tags, and commands.
 *
 * The API key and port are auto-discovered from the plugin's own `data.json`,
 * so no configuration is required when the plugin is installed.
 *
 * @module dsh-plugin-obsidian/rest
 */

import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'

/** Local REST API failure (unreachable, unauthenticated, or a non-2xx status). */
export class ObsidianRestError extends Error {
  constructor(message, statusCode) {
    super(message)
    this.name = 'ObsidianRestError'
    this.statusCode = statusCode
  }
}

/** Relative path of the Local REST API plugin inside a vault. */
export const REST_PLUGIN_DIR = '.obsidian/plugins/obsidian-local-rest-api'

/**
 * Discover the Local REST API endpoint and key from the vault's plugin data.
 *
 * @param {string} vaultRoot - absolute vault root.
 * @returns {Promise<{ baseURL: string, apiKey: string, securePort: number, insecurePort: number, useInsecure: boolean } | null>}
 *   the discovered endpoint, or null when the plugin is not installed.
 */
export async function discoverRest(vaultRoot) {
  let data
  try {
    data = JSON.parse(await fsp.readFile(path.join(vaultRoot, REST_PLUGIN_DIR, 'data.json'), 'utf8'))
  } catch {
    return null
  }
  if (data === null || typeof data !== 'object') return null
  const apiKey = typeof data.apiKey === 'string' && data.apiKey !== '' ? data.apiKey : null
  if (apiKey === null) return null
  const securePort = Number.isInteger(data.port) ? data.port : 27124
  const insecurePort = Number.isInteger(data.insecurePort) ? data.insecurePort : 27123
  const useInsecure = data.enableInsecureServer === true
  return {
    baseURL: useInsecure ? `http://127.0.0.1:${insecurePort}` : `https://127.0.0.1:${securePort}`,
    apiKey,
    securePort,
    insecurePort,
    useInsecure,
  }
}

/** Percent-encode each path segment of a vault-relative path. */
export function encodeVaultPath(relative) {
  return String(relative ?? '')
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * Thin client over the Obsidian Local REST API.
 */
export class ObsidianRest {
  /**
   * @param {object} options - endpoint configuration.
   * @param {string} options.baseURL - origin, e.g. `http://127.0.0.1:27123`.
   * @param {string} options.apiKey - bearer token from the plugin's data.json.
   * @param {number} [options.timeoutMs] - per-request timeout.
   */
  constructor(options) {
    this.baseURL = typeof options.baseURL === 'string' ? options.baseURL.replace(/\/+$/, '') : null
    this.apiKey = typeof options.apiKey === 'string' && options.apiKey !== '' ? options.apiKey : null
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15_000
    this.label = options.label ?? 'vault'
  }

  get configured() {
    return this.baseURL !== null && this.apiKey !== null
  }

  async request(method, requestPath, options = {}) {
    if (!this.configured) throw new ObsidianRestError('Obsidian Local REST API is not configured (plugin not installed in this vault)')
    const url = new URL(requestPath, `${this.baseURL}/`)
    const transport = url.protocol === 'https:' ? https : http
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: options.accept ?? 'application/json',
    }
    if (options.body !== undefined) headers['Content-Type'] = options.contentType ?? 'text/markdown'
    if (options.operation !== undefined) headers.Operation = options.operation
    if (options.targetType !== undefined) headers['Target-Type'] = options.targetType
    if (options.target !== undefined) headers.Target = encodeURIComponent(options.target)
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : this.timeoutMs
    const signal = options.signal

    return await new Promise((resolve, reject) => {
      const request = transport.request(url, {
        method,
        headers,
        timeout: timeoutMs,
        // The Local REST API ships a self-signed certificate for its HTTPS port.
        rejectUnauthorized: false,
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const status = response.statusCode ?? 0
          if (status >= 200 && status < 300) {
            resolve({ status, headers: response.headers, text })
            return
          }
          if (status === 401) {
            reject(new ObsidianRestError('Obsidian Local REST API rejected the API key (401). Re-copy the key from Obsidian → Settings → Local REST API.', status))
            return
          }
          reject(new ObsidianRestError(`Obsidian Local REST API ${method} ${url.pathname} failed with ${status}: ${text.slice(0, 300)}`, status))
        })
      })
      const onAbort = () => request.destroy(new Error('aborted'))
      if (signal !== undefined) {
        if (signal.aborted) {
          request.destroy(new Error('aborted'))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      request.on('error', (error) => {
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        reject(new ObsidianRestError(`Obsidian Local REST API is unreachable at ${this.baseURL} (${error.message}); is Obsidian running with the Local REST API plugin enabled?`))
      })
      request.on('timeout', () => {
        request.destroy(new Error(`timeout after ${timeoutMs}ms`))
      })
      if (options.body !== undefined) request.write(options.body)
      request.end()
    })
  }

  parseJson(response, fallback = null) {
    try {
      return JSON.parse(response.text)
    } catch {
      return fallback
    }
  }

  /** Whether the API answers and accepts our key. */
  async probe(signal) {
    try {
      const response = await this.request('GET', '/', { signal, timeoutMs: 4000 })
      const data = this.parseJson(response, {})
      return {
        available: true,
        authenticated: data?.authenticated !== false,
        service: typeof data?.service === 'string' ? data.service : 'Obsidian Local REST API',
        versions: Array.isArray(data?.versions) ? data.versions.map(String) : [],
        baseURL: this.baseURL,
      }
    } catch (error) {
      return { available: false, authenticated: false, service: null, versions: [], baseURL: this.baseURL, error: error.message }
    }
  }

  async open(relative, options = {}) {
    const suffix = options.newLeaf === true ? '?newLeaf=true' : ''
    const response = await this.request('POST', `/open/${encodeVaultPath(relative)}${suffix}`, { signal: options.signal, accept: 'application/json' })
    return { status: response.status, path: relative }
  }

  async active(signal) {
    const response = await this.request('GET', '/active/', { signal, accept: 'application/vnd.olrapi.note+json' })
    return this.parseJson(response, null)
  }

  async searchSimple(query, options = {}) {
    const params = new URLSearchParams()
    params.set('query', String(query ?? ''))
    if (Number.isInteger(options.contextLength)) params.set('contextLength', String(options.contextLength))
    const response = await this.request('POST', `/search/simple/?${params.toString()}`, {
      signal: options.signal,
      body: '',
      contentType: 'text/plain',
      accept: 'application/json',
    })
    return this.parseJson(response, [])
  }

  async searchAdvanced(logic, signal) {
    const response = await this.request('POST', '/search/', {
      signal,
      body: JSON.stringify(logic ?? {}),
      contentType: 'application/vnd.olrapi.jsonlogic+json',
      accept: 'application/json',
    })
    return this.parseJson(response, [])
  }

  async readNote(relative, signal) {
    const response = await this.request('GET', `/vault/${encodeVaultPath(relative)}`, {
      signal,
      accept: 'application/vnd.olrapi.note+json',
    })
    return this.parseJson(response, { content: response.text, path: relative })
  }

  async writeNote(relative, content, signal) {
    const response = await this.request('PUT', `/vault/${encodeVaultPath(relative)}`, {
      signal,
      body: String(content ?? ''),
      contentType: 'text/markdown',
    })
    return { status: response.status, path: relative }
  }

  async appendNote(relative, content, signal) {
    const response = await this.request('POST', `/vault/${encodeVaultPath(relative)}`, {
      signal,
      body: String(content ?? ''),
      contentType: 'text/markdown',
    })
    return { status: response.status, path: relative }
  }

  async patchNote(relative, options) {
    const response = await this.request('PATCH', `/vault/${encodeVaultPath(relative)}`, {
      signal: options.signal,
      body: String(options.content ?? ''),
      contentType: 'text/markdown',
      operation: options.operation ?? 'append',
      targetType: options.targetType,
      target: options.target,
    })
    return { status: response.status, path: relative }
  }

  async deleteNote(relative, signal) {
    const response = await this.request('DELETE', `/vault/${encodeVaultPath(relative)}`, { signal })
    return { status: response.status, path: relative }
  }

  async daily(dateValue, signal) {
    const suffix = typeof dateValue === 'string' && dateValue !== '' ? `${encodeURIComponent(dateValue)}/` : ''
    const response = await this.request('GET', `/periodic/daily/${suffix}`, { signal, accept: 'application/json' })
    return this.parseJson(response, { status: response.status })
  }

  async commands(signal) {
    const response = await this.request('GET', '/commands/', { signal, accept: 'application/json' })
    return this.parseJson(response, { commands: [] })
  }

  async runCommand(commandId, signal) {
    const response = await this.request('POST', `/commands/${encodeURIComponent(commandId)}/`, { signal, accept: 'application/json' })
    return { status: response.status, command: commandId, body: this.parseJson(response, null) }
  }

  async tags(signal) {
    const response = await this.request('GET', '/tags/', { signal, accept: 'application/json' })
    return this.parseJson(response, { tags: [] })
  }
}
