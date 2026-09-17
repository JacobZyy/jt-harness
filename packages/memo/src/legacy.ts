/** Optional explicit legacy entry point; never imported by the index worker. */
export { runWorker as runLegacyWorker, processJob } from './storage/legacy-worker.ts'
export { extractMemories } from './agents/extract.ts'
