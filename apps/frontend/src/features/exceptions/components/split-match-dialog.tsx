import { Permission, ReceivableStatus } from '@casso-ar/shared-types';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { TruncatedCopyId } from '@/components/shared/truncated-copy-id';
import { TruncatedText } from '@/components/shared/truncated-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/contexts/auth-context';
import { createCustomerBankAccount } from '@/features/customers/api/customers-api';
import { useCustomers } from '@/features/customers/api/use-customers';
import { getAllocationErrorMessage } from '@/features/payments/allocation-errors';
import { useReceivables } from '@/features/receivables/api/use-receivables';
import { getReceivableDisplayName } from '@/features/receivables/receivable-label';
import { getApiErrorCode, getApiErrorDetails } from '@/lib/api-client';
import { formatDate, formatVND } from '@/lib/format';
import { hasPermission } from '@/lib/rbac';
import {
  useCandidates,
  useMarkPrepaid,
  useSkipTransaction,
  useSplitMatch,
} from '../api/use-exceptions';
import type { AiRecommendation, BankTransaction, Payer } from '../types';

function AiRecommendationNotice({
  recommendation,
}: {
  recommendation: AiRecommendation | null | undefined;
}) {
  if (recommendation?.status === 'SUCCEEDED' && recommendation.isCurrent) {
    const confidenceLabel =
      (recommendation.confidence ?? 0) >= 80 ? 'Cao' : 'Vừa';
    return (
      <div className="space-y-1 rounded-lg border border-primary/20 bg-primary/5 p-3">
        <Badge variant="secondary">Gợi ý AI · {confidenceLabel}</Badge>
        {recommendation.reason && (
          <p className="text-sm text-muted-foreground">
            {recommendation.reason}
          </p>
        )}
      </div>
    );
  }
  return <p className="text-sm text-muted-foreground">AI không có gợi ý</p>;
}

// ponytail: the list endpoint's max page. A customer with more open
// receivables than this would need its own paging in the picker.
const MANUAL_PICK_LIMIT = 100;

async function rememberPayerAccount(
  customerId: string,
  customerName: string | null,
  accountNumber: string,
): Promise<void> {
  try {
    await createCustomerBankAccount(customerId, { accountNumber });
    toast.success(
      `Đã ghi nhớ tài khoản người chuyển${
        customerName ? ` cho ${customerName}` : ''
      }.`,
    );
  } catch (error) {
    const code = getApiErrorCode(error);
    if (code === 'CONFLICT') {
      const names = getApiErrorDetails(error)?.linkedCustomerNames;
      if (Array.isArray(names) && names.length > 0) {
        toast.warning(
          `Tài khoản này đang liên kết với ${names.join(', ')}. Chưa ghi nhớ.`,
        );
      }
      // A same-customer duplicate means the link already exists — nothing to do.
      return;
    }
    if (code === 'VALIDATION_ERROR') {
      toast.warning('Số tài khoản không hợp lệ, chưa ghi nhớ.');
      return;
    }
    toast.error('Không ghi nhớ được tài khoản người chuyển.');
  }
}

export function SplitMatchDialog({
  tx,
  aiRecommendation,
  payer,
  open,
  onOpenChange,
}: {
  tx: BankTransaction;
  aiRecommendation?: AiRecommendation | null;
  payer?: Payer | null;
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const { user } = useAuth();
  const {
    data: candidates = [],
    isLoading: candidatesLoading,
    isError: candidatesFailed,
  } = useCandidates(open ? tx.id : '');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [customerSearch, setCustomerSearch] = useState('');
  const [prepaidCustomerId, setPrepaidCustomerId] = useState('');
  const [allocationError, setAllocationError] = useState<string | null>(null);
  const [rememberPayer, setRememberPayer] = useState(true);
  const { data: customerPage } = useCustomers(
    customerSearch,
    1,
    open && customerSearch.trim().length > 0,
  );
  const splitMatch = useSplitMatch();
  const skip = useSkipTransaction();
  const prepaid = useMarkPrepaid();

  useEffect(() => {
    if (open) {
      setAmounts({});
      setCustomerSearch('');
      setPrepaidCustomerId('');
      setAllocationError(null);
      setRememberPayer(true);
    }
  }, [open]);

  const sortedCandidates = useMemo(
    () => [...candidates].sort((a, b) => b.totalScore - a.totalScore),
    [candidates],
  );
  // An UNMATCHED transaction stores no candidates at all, so the reviewer
  // picks the customer first and allocates against their open receivables.
  // Only a *settled empty* candidate list means that: a failed request must
  // not masquerade as "no suggestions".
  const needsManualPick =
    !candidatesLoading && !candidatesFailed && sortedCandidates.length === 0;
  // Ask the server for the open statuses rather than fetching one capped page
  // and narrowing it here: a customer with many closed receivables would fill
  // the page with rows that can never be allocated to.
  const manualPickEnabled =
    open && needsManualPick && prepaidCustomerId.length > 0;
  const { data: openPage, isError: openFailed } = useReceivables(
    { customerId: prepaidCustomerId, status: ReceivableStatus.OPEN },
    1,
    MANUAL_PICK_LIMIT,
    { enabled: manualPickEnabled },
  );
  const { data: partialPage, isError: partialFailed } = useReceivables(
    { customerId: prepaidCustomerId, status: ReceivableStatus.PARTIALLY_PAID },
    1,
    MANUAL_PICK_LIMIT,
    { enabled: manualPickEnabled },
  );
  const manualPickFailed = manualPickEnabled && (openFailed || partialFailed);
  const manualPickReceivables = useMemo(
    () =>
      needsManualPick && !manualPickFailed
        ? [...(openPage?.items ?? []), ...(partialPage?.items ?? [])].filter(
            (receivable) => receivable.remainingAmount > 0,
          )
        : [],
    [needsManualPick, manualPickFailed, openPage, partialPage],
  );
  const rows = useMemo(
    () =>
      needsManualPick
        ? manualPickReceivables.map((receivable) => ({
            receivableId: receivable.id,
            customerId: receivable.customerId,
            customerName: receivable.customerName ?? null,
            invoiceNumber: receivable.invoiceNumber,
            remainingAmount: receivable.remainingAmount,
            dueDate: receivable.dueDate,
            score: null,
          }))
        : sortedCandidates.map((candidate) => ({
            receivableId: candidate.receivableId,
            customerId: candidate.customerId,
            customerName: candidate.customerName,
            invoiceNumber: candidate.invoiceNumber,
            remainingAmount: candidate.remainingAmount,
            dueDate: candidate.dueDate,
            score: candidate.totalScore,
          })),
    [needsManualPick, manualPickReceivables, sortedCandidates],
  );
  const allocations = rows
    .filter((row) => Number(amounts[row.receivableId]) > 0)
    .map((row) => ({
      receivableId: row.receivableId,
      amount: Number(amounts[row.receivableId]),
    }));
  // Summed from the allocations, not from `amounts`: switching customer in
  // manual-pick mode drops the old rows from `rows` but leaves their amounts
  // behind, and a total the user is not actually sending is a lie.
  const total = allocations.reduce((sum, item) => sum + item.amount, 0);
  const amountsAreIntegers = allocations.every((allocation) =>
    Number.isInteger(allocation.amount),
  );
  const valid =
    total > 0 && total <= tx.amount && amountsAreIntegers && tx.amount > 0;

  const chosenRow = rows.find((row) => Number(amounts[row.receivableId]) > 0);
  const chosenCustomerId = chosenRow?.customerId ?? null;
  const chosenCustomerName = chosenRow?.customerName ?? null;
  const accountNumber = tx.counterpartyAccountNumber?.trim() || null;
  const linkedCustomers = payer?.linkedCustomers ?? [];
  const alreadyLinkedToChosen =
    chosenCustomerId !== null &&
    linkedCustomers.some((c) => c.customerId === chosenCustomerId);
  const otherLinkedCustomerNames = linkedCustomers
    .filter((c) => c.customerId !== chosenCustomerId)
    .map((c) => c.customerName);
  const linkedToDifferentCustomer =
    chosenCustomerId !== null &&
    !alreadyLinkedToChosen &&
    otherLinkedCustomerNames.length > 0;
  const showRememberCheckbox = accountNumber !== null && !alreadyLinkedToChosen;

  useEffect(() => {
    if (linkedToDifferentCustomer) {
      setRememberPayer(false);
    }
  }, [linkedToDifferentCustomer]);

  if (!hasPermission(user?.role ?? null, Permission.PAYMENT_ALLOCATE)) {
    return null;
  }

  // The raw provider reference (e.g. "provider-7b2c0530") means nothing to a
  // user — show who the transaction is with when we know it, falling back
  // to the transfer content, and only to the raw id if neither is available.
  const transactionLabel =
    tx.counterpartyName?.trim() ||
    tx.transferContent?.trim() ||
    tx.providerTransactionId;

  function onMatch() {
    if (!valid) {
      setAllocationError(
        `Tổng phân bổ ${formatVND(total)} không được vượt quá số tiền giao dịch ${formatVND(tx.amount)}.`,
      );
      return;
    }
    setAllocationError(null);
    splitMatch.mutate(
      { id: tx.id, allocations, version: tx.version },
      {
        onSuccess: () => {
          // The match is the primary action — close first, then the aside.
          onOpenChange(false);
          if (rememberPayer && chosenCustomerId && accountNumber) {
            void rememberPayerAccount(
              chosenCustomerId,
              chosenCustomerName,
              accountNumber,
            );
          }
        },
        onError: (error) =>
          setAllocationError(getAllocationErrorMessage(error)),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Candidate-heavy transactions grow tall: cap the dialog and scroll the
          body so the title, description and close button stay on screen. */}
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="min-w-0 pr-6 leading-snug">
            Xử lý giao dịch{' '}
            <TruncatedText
              className="inline-block max-w-full truncate align-bottom"
              value={transactionLabel}
            >
              {transactionLabel}
            </TruncatedText>{' '}
            — {formatVND(tx.amount)}
          </DialogTitle>
          <DialogDescription>
            Xem lại các khoản phải thu gợi ý trước khi phân bổ giao dịch ngân
            hàng này.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain">
          <AiRecommendationNotice recommendation={aiRecommendation} />
          {payer &&
            (payer.accountNumberMasked || payer.linkedCustomers.length > 0) && (
              <div className="rounded-lg border p-3">
                <p className="text-sm font-medium">Người chuyển khoản</p>
                <p className="text-sm text-muted-foreground">
                  {payer.name || tx.counterpartyName || '—'}
                  {payer.accountNumberMasked && (
                    <span className="ml-2 tabular-nums">
                      {payer.accountNumberMasked}
                    </span>
                  )}
                </p>
                {payer.linkedCustomers.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {payer.linkedCustomers.map((c) => (
                      <Badge
                        key={c.customerId}
                        variant="secondary"
                        className="text-[10px]"
                      >
                        {c.customerName}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            )}
          {showRememberCheckbox && (
            <label
              htmlFor="remember-payer"
              className="flex items-start gap-2 text-sm"
            >
              <Checkbox
                id="remember-payer"
                className="mt-0.5"
                checked={rememberPayer}
                onCheckedChange={(value) => setRememberPayer(value === true)}
                aria-label="Ghi nhớ tài khoản người chuyển cho khách hàng này"
              />
              <span>
                Ghi nhớ tài khoản người chuyển cho khách hàng này
                {linkedToDifferentCustomer && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Tài khoản này đang liên kết với{' '}
                    {otherLinkedCustomerNames.join(', ')}. Bỏ tích để không ghi
                    nhớ.
                  </span>
                )}
              </span>
            </label>
          )}
          <div>
            <p className="text-sm font-medium">Nội dung chuyển khoản</p>
            {tx.transferContent?.trim() ? (
              <p className="break-words text-sm text-muted-foreground">
                {tx.transferContent}
              </p>
            ) : (
              <p className="text-sm italic text-muted-foreground">
                Không có nội dung
              </p>
            )}
          </div>
          {needsManualPick && !prepaidCustomerId && (
            <p className="text-sm text-muted-foreground">
              Chưa có gợi ý khớp cho giao dịch này. Hãy chọn khách hàng để xem
              các khoản phải thu còn mở.
            </p>
          )}
          {needsManualPick && manualPickFailed && (
            <p role="alert" className="text-sm text-destructive">
              Không tải được danh sách công nợ của khách hàng này. Vui lòng thử
              lại trước khi quyết định ghi nhận công nợ.
            </p>
          )}
          {needsManualPick &&
            !manualPickFailed &&
            prepaidCustomerId &&
            manualPickReceivables.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Khách hàng này không có khoản phải thu còn mở. Hãy ghi nhận công
                nợ nếu đó là tiền trả trước.
              </p>
            )}
          {rows.map((row) => {
            const receivableLabel = getReceivableDisplayName(row.invoiceNumber);
            const candidateLabel = row.customerName
              ? `${receivableLabel} — ${row.customerName}`
              : receivableLabel;

            return (
              <div
                key={row.receivableId}
                className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:gap-3"
              >
                {row.score !== null && (
                  <span className="text-sm font-medium tabular-nums">
                    {row.score}/100
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <TruncatedText
                    className="truncate text-sm"
                    value={candidateLabel}
                  >
                    {candidateLabel}
                  </TruncatedText>
                  <p className="text-xs text-muted-foreground">
                    Còn lại:{' '}
                    {row.remainingAmount === null
                      ? 'Chưa có số dư'
                      : formatVND(row.remainingAmount)}{' '}
                    · Hạn thanh toán:{' '}
                    {row.dueDate
                      ? formatDate(row.dueDate)
                      : 'Chưa có hạn thanh toán'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Mã kỹ thuật: <TruncatedCopyId id={row.receivableId} />
                  </p>
                </div>
                <div className="shrink-0 space-y-2">
                  <label
                    htmlFor={`allocation-${row.receivableId}`}
                    className="block text-xs font-medium text-muted-foreground"
                  >
                    Số tiền phân bổ
                  </label>
                  <Input
                    name={`allocation-${row.receivableId}`}
                    autoComplete="off"
                    aria-label={`Số tiền phân bổ cho ${receivableLabel}`}
                    id={`allocation-${row.receivableId}`}
                    type="number"
                    min={0}
                    step={1}
                    className="h-10 w-full text-right tabular-nums sm:w-40"
                    value={amounts[row.receivableId] ?? ''}
                    onChange={(event) => {
                      setAmounts((current) => ({
                        ...current,
                        [row.receivableId]: event.target.value,
                      }));
                      setAllocationError(null);
                    }}
                  />
                </div>
              </div>
            );
          })}
          <p className="text-sm">
            Đã phân bổ:{' '}
            <span className="font-semibold tabular-nums">
              {formatVND(total)}
            </span>{' '}
            /{' '}
            <span className="tabular-nums text-muted-foreground">
              {formatVND(tx.amount)}
            </span>
          </p>
          {allocationError && (
            <p
              role="alert"
              aria-live="polite"
              className="text-sm text-destructive"
            >
              {allocationError}
            </p>
          )}
          <label htmlFor="customer-search" className="grid gap-2 text-sm">
            <span>
              {needsManualPick
                ? 'Tìm khách hàng để chọn khoản phải thu'
                : 'Tìm khách hàng để ghi nhận công nợ'}
            </span>
            <Input
              name="customerSearch"
              autoComplete="off"
              id="customer-search"
              value={customerSearch}
              onChange={(event) => {
                setCustomerSearch(event.target.value);
                setPrepaidCustomerId('');
              }}
              placeholder="Tên khách hàng, mã số thuế hoặc số điện thoại…"
            />
          </label>
          {customerPage && customerPage.items.length > 0 && (
            <Select
              value={prepaidCustomerId}
              onValueChange={setPrepaidCustomerId}
            >
              <SelectTrigger
                aria-label={
                  needsManualPick
                    ? 'Khách hàng để chọn khoản phải thu'
                    : 'Khách hàng để ghi nhận công nợ'
                }
                className="w-full"
              >
                <SelectValue placeholder="Chọn khách hàng" />
              </SelectTrigger>
              <SelectContent>
                {customerPage.items.map((customer) => (
                  <SelectItem key={customer.id} value={customer.id}>
                    {customer.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              disabled={!prepaidCustomerId || prepaid.isPending}
              onClick={() =>
                prepaid.mutate(
                  { id: tx.id, customerId: prepaidCustomerId },
                  { onSuccess: () => onOpenChange(false) },
                )
              }
            >
              Ghi nhận công nợ
            </Button>
            <Button
              variant="outline"
              disabled={skip.isPending}
              onClick={() =>
                skip.mutate(tx.id, { onSuccess: () => onOpenChange(false) })
              }
            >
              Bỏ qua
            </Button>
            <Button onClick={onMatch} disabled={!valid || splitMatch.isPending}>
              Khớp giao dịch
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
