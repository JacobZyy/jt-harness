import { createReadStream } from 'node:fs'
import { parseArgs } from 'node:util'
import { loadConfig, safeError } from '@jt-harness/memo/config'
import type { Config } from '@jt-harness/memo/config'
import { prepareEvidence, readEvidence, stageRecord } from '@jt-harness/codex-hooks'
import { startWorker } from './background.ts'

export async function inlineMain(root: string, args: string[]) {
  let config: Config | undefined
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      'env-file': { type: 'string' }, session: { type: 'string' }, limit: { type: 'string' },
      'include-tools': { type: 'boolean' }, message: { type: 'string', multiple: true }, before: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } })
    const [command, operand] = positionals
    if (values.help) {
      process.stdout.write('jth memo prepare --session <id> [--limit 12] [--include-tools]\njth memo evidence <id> --message <message-id>\njth memo record <file.json|->\n')
      return
    }
    const allowed: Record<string, string[]> = { prepare: ['session', 'limit', 'include-tools', 'message', 'before'], evidence: ['message'], record: [] }
    if (!Object.hasOwn(allowed, command)) throw new Error('未知会话内记忆命令')
    const invalid = Object.keys(values).filter(key => !['env-file', 'help', ...allowed[command]].includes(key))
    if (invalid.length) throw new Error(command + ' 不支持：' + invalid.join(', '))
    config = await loadConfig(root, values['env-file'])
    let result: unknown
    if (command === 'prepare') {
      if (!values.session || positionals.length !== 1) throw new Error('prepare 需要 --session <id>')
      result = await prepareEvidence(config, values.session, { limit: Number(values.limit ?? 12), includeTools: values['include-tools'], before: values.before, messageIds: values.message })
    } else if (command === 'evidence') {
      if (!operand || values.message?.length !== 1 || positionals.length !== 2) throw new Error('evidence 需要证据 ID 和一个 --message <id>')
      const evidence = await readEvidence(config, operand)
      const message = evidence.submission.messages.find(item => item.message_id === values.message![0])
      if (!message) throw new Error('证据回执中不存在该消息')
      result = { evidence_id: evidence.id, message }
    } else if (command === 'record') {
      if (!operand || positionals.length !== 2) throw new Error('record 需要 JSON 文件或 stdin')
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of operand === '-' ? process.stdin : createReadStream(operand)) {
        bytes += chunk.length
        if (bytes > 512_000) throw new Error('候选超过 512000 字节；请按事实拆批')
        chunks.push(Buffer.from(chunk))
      }
      const receipt = await stageRecord(config, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      // Local staging precedes any database connection. A rejected/offline delivery remains recoverable.
      const { openDatabase, prepareDatabase, jobStatus } = await import('@jt-harness/memo')
      const { receiveRecords } = await import('./ingest.ts')
      let pool
      try {
        pool = openDatabase(config)
        await prepareDatabase(pool, false)
        const delivery = await receiveRecords(pool, config)
        const failure = delivery.errors.find(item => item.submission_id === receipt.submission_id)
        if (failure) throw new Error(failure.error)
        const job = await jobStatus(pool, receipt.submission_id)
        let worker
        try { worker = await startWorker(root, config) } catch (error) {
          worker = { started: false, error: safeError(error, config), recovery: 'jth memo work' }
          process.exitCode = 1
        }
        result = { ...job, status: 'accepted', index_status: job.status, worker }
      } catch (error) {
        result = { ...receipt, acceptance: 'unconfirmed', error: safeError(error, config), recovery: 'jth memo work' }
        process.exitCode = 1
      } finally { await pool?.end() }
    } else throw new Error('未知会话内记忆命令')
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: safeError(error, config) })}\n`)
    process.exitCode = 1
  }
}
