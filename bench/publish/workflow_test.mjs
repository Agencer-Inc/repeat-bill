import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')

// Each file outside bench/ that a script in bench/publish imports, from the repository root.
const outsideImports = () =>
  readdirSync(here)
    .filter((name) => name.endsWith('.mjs'))
    .flatMap((name) =>
      [...readFileSync(join(here, name), 'utf8').matchAll(/\bfrom '(\.\.?\/[^']+)'/g)].map((match) =>
        relative(root, resolve(here, match[1])),
      ),
    )
    .filter((path) => !path.startsWith('bench/'))

// The indented lines under `  <name>:` in the workflow's `on:` block.
const trigger = (workflow, name) => workflow.match(new RegExp(`^  ${name}:\\n((?:(?: {4}.*)?\\n)*)`, 'm'))?.[1]

// The entries of the trigger's `paths:` list, past comments and blank lines, unquoted and
// without a trailing comment; undefined when it has none.
const pathsOf = (body) => {
  const list = body.match(/^ {4}paths:\n((?:(?: {6}.*)?\n| *#.*\n)*)/m)?.[1]
  return list?.match(/^ {6}- .*$/gm)?.map((line) =>
    line
      .slice(8)
      .replace(/\s+#.*$/, '')
      .replace(/^(['"])(.*)\1$/, '$2'),
  )
}

test('the pull request and main triggers of the Bench workflow list bench/, the workflow and every file its tests import, and leave none out', () => {
  const imports = outsideImports()
  const workflow = readFileSync(join(root, '.github', 'workflows', 'bench.yml'), 'utf8')
  const triggers = { pull_request: trigger(workflow, 'pull_request'), push: trigger(workflow, 'push') }
  assert.ok(triggers.pull_request, 'no pull_request trigger')
  assert.ok(triggers.push, 'no push trigger')
  assert.match(triggers.push, /^ {4}branches: \[main\]$/m)
  // Every list entry anywhere under on:, so no comment or spacing hides an excluded path.
  const on = workflow.match(/^on:\n((?:(?:[ #].*)?\n)*)/m)?.[1]
  assert.ok(on, 'no on: block')
  assert.deepEqual(on.match(/^[ \t]*-[ \t]*['"]?!.*$/gm) ?? [], [], 'the on: block leaves paths out')
  for (const [name, body] of Object.entries(triggers)) {
    assert.doesNotMatch(body, /^ {4}paths-ignore:/m, `${name} has a paths-ignore: list`)
    const paths = pathsOf(body)
    assert.ok(paths, `${name} has no paths: list`)
    assert.deepEqual(
      paths.filter((path) => path.startsWith('!')),
      [],
      `${name} leaves paths out`,
    )
    for (const path of ['bench/**', '.github/workflows/bench.yml', ...imports]) {
      assert.ok(paths.includes(path), `${name} does not run on ${path}`)
    }
  }
})
