// Tests for jth-core memo system
import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendMemoEvent } from './storage/events/events-write.ts'
import { readAllMemoEvents } from './storage/events/events-read.ts'
import { searchMemoEvents } from './storage/views/query.ts'
import { parseMemoryDeclaration, stripMemoryDeclaration } from './flow/declaration/protocol.ts'
import { appendToPinned, readPinned } from './storage/govern/pinned.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jth-core-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('appendMemoEvent / readAllMemoEvents', () => {
  it('makes a new memo root ignore itself and leaves an existing root alone', async () => {
    await appendMemoEvent({ workspaceRoot: dir, text: 'Written by a hook in some project' })
    assert.equal(await readFile(join(dir, '.jth-memo/.gitignore'), 'utf8'), '*\n')

    const arranged = join(dir, 'arranged')
    await mkdir(join(arranged, '.jth-memo'), { recursive: true })
    await appendMemoEvent({ workspaceRoot: arranged, text: 'The owner decides what git sees here' })
    await assert.rejects(access(join(arranged, '.jth-memo/.gitignore')), { code: 'ENOENT' })
  })

  it('appends and reads back a simple event', async () => {
    const ev = await appendMemoEvent({ workspaceRoot: dir, text: 'Fixed CRLF bug in .gitattributes', entities: ['gitattributes'], date: '2026-11-20', evidenceRef: 'scripts/fix.sh:0' })
    assert.match(ev.eventId, /^memo:default:/)
    assert.equal(ev.text, 'Fixed CRLF bug in .gitattributes')
    const all = await readAllMemoEvents(dir)
    assert.equal(all.length, 1)
    assert.equal(all[0].eventId, ev.eventId)
  })

  it('assigns incrementing seq', async () => {
    await appendMemoEvent({ workspaceRoot: dir, text: 'First fact' })
    await appendMemoEvent({ workspaceRoot: dir, text: 'Second fact' })
    const all = await readAllMemoEvents(dir)
    assert.equal(all[0].seq, 1)
    assert.equal(all[1].seq, 2)
  })

  it('supersedes work: superseded event is hidden in search', async () => {
    const old = await appendMemoEvent({ workspaceRoot: dir, text: 'Old fact' })
    await appendMemoEvent({ workspaceRoot: dir, text: 'New corrected fact', supersedes: [old.eventId] })
    const results = await searchMemoEvents({ workspaceRoot: dir, query: 'Old fact' })
    // old is superseded, should not be in active results
    assert.equal(results.find(r => r.event.eventId === old.eventId), undefined)
  })
})

describe('searchMemoEvents', () => {
  it('returns empty for empty store', async () => {
    const r = await searchMemoEvents({ workspaceRoot: dir, query: 'anything' })
    assert.equal(r.length, 0)
  })

  it('finds by keyword', async () => {
    await appendMemoEvent({ workspaceRoot: dir, text: 'Authentication uses JWT tokens', entities: ['auth', 'jwt'] })
    await appendMemoEvent({ workspaceRoot: dir, text: 'Database connection is PostgreSQL' })
    const r = await searchMemoEvents({ workspaceRoot: dir, query: 'JWT auth' })
    assert.ok(r.length > 0)
    assert.ok(r[0].event.text.includes('JWT'))
  })

  it('finds by entity', async () => {
    await appendMemoEvent({ workspaceRoot: dir, text: 'Fix applied to auth module', entities: ['auth-module'] })
    const r = await searchMemoEvents({ workspaceRoot: dir, query: 'auth-module' })
    assert.ok(r.length > 0)
  })

  it('respects limit', async () => {
    for (let i = 0; i < 10; i++) await appendMemoEvent({ workspaceRoot: dir, text: `Fact number ${i} about auth` })
    const r = await searchMemoEvents({ workspaceRoot: dir, query: 'auth', limit: 3 })
    assert.ok(r.length <= 3)
  })
})

describe('parseMemoryDeclaration', () => {
  it('parses verified=yes', () => {
    const r = parseMemoryDeclaration('some reply <!--memory: verified=yes, conclusion=Found the bug -->')
    assert.equal(r.found, true)
    assert.equal(r.verified, true)
    assert.equal(r.conclusion, 'Found the bug')
  })

  it('parses useful list', () => {
    const r = parseMemoryDeclaration('<!--memory: verified=yes, useful=memo:default:abc,memo:default:def, conclusion=done -->')
    assert.deepEqual(r.useful, ['memo:default:abc', 'memo:default:def'])
  })

  it('returns found=false when no block', () => {
    const r = parseMemoryDeclaration('no block here')
    assert.equal(r.found, false)
    assert.equal(r.verified, undefined)
  })

  it('strips declaration from reply', () => {
    const stripped = stripMemoryDeclaration('content <!--memory: verified=no -->')
    assert.equal(stripped, 'content')
    assert.ok(!stripped.includes('<!--memory:'))
  })
})

describe('pinned memory', () => {
  it('appends and reads back pinned text', async () => {
    await appendToPinned({ workspaceRoot: dir, text: 'Milestone: v1.0 shipped' })
    const pinned = await readPinned(dir)
    assert.ok(pinned.includes('Milestone: v1.0 shipped'))
  })

  it('appends multiple entries', async () => {
    await appendToPinned({ workspaceRoot: dir, text: 'First checkpoint' })
    await appendToPinned({ workspaceRoot: dir, text: 'Second checkpoint' })
    const pinned = await readPinned(dir)
    assert.ok(pinned.includes('First checkpoint'))
    assert.ok(pinned.includes('Second checkpoint'))
  })
})
