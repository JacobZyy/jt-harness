import { readFile } from 'node:fs/promises'
import { extractMemories } from './extract.ts'

// Direct Agent verification entry; jth owns durable acceptance and background processing.
try {
  const [inputPath, optionsPath, ...extra] = process.argv.slice(2)
  if (!inputPath || extra.length > 0) {
    throw new Error('用法：node packages/memo/src/agents/run.ts <会话.json> [模型配置.json]')
  }
  const [input, runtime] = await Promise.all([
    readFile(inputPath, 'utf8'),
    readFile(optionsPath ?? new URL('./runtime.json', import.meta.url), 'utf8'),
  ])
  const result = await extractMemories(JSON.parse(input), JSON.parse(runtime))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
