#!/usr/bin/env node
// Fails unless every folder under supabase/functions/ (except _shared) has a
// [functions.<name>] block in supabase/config.toml with an explicit
// verify_jwt value. No TOML parser dependency (ponytail: the config file's
// block/key shape is simple enough for a line scan) — a change to the
// config.toml block syntax would need this regex updated too.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const functionsDir = join(root, 'supabase', 'functions')
const configPath = join(root, 'supabase', 'config.toml')

const functionNames = readdirSync(functionsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== '_shared')
  .map((entry) => entry.name)
  .sort()

const configText = readFileSync(configPath, 'utf8')

const missing = []
const noVerifyJwt = []

for (const name of functionNames) {
  const blockHeader = `[functions.${name}]`
  const startIndex = configText.indexOf(blockHeader)
  if (startIndex === -1) {
    missing.push(name)
    continue
  }
  const nextHeaderIndex = configText.indexOf('\n[', startIndex + blockHeader.length)
  const block = configText.slice(startIndex, nextHeaderIndex === -1 ? configText.length : nextHeaderIndex)
  if (!/verify_jwt\s*=\s*(true|false)/.test(block)) {
    noVerifyJwt.push(name)
  }
}

if (missing.length > 0 || noVerifyJwt.length > 0) {
  if (missing.length > 0) {
    console.error(`supabase/config.toml is missing a [functions.<name>] block for: ${missing.join(', ')}`)
  }
  if (noVerifyJwt.length > 0) {
    console.error(`supabase/config.toml's block has no explicit verify_jwt for: ${noVerifyJwt.join(', ')}`)
  }
  process.exit(1)
}

console.log(`check-functions-config: ok (${functionNames.length} functions)`)
