import type { AiMatchingRecommendation } from './ai-matching-recommendation';

export type BankTransactionStatus =
  | 'UNMATCHED'
  | 'PENDING_REVIEW'
  | 'MATCHED'
  | 'IGNORED'
  | 'PREPAID';

/**
 * Statuses a reviewer may still act on in the Exception Queue. `UNMATCHED`
 * (auto-matching found nothing) sits here alongside `PENDING_REVIEW` (found
 * candidates but could not decide); the rest are terminal.
 */
export const ACTIONABLE_BANK_TRANSACTION_STATUSES = [
  'PENDING_REVIEW',
  'UNMATCHED',
] as const satisfies readonly BankTransactionStatus[];

export function isActionableStatus(status: BankTransactionStatus): boolean {
  return ACTIONABLE_BANK_TRANSACTION_STATUSES.includes(
    status as (typeof ACTIONABLE_BANK_TRANSACTION_STATUSES)[number],
  );
}

export interface BankTransactionProps {
  id: string;
  organizationId: string;
  bankConnectionId: string;
  webhookInboxId: string;
  providerTransactionId: string;
  amount: number;
  transactionDateTime: Date;
  counterpartyAccountNumber: string;
  counterpartyName: string;
  transferContent: string;
  status: BankTransactionStatus;
  version: number;
  createdAt: Date;
  aiRecommendation?: AiMatchingRecommendation | null;
}

export class BankTransaction {
  readonly id: string;
  readonly organizationId: string;
  readonly bankConnectionId: string;
  readonly webhookInboxId: string;
  readonly providerTransactionId: string;
  readonly amount: number;
  readonly transactionDateTime: Date;
  readonly counterpartyAccountNumber: string;
  readonly counterpartyName: string;
  readonly transferContent: string;
  readonly status: BankTransactionStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly aiRecommendation: AiMatchingRecommendation | null;

  constructor(props: BankTransactionProps) {
    Object.assign(this, props);
    this.aiRecommendation = props.aiRecommendation ?? null;
  }
  isRefund(): boolean {
    return this.amount < 0;
  }
  markMatched(): BankTransaction {
    return new BankTransaction({ ...this, status: 'MATCHED' });
  }
  markPendingReview(): BankTransaction {
    return new BankTransaction({ ...this, status: 'PENDING_REVIEW' });
  }
  markUnmatched(): BankTransaction {
    return new BankTransaction({ ...this, status: 'UNMATCHED' });
  }
  markIgnored(): BankTransaction {
    return new BankTransaction({ ...this, status: 'IGNORED' });
  }
  markPrepaid(): BankTransaction {
    return new BankTransaction({ ...this, status: 'PREPAID' });
  }
  withAiRecommendation(
    aiRecommendation: AiMatchingRecommendation,
  ): BankTransaction {
    return new BankTransaction({ ...this, aiRecommendation });
  }
}
