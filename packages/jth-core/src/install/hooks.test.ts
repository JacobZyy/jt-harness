import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installCoreHooks, uninstallCoreHooks } from './hooks.ts'

let codexHome: string
const binary = '/opt/tools/bin/jth'
const read = async () => JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'))
const commands = (document: any, event: string) =>
  document.hooks[event].flatMap((group: any) => group.hooks.map((handler: any) => handler.command))

beforeEach(async () => { codexHome = await mkdtemp(join(tmpdir(), 'jth-core-hooks-')) })
afterEach(async () => { await rm(codexHome, { recursive: true, force: true }) })

describe('installCoreHooks', () => {
  it('writes every hook as a group Codex can load', async () => {
    const result = await installCoreHooks({ codexHome, binary })
    assert.equal(result.changed, true)
    const document = await read()
    assert.deepEqual(commands(document, 'SessionStart'), [`${binary} -- memo core cue`])
    assert.deepEqual(commands(document, 'UserPromptSubmit'), [`${binary} -- memo core cue`, `${binary} -- flow core entry`])
    assert.deepEqual(commands(document, 'Stop'), [`${binary} -- memo core declare`])
    for (const groups of Object.values(document.hooks) as any[][]) {
      for (const group of groups) {
        assert.ok(Array.isArray(group.hooks))
        for (const handler of group.hooks) assert.equal(handler.type, 'command')
      }
    }
  })

  it('is idempotent and keeps foreign groups and positions', async () => {
    const foreign = { matcher: 'startup|resume', description: 'updater', hooks: [{ type: 'command', command: 'bash /x/updater.sh', timeout: 5 }] }
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: '/old/bin/jth -- memo core cue', timeout: 3 }] }, foreign],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo guard' }] }],
      },
      extra: true,
    }))
    await installCoreHooks({ codexHome, binary })
    const first = await readFile(join(codexHome, 'hooks.json'), 'utf8')
    const document = JSON.parse(first)
    assert.deepEqual(commands(document, 'SessionStart'), [`${binary} -- memo core cue`, 'bash /x/updater.sh'])
    assert.deepEqual(document.hooks.SessionStart[1], foreign)
    assert.deepEqual(commands(document, 'PreToolUse'), ['echo guard'])
    assert.equal(document.extra, true)

    const second = await installCoreHooks({ codexHome, binary })
    assert.equal(second.changed, false)
    assert.equal(await readFile(join(codexHome, 'hooks.json'), 'utf8'), first)
  })

  it('replaces bare handlers and the retired memo and flow entrances', async () => {
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: {
        Stop: [
          { type: 'command', command: 'jth -- "memo" "core" "declare"', statusMessage: 'jth-core memo declare' },
          { hooks: [{ type: 'command', command: "'jth' '--' 'memo' 'codex' 'declare'", statusMessage: 'jth memo declaration' }] },
          { hooks: [{ type: 'command', command: 'other-tool stop' }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: "'jth' '--' 'flow' 'prompt'" }, { type: 'command', command: 'jth -- monitor capture' }] }],
      },
    }))
    await installCoreHooks({ codexHome, binary })
    const document = await read()
    assert.deepEqual(commands(document, 'Stop'), ['other-tool stop', `${binary} -- memo core declare`])
    assert.deepEqual(commands(document, 'UserPromptSubmit'), ['jth -- monitor capture', `${binary} -- memo core cue`, `${binary} -- flow core entry`])
  })

  it('refuses to overwrite a file it cannot parse', async () => {
    await writeFile(join(codexHome, 'hooks.json'), '{ not json')
    await assert.rejects(installCoreHooks({ codexHome, binary }), /没有覆盖原配置/)
    assert.equal(await readFile(join(codexHome, 'hooks.json'), 'utf8'), '{ not json')
  })
})

describe('uninstallCoreHooks', () => {
  it('removes only the core hooks', async () => {
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-tool stop' }] }] } }))
    await installCoreHooks({ codexHome, binary })
    await uninstallCoreHooks({ codexHome })
    assert.deepEqual(await read(), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-tool stop' }] }] } })
  })
})
