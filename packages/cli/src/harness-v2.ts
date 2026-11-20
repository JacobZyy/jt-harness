// `jth harness policy|start|status|submit|reset`. Workflow state belongs to the caller's working directory.

import { evaluateWorkflow, submitEvidence, type WorkflowStartOptions } from '../../jth-core/src/harness/workflow.ts'
import { clearWorkflowState, loadWorkflowState } from '../../jth-core/src/harness/application/activation.ts'
import type { EvidenceItem } from '../../jth-core/src/harness/application/evidence.ts'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'

function out(value: unknown) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}
function err(message: string) {
  process.stderr.write(JSON.stringify({ error: message }) + '\n')
  process.exitCode = 1
}

export async function harnessMain(args: string[], workspaceRoot?: string) {
  const root = workspaceRoot ?? resolve(process.cwd())
  const [cmd, ...rest] = args

  switch (cmd) {
    case 'policy': {
      const { values } = parseArgs({
        args: rest, allowPositionals: false,
        options: {
          intent: { type: 'string' },
          relationship: { type: 'string' },
          'active-plan': { type: 'boolean' },
          'context-available': { type: 'boolean' },
          reason: { type: 'string', multiple: true },
          mode: { type: 'string' },
          'explicit-intent': { type: 'string' },
        },
      })
      const request: WorkflowStartOptions['request'] = {
        intent: (values.intent ?? 'implement') as WorkflowStartOptions['request']['intent'],
        relationship: (values.relationship ?? 'new') as WorkflowStartOptions['request']['relationship'],
        activePlan: values['active-plan'] ?? false,
        contextAvailable: values['context-available'] ?? false,
        planningReasons: ((values.reason ?? []) as string[]) as WorkflowStartOptions['request']['planningReasons'],
      }
      const result = await evaluateWorkflow({
        workspaceRoot: root,
        request,
        mode: (values.mode ?? 'adaptive') as 'adaptive' | 'strict',
        explicitIntent: values['explicit-intent'],
      })
      out(result)
      break
    }

    case 'start': {
      const { values } = parseArgs({
        args: rest, allowPositionals: false,
        options: {
          intent: { type: 'string' },
          mode: { type: 'string' },
          'explicit-intent': { type: 'string' },
        },
      })
      const result = await evaluateWorkflow({
        workspaceRoot: root,
        request: {
          intent: (values.intent ?? 'implement') as WorkflowStartOptions['request']['intent'],
          relationship: 'new',
          planningReasons: ['dependent-work'],
        },
        mode: (values.mode ?? 'adaptive') as 'adaptive' | 'strict',
        explicitIntent: values['explicit-intent'],
      })
      out(result)
      break
    }

    case 'status': {
      const state = await loadWorkflowState(root)
      if (!state) { out({ status: 'no-active-workflow' }); break }
      out({
        workflowActivationId: state.workflowActivationId,
        completedCapabilities: state.completedCapabilities,
        currentCapability: state.currentActivation?.capabilityId ?? null,
        currentStage: state.currentActivation?.stageId ?? null,
        expectedEvidence: state.currentCommand?.expectedEvidence ?? [],
        objective: state.currentCommand?.objective ?? null,
        provider: state.currentCommand?.provider ?? null,
        updatedAt: state.updatedAt,
      })
      break
    }

    case 'submit': {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true,
        options: { kind: { type: 'string' }, receipt: { type: 'string', multiple: true }, note: { type: 'string' } },
      })
      const kind = values.kind ?? positionals[0]
      if (!kind) { err('usage: jth harness submit --kind <evidence-kind> [--receipt receipt:<id>]'); break }
      const item: EvidenceItem = {
        kind,
        refs: (values.receipt as string[] | undefined) ?? [],
        note: values.note,
      }
      const result = await submitEvidence({ workspaceRoot: root, evidence: [item] })
      out(result)
      break
    }

    case 'reset': {
      await clearWorkflowState(root)
      out({ status: 'reset' })
      break
    }

    default:
      err(`unknown harness command: ${cmd ?? '(none)'}. try: policy|start|status|submit|reset`)
  }
}
