import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  batchCancelReceivables,
  batchWriteOffReceivables,
  type CreateReceivableInput,
  cancelReceivable,
  createReceivable,
  fetchReceivable,
  fetchReceivables,
  type ReceivableFilters,
  writeOffReceivable,
} from './receivables-api';

export function useReceivables(
  filters: ReceivableFilters,
  page = 1,
  limit = 20,
  {
    keepPreviousPage = false,
    enabled = true,
  }: { keepPreviousPage?: boolean; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ['receivables', filters, page, limit],
    queryFn: () => fetchReceivables(filters, page, limit),
    enabled,
    // Opt-in for the paged list: keeps its rows and pager mounted while the
    // next page loads. Off by default so a screen scoped to one customer
    // never shows another customer's receivables while loading.
    placeholderData: keepPreviousPage ? keepPreviousData : undefined,
  });
}

export function useReceivable(id: string) {
  return useQuery({
    queryKey: ['receivable', id],
    queryFn: () => fetchReceivable(id),
    enabled: id.length > 0,
  });
}

function useReceivableMutation<TInput, TResult = unknown>(
  mutationFn: (input: TInput) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (_, input) => {
      void queryClient.invalidateQueries({ queryKey: ['receivables'] });
      if (typeof input === 'string') {
        void queryClient.invalidateQueries({ queryKey: ['receivable', input] });
      }
    },
  });
}

export function useCreateReceivable() {
  return useReceivableMutation<CreateReceivableInput>(createReceivable);
}

export function useWriteOffReceivable() {
  return useReceivableMutation<string>(writeOffReceivable);
}

export function useCancelReceivable() {
  return useReceivableMutation<string>(cancelReceivable);
}

export function useBatchWriteOffReceivables() {
  return useReceivableMutation(batchWriteOffReceivables);
}

export function useBatchCancelReceivables() {
  return useReceivableMutation(batchCancelReceivables);
}
