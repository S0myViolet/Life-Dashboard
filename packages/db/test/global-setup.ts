/**
 * Builds `ph_template` (Supabase shim + all migrations) once per test run.
 * Set TEST_DATABASE_URL to a superuser URL of an existing server to skip the
 * bundled local cluster; the template is still built there.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export default function setup() {
  if (process.env.TEST_DATABASE_URL) return
  const res = spawnSync(process.execPath, [resolve(ROOT, 'scripts', 'local-db.mjs'), 'template'], {
    encoding: 'utf8',
  })
  if (res.status !== 0) {
    throw new Error(`Could not build the test database template:\n${res.stderr || res.stdout}`)
  }
}
