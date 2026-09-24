#!/usr/bin/env bun
import {fileURLToPath} from 'node:url'
import {run} from '../src/index.ts'
await run(fileURLToPath(new URL('../../../',import.meta.url)))
