import type {
  ExecutorInput,
  ExecutorPermissionResponse,
  ExecutorPolicyContext,
  ExecutorUsage
} from '../executor-types.ts'

export type NativeCodexAvailabilityReason =
  | 'chatgpt_subscription'
  | 'not_authenticated'
  | 'non_chatgpt_auth'
  | 'quota_exhausted'
  | 'rate_limit_reached'
  | 'spend_control_reached'
  | 'quota_probe_unavailable'
  | 'provider_overloaded'
  | 'provider_error'
  | 'unsupported'

export interface NativeCodexProbeSnapshot {
  available: boolean
  reason: NativeCodexAvailabilityReason
  planType?: string | null
}

export type NativeCodexFailureReason =
  | Exclude<NativeCodexAvailabilityReason, 'chatgpt_subscription'>
  | 'context_exhausted'
  | 'permission_denied'
  | 'policy_denied'
  | 'bad_request'
  | 'transport_lost'
  | 'process_crash'
  | 'context_lost'
  | 'user_stopped'
  | 'internal_error'

export type NativeCodexDriverEvent =
  | { type: 'message'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'plan'; text: string }
  | { type: 'tool.started'; toolCallId: string; name: string }
  | { type: 'tool.updated'; toolCallId: string; detail: string }
  | { type: 'tool.completed'; toolCallId: string; success: boolean }
  | { type: 'file.changed'; path: string }
  | {
      type: 'permission.requested'
      requestId: string
      description: string
      allowSessionApproval?: boolean
    }
  | { type: 'usage.updated'; usage: ExecutorUsage }
  | { type: 'failure'; reason: NativeCodexFailureReason; message: string }
  | { type: 'completed'; outcome: 'succeeded' | 'cancelled' | 'failed' }

export interface NativeCodexStartOptions {
  workspace: string
  policy: ExecutorPolicyContext
  model?: string
  modelProvider?: string
}

export interface NativeCodexResumeOptions {
  model?: string
  modelProvider?: string
}

export interface NativeCodexDriver {
  probe(): Promise<NativeCodexProbeSnapshot>
  startThread(options: NativeCodexStartOptions): Promise<{ threadId: string }>
  resumeThread(threadId: string, options?: NativeCodexResumeOptions): Promise<void>
  prompt(threadId: string, input: ExecutorInput): AsyncIterable<NativeCodexDriverEvent>
  respondPermission(threadId: string, response: ExecutorPermissionResponse): Promise<void>
  cancel(threadId: string): Promise<void>
  close(threadId: string): Promise<void>
}
