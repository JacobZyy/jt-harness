#!/usr/bin/env -S bun --no-env-file
import { fileURLToPath } from 'node:url'
import { run } from '../packages/cli/src/index.ts'

await run(fileURLToPath(new URL('../', import.meta.url)))
