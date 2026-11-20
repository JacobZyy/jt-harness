// Storage constants for jth-core memo system (mirrors AIOS memo storage)
export const MEMO_STORAGE_DIR = '.jth-memo'
export const FILE_EVENTS_FILENAME = 'events.jsonl'
export const FILE_EVENTS_SEGMENTS = ['file', FILE_EVENTS_FILENAME] as const
export const DEFAULT_MEMO_SPACE = 'default'
export const CONFIG_FILENAME = 'config.json'
export const PINNED_DEFAULT_MAX_CHARS = 5000
export const PINNED_MIN_MAX_CHARS = 512
export const PINNED_HARD_MAX_CHARS = 20000
export const RECALL_FEEDBACK_FILENAME = 'memo-recall-feedback.jsonl'
export const MEMO_LOCK_FILENAME = 'canonical-events.lock'
export const MEMO_LOCK_TIMEOUT_CODE = 'JTH_MEMO_LOCK_TIMEOUT'
