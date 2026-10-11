import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import type { QueueStatus } from '../types';
import {
  batchApproveMatch,
  batchMarkPrepaid,
  batchSkip,
  fetchCandidates,
  fetchPendingReview,
  markPrepaid,
  skipTransaction,
  splitMatch,
} from './exceptions-api';

export function usePendingReview(
  page = 1,
  search?: string,
  status?: QueueStatus,
) {
  return useQuery({
    queryKey: ['bank-transactions', page, search, status ?? null],
    queryFn: () => fetchPendingReview(page, search, status),
    placeholderData: keepPreviousData,
  });
}

export function useCandidates(bankTransactionId: string) {
  return useQuery({
    queryKey: ['bank-transaction-candidates', bankTransactionId],
    queryFn: () => fetchCandidates(bankTransactionId),
    enabled: bankTransactionId.length > 0,
  });
}

function useExceptionMutation<TInput, TResult = unknown>(
  mutationFn: (input: TInput) => Promise<TResult>,
  onError?: (error: unknown) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bank-transactions'] });
      void queryClient.invalidateQueries({
        queryKey: ['exceptions', 'review-count'],
      });
    },
    onError,
  });
}

function isConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  };
  return candidate.status === 409 || candidate.response?.status === 409;
}

export function useSplitMatch() {
  return useExceptionMutation<{
    id: string;
    allocations: Array<{ receivableId: string; amount: number }>;
    version: number;
  }>(
    ({ id, allocations, version }) => splitMatch(id, allocations, version),
    (error) => {
      if (isConflict(error)) {
        toast.error(
          'Transaction was processed by another user; reload the list',
        );
      }
    },
  );
}

export function useSkipTransaction() {
  return useExceptionMutation<string>(skipTransaction);
}

export function useMarkPrepaid() {
  return useExceptionMutation<{ id: string; customerId: string }>(
    ({ id, customerId }) => markPrepaid(id, customerId),
  );
}

export function useBatchSkip() {
  return useExceptionMutation(batchSkip);
}

export function useBatchMarkPrepaid() {
  return useExceptionMutation<
    { ids: string[]; customerId: string },
    Awaited<ReturnType<typeof batchMarkPrepaid>>
  >(({ ids, customerId }) => batchMarkPrepaid(ids, customerId));
}

export function useBatchApproveMatch() {
  return useExceptionMutation(batchApproveMatch);
}
