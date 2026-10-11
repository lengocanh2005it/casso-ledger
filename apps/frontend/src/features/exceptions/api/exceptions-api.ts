import { apiRequest, postWithIdempotency } from '@/lib/api-client';
import type { BatchItemResult } from '@/lib/batch-types';
import type {
  BankTransaction,
  MatchingCandidate,
  Payment,
  PendingReviewItem,
  QueueStatus,
} from '../types';

export interface PendingReviewPage {
  items: PendingReviewItem[];
  total: number;
  page: number;
  limit: number;
}

export function fetchPendingReview(
  page: number,
  search?: string,
  status?: QueueStatus,
): Promise<PendingReviewPage> {
  return apiRequest<PendingReviewPage>({
    url: '/api/v1/bank-transactions/unmatched',
    method: 'GET',
    params: {
      page,
      limit: 20,
      ...(search ? { search } : {}),
      ...(status ? { status } : {}),
    },
  });
}

export function fetchCandidates(
  bankTransactionId: string,
): Promise<MatchingCandidate[]> {
  return apiRequest<MatchingCandidate[]>({
    url: `/api/v1/bank-transactions/${bankTransactionId}/candidates`,
    method: 'GET',
  });
}

export function splitMatch(
  bankTransactionId: string,
  allocations: Array<{ receivableId: string; amount: number }>,
  version: number,
): Promise<{ id: string }> {
  return postWithIdempotency<{ id: string }>(
    `/api/v1/bank-transactions/${bankTransactionId}/match`,
    { allocations, version },
  );
}

export function skipTransaction(
  bankTransactionId: string,
): Promise<{ id: string }> {
  return postWithIdempotency<{ id: string }>(
    `/api/v1/bank-transactions/${bankTransactionId}/skip`,
  );
}

export function markPrepaid(
  bankTransactionId: string,
  customerId: string,
): Promise<{ id: string }> {
  return postWithIdempotency<{ id: string }>(
    `/api/v1/bank-transactions/${bankTransactionId}/mark-prepaid`,
    { customerId },
  );
}

export function batchSkip(
  ids: string[],
): Promise<{ results: BatchItemResult<BankTransaction>[] }> {
  return postWithIdempotency('/api/v1/bank-transactions/batch-skip', { ids });
}

export function batchMarkPrepaid(
  bankTransactionIds: string[],
  customerId: string,
): Promise<{
  results: BatchItemResult<{
    transaction: BankTransaction;
    payment: Payment;
  }>[];
}> {
  return postWithIdempotency('/api/v1/bank-transactions/batch-mark-prepaid', {
    bankTransactionIds,
    customerId,
  });
}

export interface BatchMatchItemInput {
  bankTransactionId: string;
  allocations: Array<{ receivableId: string; amount: number }>;
  version: number;
}

export function batchApproveMatch(
  items: BatchMatchItemInput[],
): Promise<{ results: BatchItemResult<BankTransaction>[] }> {
  return postWithIdempotency('/api/v1/bank-transactions/batch-match', {
    items,
  });
}
