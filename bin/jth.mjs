#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { run } from '../packages/cli/dist/index.js'
await run(fileURLToPath(new URL('../', import.meta.url)))
