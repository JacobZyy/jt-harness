// Evidence validation — mirrors rex-harness validateCommandEvidence
// Program refuses to advance when evidence is missing or malformed.

export interface EvidenceItem {
  kind: string
  refs: string[]
  note?: string
}

export type EvidenceKind =
  | 'passing-test-observed'
  | 'failing-test-observed'
  | 'refactor-check-recorded'
  | 'implementation-complete'
  | 'review-verdict'
  | 'requirements-decision-recorded'
  | 'design-decision-recorded'
  | 'debug-root-cause-identified'
  | 'manual-verification'

const ZERO_EXIT_KINDS = new Set<string>([
  'passing-test-observed',
  'refactor-check-recorded',
])

const NONZERO_EXIT_KINDS = new Set<string>([
  'failing-test-observed',
])

const RECEIPT_PREFIX = 'receipt:'
const PLACEHOLDER = /placeholder|todo|tbd|example/i

export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvidenceValidationError'
  }
}

export interface ValidationOptions {
  resolveReceipt?: (ref: string) => { exitCode: number } | null
  expectedScenarioCommand?: string
}

export function validateEvidence(
  items: EvidenceItem[],
  expectedKinds: (string | { anyOf: string[] })[],
  opts: ValidationOptions = {},
): EvidenceItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new EvidenceValidationError('evidence requires a non-empty array')
  }
  if (items.length > 64) {
    throw new EvidenceValidationError('evidence exceeds 64 items')
  }

  // Build required-kind groups: a plain string must be present; an anyOf group
  // is satisfied when at least one of its members is present.
  const submittedKinds = new Set(items.map(i => i.kind))
  for (const req of expectedKinds) {
    if (typeof req === 'object' && Array.isArray(req.anyOf)) {
      const satisfied = req.anyOf.some(k => submittedKinds.has(k))
      if (!satisfied) {
        throw new EvidenceValidationError(
          `evidence is missing at least one of: ${req.anyOf.join(', ')}. submitted: ${[...submittedKinds].join(', ')}`
        )
      }
    } else if (typeof req === 'string') {
      if (!submittedKinds.has(req)) {
        throw new EvidenceValidationError(
          `evidence is missing required kind: ${req}. submitted: ${[...submittedKinds].join(', ')}`
        )
      }
    }
  }

  for (const item of items) {
    for (const ref of item.refs ?? []) {
      if (PLACEHOLDER.test(ref)) {
        throw new EvidenceValidationError(`evidence ref looks like a placeholder: ${ref}`)
      }
    }

    if (ZERO_EXIT_KINDS.has(item.kind) || NONZERO_EXIT_KINDS.has(item.kind)) {
      const receiptRefs = (item.refs ?? []).filter(r => r.startsWith(RECEIPT_PREFIX))
      if (receiptRefs.length === 0) {
        throw new EvidenceValidationError(
          `evidence kind '${item.kind}' requires at least one receipt: reference`
        )
      }
      if (opts.resolveReceipt) {
        const needsZero = ZERO_EXIT_KINDS.has(item.kind)
        const anyMatches = receiptRefs.some(ref => {
          const rec = opts.resolveReceipt!(ref)
          if (!rec) throw new EvidenceValidationError(`unknown receipt: ${ref}`)
          return needsZero ? rec.exitCode === 0 : rec.exitCode !== 0
        })
        if (!anyMatches) {
          const want = needsZero ? 'zero' : 'non-zero'
          throw new EvidenceValidationError(
            `evidence '${item.kind}' requires a receipt with ${want} exit code`
          )
        }
      }
    }
  }

  return items
}
