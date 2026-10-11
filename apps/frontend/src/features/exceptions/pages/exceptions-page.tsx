import { CheckCheck, FileSearch, Search, SearchX } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/components/layout/empty-state';
import { PageHeading } from '@/components/layout/page-heading';
import { SectionCard } from '@/components/layout/section-card';
import { CardPagination } from '@/components/shared/card-pagination';
import { InitialsAvatar } from '@/components/shared/initials-avatar';
import {
  TruncatedName,
  TruncatedText,
} from '@/components/shared/truncated-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TableSkeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime, formatVND } from '@/lib/format';
import { useBulkSelection } from '@/lib/use-bulk-selection';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useUrlQueryParams } from '@/lib/use-url-query-params';
import { cn } from '@/lib/utils';
import { usePendingReview } from '../api/use-exceptions';
import { ExceptionsBulkActionBar } from '../components/exceptions-bulk-action-bar';
import { SplitMatchDialog } from '../components/split-match-dialog';
import type { AiRecommendation, PendingReviewItem } from '../types';

function AiRecommendationBadge({
  recommendation,
}: {
  recommendation: AiRecommendation | null | undefined;
}) {
  if (
    recommendation?.status !== 'SUCCEEDED' ||
    recommendation?.isCurrent !== true
  ) {
    return null;
  }
  const confidenceLabel =
    (recommendation.confidence ?? 0) >= 80 ? 'Cao' : 'Vừa';
  return <Badge variant="secondary">Gợi ý AI · {confidenceLabel}</Badge>;
}

export function ExceptionsPage() {
  const { searchParams, setParam, setPage } = useUrlQueryParams();
  const page = Number(searchParams.get('page') ?? '1');
  const search = searchParams.get('search') ?? '';
  const status = searchParams.get('status') ?? '';
  const debouncedSearch = useDebouncedValue(search, 250);
  const [selected, setSelected] = useState<PendingReviewItem | null>(null);
  const { data, isPending, isError, isPlaceholderData, refetch, isFetching } =
    usePendingReview(
      page,
      debouncedSearch || undefined,
      status === 'UNMATCHED' || status === 'PENDING_REVIEW'
        ? status
        : undefined,
    );
  // Placeholder rows belong to the previous page/search: clear the selection
  // so skip / prepaid / match cannot act on them under the new context.
  const bulkSelection = useBulkSelection(
    isPlaceholderData
      ? []
      : (data?.items ?? []).map((item) => item.transaction.id),
  );
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  // An empty placeholder is the previous search's result; its empty state
  // would describe the wrong search, so show the skeleton instead.
  const showsEmptyPlaceholder = isPlaceholderData && data?.items.length === 0;

  return (
    <div className="space-y-5">
      <PageHeading
        eyebrow="CẦN XỬ LÝ"
        title="Hàng chờ xử lý ngoại lệ"
        description="Đối soát các giao dịch ngân hàng chưa khớp với công nợ."
        icon={FileSearch}
        tone="warning"
      />
      <SectionCard
        icon={FileSearch}
        title="Giao dịch cần rà soát"
        description="Tìm kiếm, chọn và xử lý các giao dịch chưa khớp."
      >
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:max-w-md">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              name="search"
              type="search"
              autoComplete="off"
              aria-label="Tìm kiếm giao dịch"
              placeholder="Tìm tên, số tài khoản, nội dung…"
              value={search}
              onChange={(event) =>
                setParam('search', event.target.value, {
                  resetPage: true,
                  replace: true,
                })
              }
              className="pl-9"
            />
          </div>
          {/* Both queue statuses are actionable; the filter only narrows which
              of them the reviewer is looking at. */}
          <Select
            value={status}
            onValueChange={(value) =>
              setParam('status', value, { resetPage: true, replace: true })
            }
          >
            <SelectTrigger aria-label="Lọc theo trạng thái" className="w-52">
              <SelectValue placeholder="Tất cả trạng thái" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả trạng thái</SelectItem>
              <SelectItem value="PENDING_REVIEW">Chờ rà soát</SelectItem>
              <SelectItem value="UNMATCHED">Chưa khớp</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {(isPending || showsEmptyPlaceholder) && <TableSkeleton rows={5} />}
        {isError && (
          <div role="alert" className="flex flex-wrap items-center gap-3">
            <p className="text-destructive">
              Không thể tải danh sách giao dịch cần xử lý. Vui lòng thử lại.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              {isFetching ? 'Đang thử lại…' : 'Thử lại'}
            </Button>
          </div>
        )}
        {/* Worded from the search the data was fetched for (debounced),
            not the box's current text. */}
        {data && data.items.length === 0 && !showsEmptyPlaceholder && (
          <div role="status" aria-live="polite">
            <EmptyState
              icon={debouncedSearch ? SearchX : CheckCheck}
              title={
                debouncedSearch
                  ? 'Không tìm thấy giao dịch phù hợp.'
                  : 'Không có giao dịch cần xử lý.'
              }
              description={
                debouncedSearch
                  ? 'Thử thay đổi từ khóa để xem thêm giao dịch.'
                  : 'Mọi khoản tiền về đã được khớp. Giao dịch cần đối soát sẽ xuất hiện tại đây.'
              }
            />
          </div>
        )}
        {data && data.items.length > 0 && (
          <div
            aria-busy={isPlaceholderData}
            inert={isPlaceholderData}
            className={cn(
              'transition-opacity motion-reduce:transition-none',
              isPlaceholderData && 'opacity-60',
            )}
          >
            <Table className="lg:table-fixed">
              {/* Cards keep the payer, amount and action readable until the
                  app shell has enough room for a table. At lg, hide advisory
                  columns until xl; both are also available in the review dialog. */}
              <TableHeader className="max-lg:hidden">
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="Chọn tất cả"
                      checked={bulkSelection.allSelected}
                      onCheckedChange={bulkSelection.toggleAll}
                    />
                  </TableHead>
                  <TableHead className="w-[10rem] whitespace-nowrap">
                    Ngày giờ
                  </TableHead>
                  <TableHead className="min-w-0">Người chuyển khoản</TableHead>
                  <TableHead className="min-w-0 lg:max-xl:hidden">
                    Nội dung chuyển khoản
                  </TableHead>
                  <TableHead className="w-44 text-right whitespace-nowrap">
                    Số tiền
                  </TableHead>
                  {/* Score and action stay compact; score returns at xl and
                      action returns once the table layout starts at lg. */}
                  <TableHead className="w-[7.5rem] whitespace-nowrap lg:max-xl:hidden">
                    Điểm cao nhất
                  </TableHead>
                  {/* The row ends in a "Xử lý" link; an sr-only-only header
                      left a column of them with nothing above it. The label
                      only makes sense once the row is a table again, so it
                      stays hidden on the phone card layout where the action
                      sits next to the amount instead. */}
                  <TableHead className="w-[6.5rem] text-right whitespace-nowrap max-lg:hidden">
                    Hành động
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((row) => (
                  // Below lg: [☐] payer ........ amount / content / date · score · Xử lý
                  <TableRow
                    key={row.transaction.id}
                    className="max-lg:grid max-lg:grid-cols-[auto_minmax(0,1fr)_auto] max-lg:items-center max-lg:gap-x-3 max-lg:gap-y-1 max-lg:px-1 max-lg:py-1.5"
                  >
                    <TableCell
                      className="max-lg:col-start-1 max-lg:row-span-3 max-lg:row-start-1 max-lg:self-start max-lg:p-0"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <Checkbox
                        aria-label={`Chọn giao dịch ${row.transaction.providerTransactionId}`}
                        checked={bulkSelection.isSelected(row.transaction.id)}
                        onCheckedChange={() =>
                          bulkSelection.toggle(row.transaction.id)
                        }
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums max-lg:col-start-2 max-lg:row-start-3 max-lg:p-0 max-lg:text-xs max-lg:text-muted-foreground max-lg:whitespace-normal">
                      {formatDateTime(row.transaction.transactionDateTime)}
                    </TableCell>
                    <TableCell className="min-w-0 max-lg:col-start-2 max-lg:row-start-1 max-lg:p-0">
                      <div className="flex min-w-0 items-start gap-2">
                        <div className="hidden lg:block">
                          <InitialsAvatar
                            name={row.transaction.counterpartyName ?? '—'}
                            size="sm"
                          />
                        </div>
                        <div className="min-w-0 space-y-1">
                          <p className="min-w-0 font-medium">
                            <TruncatedName
                              name={row.transaction.counterpartyName ?? '—'}
                            />
                          </p>
                          {row.payer?.accountNumberMasked && (
                            <p className="min-w-0 max-w-full break-all text-xs text-muted-foreground tabular-nums">
                              {row.payer.accountNumberMasked.length > 16
                                ? `${'*'.repeat(8)}${row.payer.accountNumberMasked.slice(-4)}`
                                : row.payer.accountNumberMasked}
                            </p>
                          )}
                          {(row.payer?.linkedCustomers ?? []).length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {row.payer.linkedCustomers.map((c) => (
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
                      </div>
                    </TableCell>
                    <TableCell className="min-w-0 lg:max-xl:hidden max-lg:col-span-2 max-lg:row-start-2 max-lg:col-start-2 max-lg:p-0 max-lg:text-sm">
                      {row.transaction.transferContent?.trim() ? (
                        <TruncatedText
                          className="line-clamp-2"
                          value={row.transaction.transferContent}
                        >
                          {row.transaction.transferContent}
                        </TruncatedText>
                      ) : (
                        <span className="italic text-muted-foreground">
                          Không có nội dung
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-semibold whitespace-nowrap tabular-nums max-lg:col-start-3 max-lg:row-start-1 max-lg:self-start max-lg:p-0">
                      {formatVND(row.transaction.amount)}
                    </TableCell>
                    <TableCell className="lg:max-xl:hidden max-lg:col-start-2 max-lg:row-start-3 max-lg:justify-self-end max-lg:p-0">
                      <div className="flex flex-col items-start gap-1 max-lg:flex-row max-lg:items-center">
                        {row.topCandidate ? (
                          <Badge variant="outline">
                            {row.topCandidate.totalScore}/100
                          </Badge>
                        ) : row.transaction.status === 'UNMATCHED' ? (
                          <Badge variant="outline">Chưa khớp</Badge>
                        ) : (
                          <span className="text-muted-foreground max-lg:hidden">
                            —
                          </span>
                        )}
                        <AiRecommendationBadge
                          recommendation={row.aiRecommendation}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-right max-lg:col-start-3 max-lg:row-start-3 max-lg:p-0">
                      <Button
                        variant="link"
                        size="sm"
                        // The card layout gives the row no vertical padding
                        // of its own, so the button's own padding IS the hit
                        // area. Stripping it (`max-lg:h-auto max-lg:px-0`)
                        // measured at 29x16px on a 390px screen — below even
                        // the 24px floor. The link tone stays; the target is
                        // padded back out.
                        className="max-lg:min-h-9 max-lg:px-2"
                        onClick={() => setSelected(row)}
                      >
                        Xử lý
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {data && (
          <CardPagination
            page={page}
            totalPages={totalPages}
            summary={`${data.total.toLocaleString('vi-VN')} giao dịch`}
            onPageChange={setPage}
          />
        )}
      </SectionCard>
      {data && (
        <ExceptionsBulkActionBar
          items={data.items}
          selectedIds={bulkSelection.selectedIds}
          onResult={(succeeded) => bulkSelection.drop(succeeded)}
        />
      )}{' '}
      {selected && (
        <SplitMatchDialog
          tx={selected.transaction}
          aiRecommendation={selected.aiRecommendation}
          payer={selected.payer}
          open
          onOpenChange={(value) => {
            if (!value) setSelected(null);
          }}
        />
      )}
    </div>
  );
}
