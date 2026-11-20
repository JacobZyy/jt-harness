import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')

type Jth = (args: string[], input?: unknown) => any

/** Runs the CLI from a throwaway workspace that is also HOME, so nothing reaches the real Codex configuration. */
async function withWorkspace(body: (workspace: string, jth: Jth) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), 'jth-core-cli-'))
  const jth: Jth = (args, input) => {
    const result = spawnSync(process.execPath, ['--no-env-file', resolve(root, 'bin/jth.ts'), '--', ...args], {
      cwd: workspace, encoding: 'utf8', timeout: 30_000, input: input === undefined ? '' : JSON.stringify(input),
      env: { ...process.env, HOME: workspace, CODEX_HOME: join(workspace, '.codex') },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim() ? JSON.parse(result.stdout) : undefined
  }
  try { await body(workspace, jth) }
  finally { await rm(workspace, { recursive: true, force: true }) }
}

test('jth-core hook commands read the Codex payload and keep state in the caller workspace', async () => {
  await withWorkspace(async (workspace, jth) => {
    const added = jth(['memo', 'core', 'add', 'Gateway retries use exponential backoff'])
    assert.equal(added.status, 'recorded')
    assert.equal(await readFile(join(workspace, '.jth-memo/.gitignore'), 'utf8'), '*\n')

    const cue = jth(['memo', 'core', 'cue'], { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: workspace, prompt: 'gateway retries backoff' })
    assert.equal(cue.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
    const context = JSON.parse(cue.hookSpecificOutput.additionalContext)
    assert.equal(context.cues[0].eventId, added.eventId)

    const stop = jth(['memo', 'core', 'declare'], {
      hook_event_name: 'Stop', session_id: 's1', cwd: workspace,
      last_assistant_message: 'done <!--memory: verified=yes, conclusion=Stop payload reaches the declaration parser -->',
    })
    // Codex rejects Stop output carrying fields outside its schema.
    assert.deepEqual(stop, { continue: true })
    const events = (await readFile(join(workspace, '.jth-memo/file/events.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(events.length, 2)
    assert.equal(JSON.parse(events[1]).text, 'Stop payload reaches the declaration parser')

    const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: workspace }
    assert.deepEqual(jth(['flow', 'core', 'entry'], prompt), {})
    jth(['harness', 'start', '--intent', 'implement'])
    await access(join(workspace, '.jth/harness/workflow-state.json'))
    assert.match(jth(['flow', 'core', 'entry'], prompt).hookSpecificOutput.additionalContext, /Stage:/)
    assert.equal(jth(['harness', 'reset']).status, 'reset')
    assert.equal(jth(['harness', 'status']).status, 'no-active-workflow')
    assert.deepEqual(jth(['flow', 'core', 'entry'], prompt), {})
  })
})

test('init-v2 prepares the workspace, installs grouped hooks and removes them again', async () => {
  await withWorkspace(async (workspace, jth) => {
    const hooksPath = join(workspace, '.codex/hooks.json')
    const ready = jth(['init-v2'])
    assert.equal(ready.status, 'ready')
    assert.equal(ready.hooksInstalled, 'installed')
    assert.equal(ready.hooksPath, hooksPath)
    assert.equal(await readFile(join(workspace, '.jth-memo/.gitignore'), 'utf8'), '*\n')
    assert.equal(await readFile(join(workspace, '.jth/harness/.gitignore'), 'utf8'), '*\n')

    const { hooks } = JSON.parse(await readFile(hooksPath, 'utf8'))
    assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit'])
    assert.equal(hooks.UserPromptSubmit.length, 2)
    assert.match(hooks.Stop[0].hooks[0].command, /(?:^|\/)jth -- memo core declare$/)

    assert.equal(jth(['init-v2']).message.includes('already up to date'), true)
    assert.equal(jth(['init-v2', '--remove-hooks']).status, 'uninstalled')
    assert.deepEqual(JSON.parse(await readFile(hooksPath, 'utf8')), { hooks: {} })
  })
})
