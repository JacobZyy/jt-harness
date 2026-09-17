import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { loadConfig, safeError } from '@jt-harness/memo/config'
import type { Config } from '@jt-harness/memo/config'
import { envVersion, saveModel, withModelCatalog } from '@jt-harness/memo/models'

export async function modelMain(root: string, args: string[]) {
  let config: Config | undefined
  try {
    const { values } = parseArgs({ args, options: { 'env-file': { type: 'string' }, list: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' }, help: { type: 'boolean', short: 'h' } } })
    if (values.help) { stdout.write('jth memo model                         交互选择 DSH 模型\njth memo model --list                  查询实时列表（JSON）\njth memo model --provider <id> --model <id>\n通用：--env-file <path>\n'); return }
    if (Boolean(values.provider) !== Boolean(values.model) || (values.list && values.provider)) throw new Error('--provider 和 --model 必须一起使用，不能与 --list 混用')
    config = await loadConfig(root, values['env-file'])
    const current = config
    const version = envVersion(await readFile(current.envFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }))
    await withModelCatalog(current, async (catalog, check) => {
      const models = catalog.flatMap(provider => provider.models.map(model => ({ provider: provider.provider, model: model.id, name: model.name,
        current: provider.provider === current.agent.provider && model.id === current.agent.model })))
      if (values.list) { stdout.write(JSON.stringify({ current: { provider: current.agent.provider, model: current.agent.model }, models }, null, 2) + '\n'); return }
      let selected
      if (values.provider) selected = models.find(item => item.provider === values.provider && item.model === values.model)
      else {
        if (!stdin.isTTY || !stdout.isTTY) throw new Error('交互选择需要终端；可用 --list 或 --provider <id> --model <id>')
        stdout.write(`当前：${current.agent.provider} / ${current.agent.model}\n`)
        models.forEach((model, index) => stdout.write(`${index + 1}. ${model.provider} / ${model.model}${model.current ? ' [当前]' : ''}\n`))
        const prompt = createInterface({ input: stdin, output: stdout })
        try {
          const answer = (await prompt.question('选择编号（回车取消）：')).trim()
          if (!answer) { stdout.write('已取消，配置未改变。\n'); return }
          if (!/^[1-9]\d*$/.test(answer)) throw new Error('请输入列表中的编号')
          selected = models[Number(answer) - 1]
        } finally { prompt.close() }
      }
      if (!selected) throw new Error('所选模型不在 DSH 当前列表中')
      for (const [key, value] of [['JTH_DSH_PROVIDER', selected.provider], ['JTH_DSH_MODEL', selected.model]]) {
        if (process.env[key] !== undefined && process.env[key] !== value) throw new Error(`${key} 的进程环境变量覆盖文件配置；请先取消该环境变量再切换`)
      }
      const effective = await check(selected.provider, selected.model)
      await saveModel(current, selected.provider, selected.model, version)
      stdout.write(JSON.stringify({ status: 'saved', provider: selected.provider, model: selected.model, effective, env_file: current.envFile,
        queued_jobs: 'unchanged; only future submissions use this selection' }, null, 2) + '\n')
    })
  } catch (error) { process.stderr.write(JSON.stringify({ error: safeError(error, config) }) + '\n'); process.exitCode = 1 }
}
