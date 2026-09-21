#!/usr/bin/env -S node --
import { fileURLToPath } from 'node:url'
import { run } from '@jt-harness/cli'
await run(fileURLToPath(new URL('../', import.meta.url)))
