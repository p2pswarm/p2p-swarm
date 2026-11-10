#!/usr/bin/env node
// A minimal Model Context Protocol server over stdio (newline-delimited
// JSON-RPC 2.0). Hand-rolled with no dependencies so it starts immediately on
// a fresh install; the heavier P2P daemon is started lazily on first tool use.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { tools, INSTRUCTIONS, UNTRUSTED } from './tools.js'
import { ROOT } from './client.js'

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const byName = new Map(tools.map((t) => [t.name, t]))

function reply (id, result, error) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n')
}

// Check arguments against the tool's schema before running it. A model that
// guesses a parameter name must get an error it can correct, never a silent
// success that drops what it sent.
export function checkArguments (schema, input) {
  const args = { ...(input || {}) }
  const props = schema.properties || {}
  for (const [alias, real] of Object.entries(schema.aliases || {})) {
    if (alias in args && !(real in args)) args[real] = args[alias]
    delete args[alias]
  }
  const expected = Object.keys(props)
  const describe = expected.length ? `Expected: ${expected.join(', ')}.` : 'This tool takes no parameters.'
  for (const key of Object.keys(args)) {
    if (!(key in props)) throw new Error(`Unknown parameter "${key}". ${describe}`)
    const want = props[key].type
    const value = args[key]
    if (value === null || value === undefined) { delete args[key]; continue }
    const got = Array.isArray(value) ? 'array' : typeof value
    if (want && got !== want) throw new Error(`Parameter "${key}" must be a ${want}, got ${got}.`)
    if (props[key].enum && !props[key].enum.includes(value)) throw new Error(`Parameter "${key}" must be one of: ${props[key].enum.join(', ')}.`)
  }
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === '') throw new Error(`Missing required parameter "${key}". ${describe}`)
  }
  return args
}

async function callTool (name, args) {
  const tool = byName.get(name)
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  try {
    const { value, untrusted } = await tool.run(checkArguments(tool.inputSchema, args))
    const text = JSON.stringify(value, null, 2)
    return { content: [{ type: 'text', text: untrusted ? `${UNTRUSTED}\n\n${text}` : text }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
  }
}

async function handle (message) {
  const { id, method, params } = message
  const isRequest = id !== undefined && id !== null
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'p2p-swarm', version: pkg.version },
        instructions: INSTRUCTIONS
      })
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, { tools: tools.map(({ name, description, inputSchema: { aliases, ...inputSchema } }) => ({ name, description, inputSchema })) })
    case 'tools/call':
      return reply(id, await callTool(params?.name, params?.arguments))
    default:
      if (isRequest) reply(id, null, { code: -32601, message: `Method not found: ${method}` })
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) startStdio()

export function startStdio () {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return reply(null, null, { code: -32700, message: 'Parse error' })
    }
    handle(message).catch((err) => {
      if (message.id !== undefined) reply(message.id, null, { code: -32603, message: err.message })
    })
  })
  lines.on('close', () => process.exit(0))
}
