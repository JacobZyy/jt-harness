// Declaration protocol — mirrors AIOS declaration.mjs
// Format: <!--memory: verified=yes|no, useful=eventId1,eventId2, conclusion=one-line -->

export const DECL_OPEN = '<!--memory:'
export const DECL_CLOSE = '-->'

export interface MemoryDeclaration {
  found: boolean
  verified: boolean | undefined
  useful: string[]
  conclusion: string | undefined
}

export function parseMemoryDeclaration(output: string): MemoryDeclaration {
  const src = String(output || '')
  const openIdx = src.lastIndexOf(DECL_OPEN)
  if (openIdx === -1) return { found: false, verified: undefined, useful: [], conclusion: undefined }
  const afterOpen = openIdx + DECL_OPEN.length
  const closeIdx = src.indexOf(DECL_CLOSE, afterOpen)
  if (closeIdx === -1) return { found: false, verified: undefined, useful: [], conclusion: undefined }
  const body = src.slice(afterOpen, closeIdx).trim()
  if (!body) return { found: false, verified: undefined, useful: [], conclusion: undefined }

  const verifiedMatch = body.match(/verified\s*[:=]\s*([^\s,;|}]+)/iu)
  let verified: boolean | undefined
  if (verifiedMatch) {
    const v = verifiedMatch[1].trim().toLowerCase()
    if (['yes', 'true', 'y', '1', 'ok', 'verified'].includes(v)) verified = true
    else if (['no', 'false', 'n', '0', 'unverified', 'not'].includes(v)) verified = false
  }

  const usefulMatch = body.match(/useful\s*[:=]\s*([^\s|}]+(?:\s*,\s*[^\s|}]+)*)/iu)
  const useful = usefulMatch
    ? usefulMatch[1].split(',').map(s => s.trim()).filter(Boolean)
    : []

  const conclusionMatch = body.match(/conclusion\s*[:=]\s*([^|}]*)/iu)
  const conclusion = conclusionMatch ? conclusionMatch[1].trim() || undefined : undefined

  return { found: true, verified, useful, conclusion }
}

export function stripMemoryDeclaration(output: string): string {
  const src = String(output || '')
  const openIdx = src.lastIndexOf(DECL_OPEN)
  if (openIdx === -1) return src
  const afterOpen = openIdx + DECL_OPEN.length
  const closeIdx = src.indexOf(DECL_CLOSE, afterOpen)
  if (closeIdx === -1) return src
  return src.slice(0, openIdx).trimEnd()
}

export function buildMemoryDeclarationInstruction(): string {
  return [
    '',
    '## JTH MEMORY DECLARATION',
    'At the end of your reply, append one trailing line when this turn produced something durable:',
    `  ${DECL_OPEN} verified=yes|no, useful=<eventId1,eventId2>, conclusion=<one-line takeaway> ${DECL_CLOSE}`,
    '- verified=yes only when this turn produced a confirmed, durable fact.',
    '- useful: list recalled eventIds you actually referenced. Omit if none.',
    '- conclusion: one line capturing the takeaway; omit if nothing durable.',
    '',
  ].join('\n')
}
