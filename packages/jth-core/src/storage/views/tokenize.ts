// Word segmenter backed by Intl.Segmenter — mirrors AIOS memo query.mjs
// No hand-written stop-word tables; ICU decides what counts as a word.

const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })
const CJK_BIGRAM = /[㐀-䶿一-鿿豈-﫿぀-ヿ]+/gu

export function segmentWords(value: string): string[] {
  const words: string[] = []
  for (const part of WORD_SEGMENTER.segment(String(value || ''))) {
    if (part.isWordLike) words.push(part.segment.toLowerCase())
  }
  // CJK bigram fallback for any script ICU may not fully segment
  const cjkRuns = String(value || '').match(CJK_BIGRAM) ?? []
  for (const run of cjkRuns) {
    for (let i = 0; i + 2 <= run.length; i++) words.push(run.slice(i, i + 2))
  }
  return [...new Set(words)]
}

export function tokenizeForMatch(value: string): string[] {
  const latin = [...(String(value || '').matchAll(/[a-z_$][\w$-]*/gi) ?? [])].map(m => m[0].toLowerCase())
  return [...new Set([...latin, ...segmentWords(value)])]
}

export interface MatchScore {
  score: number
  matched: string[]
  phraseMatch: boolean
}

export function scoreText(text: string, queryTokens: string[], phraseQuery: string): MatchScore {
  const lower = text.toLowerCase()
  const textTokens = tokenizeForMatch(text)
  const matched = queryTokens.filter(q => textTokens.includes(q))
  const phraseMatch = phraseQuery.length > 0 && lower.includes(phraseQuery.toLowerCase())
  const coverage = queryTokens.length > 0 ? matched.length / queryTokens.length : 0
  const score = coverage + (phraseMatch ? 0.5 : 0)
  return { score, matched, phraseMatch }
}
