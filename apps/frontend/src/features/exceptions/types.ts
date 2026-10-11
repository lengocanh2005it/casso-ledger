export type BankTransactionStatus =
  | 'UNMATCHED'
  | 'PENDING_REVIEW'
  | 'MATCHED'
  | 'IGNORED'
  | 'PREPAID';

/** Statuses a reviewer can still act on: the Exception Queue shows both. */
export type QueueStatus = 'PENDING_REVIEW' | 'UNMATCHED';

export interface BankTransaction {
  id: string;
  bankConnectionId?: string;
  providerTransactionId: string;
  amount: number;
  transactionDateTime: string;
  counterpartyAccountNumber: string | null;
  counterpartyName: string | null;
  transferContent: string | null;
  status: BankTransactionStatus;
  version: number;
  createdAt?: string;
}

export type AiRecommendationStatus = 'SUCCEEDED' | 'ABSTAINED' | 'FAILED';

export interface AiRecommendation {
  status: AiRecommendationStatus;
  recommendedReceivableId: string | null;
  confidence: number | null;
  reason: string | null;
  isCurrent: boolean;
}

export interface MatchingCandidate {
  id: string;
  bankTransactionId?: string;
  receivableId: string;
  customerId: string;
  referenceCodeScore: number;
  amountScore: number;
  customerBankAccountScore: number;
  payerNameScore: number;
  timingScore: number;
  totalScore: number;
  invoiceNumber: string | null;
  customerName: string | null;
  remainingAmount: number | null;
  dueDate: string | null;
  createdAt: string;
}

export interface PayerLinkedCustomer {
  customerId: string;
  customerName: string;
}

export interface Payer {
  accountNumberMasked: string;
  name: string;
  linkedCustomers: PayerLinkedCustomer[];
}

export interface PendingReviewItem {
  transaction: BankTransaction;
  topCandidate: MatchingCandidate | null;
  /** Top candidate leads the runner-up by < 10 points: a human must choose. */
  isAmbiguous?: boolean;
  aiRecommendation?: AiRecommendation | null;
  payer: Payer;
}

export interface Payment {
  id: string;
  customerId: string | null;
  bankTransactionId: string | null;
  totalAmount: number;
  allocatedAmount: number;
  unallocatedAmount: number;
  payerName: string;
  receivedAt: string;
  createdAt: string;
}
