/**
 * Builds (or reuses) the content-addressed template database once per test run
 * and hands its name to test files via `inject('templateDb')`.
 * The server is scripts/local-db.mjs's cluster (or any Postgres on PH_PG_PORT).
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestProject } from 'vitest/node'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

declare module 'vitest' {
  export interface ProvidedContext {
    templateDb: string
  }
}

export default function setup(project: TestProject) {
  const res = spawnSync(process.execPath, [resolve(ROOT, 'scripts', 'local-db.mjs'), 'template'], {
    encoding: 'utf8',
    env: process.env,
  })
  if (res.status !== 0) {
    throw new Error(`Could not build the test database template:\n${res.stderr || res.stdout}`)
  }
  const url = res.stdout.trim().split('\n').pop() ?? ''
  project.provide('templateDb', new URL(url).pathname.slice(1))
}
