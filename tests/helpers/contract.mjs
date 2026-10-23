/**
 * Test helper: validate schemas and canonical outputs against the harness's own
 * JSON-Schema subset implementation when a built `@deepseek-ai/dsh-tools` is
 * reachable, and fall back to an equivalent local checker otherwise.
 */

import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CANDIDATES = [
  process.env.DSH_TOOLS_LIB,
  'D:/tools/deepseek-harness/packages/core/tools/lib/index.js',
  path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
].filter((entry) => typeof entry === 'string' && entry !== '')

/** Load the harness validators when available. */
export async function loadContract() {
  for (const candidate of CANDIDATES) {
    try {
      const module = await import(pathToFileURL(candidate).href)
      if (typeof module.assertSupportedJsonSchema === 'function' && typeof module.validateJsonSchemaValue === 'function') {
        return {
          source: candidate,
          assertSupportedJsonSchema: module.assertSupportedJsonSchema,
          validateJsonSchemaValue: module.validateJsonSchemaValue,
        }
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** Assert a schema belongs to the enforced subset (real implementation when available). */
export function assertSchema(contract, schema, label) {
  if (contract === null) {
    const violations = checkSchema(schema)
    if (violations.length > 0) throw new Error(`${label}: ${violations.join('; ')}`)
    return
  }
  contract.assertSupportedJsonSchema(schema)
}

/** Return path-qualified violations for one value against one schema. */
export function validateValue(contract, schema, value, label = 'value') {
  if (contract !== null) return contract.validateJsonSchemaValue(schema, value, label)
  const violations = []
  walkValue(schema, value, label, violations)
  return violations
}

/* ------------------------------------------------------------------ *
 * Local fallback: the same subset the harness enforces.
 * ------------------------------------------------------------------ */

const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const CONSTRAINTS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples'])
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

function checkSchema(root) {
  const violations = []
  const stack = [{ node: root, path: 'schema' }]
  while (stack.length > 0) {
    const { node, path: where } = stack.pop()
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      violations.push(`${where} must be a schema object`)
      continue
    }
    for (const key of Object.keys(node)) {
      if (CONSTRAINTS.has(key) || ANNOTATIONS.has(key)) continue
      violations.push(`${where}.${key} is not a supported keyword`)
    }
    const hasType = Object.hasOwn(node, 'type')
    const hasOneOf = Object.hasOwn(node, 'oneOf')
    if (hasType && hasOneOf) {
      violations.push(`${where} cannot declare both type and oneOf`)
      continue
    }
    if (hasOneOf) {
      if (!Array.isArray(node.oneOf) || node.oneOf.length === 0) violations.push(`${where}.oneOf must be a non-empty array`)
      for (const sibling of ONE_OF_SIBLINGS) {
        if (Object.hasOwn(node, sibling)) violations.push(`${where}.${sibling} is not supported beside oneOf`)
      }
      for (const branch of node.oneOf ?? []) stack.push({ node: branch, path: `${where}.oneOf[]` })
      continue
    }
    if (hasType && !TYPES.includes(node.type)) violations.push(`${where}.type must be one of ${TYPES.join('/')}`)
    if (node.type === 'object' || Object.hasOwn(node, 'properties')) {
      const properties = node.properties ?? {}
      if (node.properties !== undefined && (typeof node.properties !== 'object' || Array.isArray(node.properties))) {
        violations.push(`${where}.properties must be an object`)
      }
      if (node.required !== undefined && !Array.isArray(node.required)) violations.push(`${where}.required must be an array`)
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(properties, key)) violations.push(`${where}.required names "${key}" which is not in properties`)
      }
      if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
        violations.push(`${where}.additionalProperties must be a boolean`)
      }
      for (const [key, child] of Object.entries(properties)) stack.push({ node: child, path: `${where}.properties.${key}` })
    }
    if (node.items !== undefined) stack.push({ node: node.items, path: `${where}.items` })
  }
  return violations
}

function walkValue(schema, value, where, violations) {
  if (schema === null || typeof schema !== 'object') return
  if (Array.isArray(schema.oneOf)) {
    let matches = 0
    for (const branch of schema.oneOf) {
      const local = []
      walkValue(branch, value, where, local)
      if (local.length === 0) matches += 1
    }
    if (matches !== 1) violations.push(`"${where}" must match exactly one oneOf branch (matched ${matches})`)
    return
  }
  const type = schema.type
  if (type !== undefined) {
    const ok = type === 'object' ? (value !== null && typeof value === 'object' && !Array.isArray(value))
      : type === 'array' ? Array.isArray(value)
        : type === 'string' ? typeof value === 'string'
          : type === 'number' ? (typeof value === 'number' && Number.isFinite(value))
            : type === 'integer' ? (typeof value === 'number' && Number.isInteger(value))
              : type === 'boolean' ? typeof value === 'boolean'
                : type === 'null' ? value === null
                  : true
    if (!ok) {
      violations.push(`"${where}" must be ${type}`)
      return
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`"${where}" must be one of ${JSON.stringify(schema.enum)}`)
  if (Object.hasOwn(schema, 'const') && value !== schema.const) violations.push(`"${where}" must be ${JSON.stringify(schema.const)}`)
  if (type === 'array' && schema.items !== undefined) {
    value.forEach((entry, index) => walkValue(schema.items, entry, `${where}[${index}]`, violations))
  }
  if (type === 'object' && value !== null && typeof value === 'object') {
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) violations.push(`"${where}.${key}" is required`)
    }
    for (const [key, child] of Object.entries(properties)) {
      if (value[key] === undefined) continue
      walkValue(child, value[key], `${where}.${key}`, violations)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) violations.push(`"${where}.${key}" is not accepted`)
      }
    }
  }
}
