import type { Pool, PoolClient } from 'pg'
import type { AgentContext } from '../agents/runtime.ts'

/** Commit every returned response before parsing it, including attempts that cannot be decoded. */
export function retainAgentOutputs(database: Pool | PoolClient, submissionId: string, stage: 'extraction' | 'reconciliation'): Pick<AgentContext, 'onOutput' | 'onInvalidOutput'> {
  return {
    onOutput: async output => {
      await database.query('INSERT INTO jt_memo.agent_outputs(submission_id,stage,session_id,response,run) VALUES ($1,$2,$3,$4,$5)',
        [submissionId, stage, output.run.session_id, output.response, output.run])
    },
    onInvalidOutput: async (output, error) => {
      await database.query('UPDATE jt_memo.agent_outputs SET validation_error=$4 WHERE submission_id=$1 AND stage=$2 AND session_id=$3',
        [submissionId, stage, output.run.session_id, error])
    },
  }
}

export async function readAgentOutputs(database: Pool | PoolClient, submissionId: string) {
  const result = await database.query('SELECT stage,session_id,response,run,validation_error,received_at FROM jt_memo.agent_outputs WHERE submission_id=$1 ORDER BY received_at,session_id', [submissionId])
  return result.rows
}
