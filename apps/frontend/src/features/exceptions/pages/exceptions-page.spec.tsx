import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { hoverTooltip } from '@/test/tooltip';
import { ExceptionsPage } from './exceptions-page';

const apiRequest = vi.fn();

vi.mock('@/lib/api-client', () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  postWithIdempotency: vi.fn(),
}));
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { role: 'ACCOUNTANT' } }),
}));

describe('ExceptionsPage', () => {
  it('sends the search box value as a search filter', async () => {
    apiRequest.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.change(
      await screen.findByPlaceholderText('Tìm tên, số tài khoản, nội dung…'),
      { target: { value: 'nguyen van a' } },
    );

    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          url: '/api/v1/bank-transactions/unmatched',
          params: expect.objectContaining({ search: 'nguyen van a' }),
        }),
      ),
    );
  });

  it('sends the chosen status as a queue filter', async () => {
    apiRequest.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/?status=UNMATCHED']}>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          url: '/api/v1/bank-transactions/unmatched',
          params: expect.objectContaining({ status: 'UNMATCHED' }),
        }),
      ),
    );
  });

  it('labels UNMATCHED rows so a reviewer can tell them from pending-review ones', async () => {
    apiRequest.mockResolvedValue({
      items: [
        {
          transaction: {
            id: 'tx-unmatched',
            providerTransactionId: 'TX-U',
            amount: 10_000,
            transactionDateTime: '2026-08-01',
            counterpartyAccountNumber: '001',
            counterpartyName: 'A',
            transferContent: 'chuyen tien',
            status: 'UNMATCHED',
            version: 1,
          },
          topCandidate: null,
        },
        {
          transaction: {
            id: 'tx-pending',
            providerTransactionId: 'TX-P',
            amount: 20_000,
            transactionDateTime: '2026-08-02',
            counterpartyAccountNumber: '002',
            counterpartyName: 'B',
            transferContent: 'thanh toan',
            status: 'PENDING_REVIEW',
            version: 1,
          },
          topCandidate: null,
        },
      ],
      total: 2,
      page: 1,
      limit: 20,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const badge = await screen.findByText('Chưa khớp');
    expect(badge.closest('tr')).toHaveTextContent('chuyen tien');
    expect(
      screen
        .getAllByText('chuyen tien')
        .every((cell) =>
          cell.closest('tr')?.textContent?.includes('Chưa khớp'),
        ),
    ).toBe(true);
    expect(
      screen.getByText('thanh toan').closest('tr')?.textContent,
    ).not.toContain('Chưa khớp');
  });

  it('renders a checkbox per row and shows the bulk action bar once a row is selected', async () => {
    apiRequest.mockResolvedValue({
      items: [
        {
          transaction: {
            id: 'tx-1',
            providerTransactionId: 'TX-1',
            amount: 10_000,
            transactionDateTime: '2026-08-01',
            counterpartyAccountNumber: '001',
            counterpartyName: 'A',
            transferContent: 'note',
            status: 'PENDING_REVIEW',
            version: 1,
          },
          topCandidate: null,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const rowCheckbox = (await screen.findAllByRole('checkbox'))[1];
    fireEvent.click(rowCheckbox);

    expect(await screen.findByText('Đã chọn 1')).toBeInTheDocument();
  });

  it('stacks transactions into cards below desktop width and paginates inside the list card', async () => {
    apiRequest.mockResolvedValue({
      items: [
        {
          transaction: {
            id: 'tx-1',
            providerTransactionId: 'TX-1',
            amount: 10_000,
            transactionDateTime: '2026-08-01',
            counterpartyAccountNumber: '001',
            counterpartyName: 'Công ty A',
            transferContent: 'note',
            status: 'PENDING_REVIEW',
            version: 1,
          },
          topCandidate: null,
        },
      ],
      total: 45,
      page: 1,
      limit: 20,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const [headerRow, row] = await screen.findAllByRole('row');
    expect(headerRow.parentElement).toHaveClass('max-lg:hidden');
    expect(row).toHaveClass('max-lg:grid');
    expect(screen.getByRole('columnheader', { name: 'Ngày giờ' })).toHaveClass(
      'w-[10rem]',
    );
    const avatar = screen.getByText('CT').closest('.rounded-full');
    expect(avatar?.parentElement).toHaveClass('hidden', 'lg:block');
    expect(avatar).toHaveClass('flex', 'items-center', 'justify-center');
    // Pagination used to float below the card on this page only.
    expect(
      screen
        .getByText('Trang 1 / 3 · 45 giao dịch')
        .closest('[data-slot="card"]'),
    ).not.toBeNull();
  });

  it('keeps the current page and pagination on screen while the next page loads', async () => {
    apiRequest.mockReset();
    apiRequest
      .mockResolvedValueOnce({
        items: [
          {
            transaction: {
              id: 'tx-1',
              providerTransactionId: 'TX-1',
              amount: 10_000,
              transactionDateTime: '2026-08-01',
              counterpartyAccountNumber: '001',
              counterpartyName: 'Công ty A',
              transferContent: 'note',
              status: 'PENDING_REVIEW',
              version: 1,
            },
            topCandidate: null,
          },
        ],
        total: 45,
        page: 1,
        limit: 20,
      })
      .mockReturnValueOnce(new Promise(() => {}));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Sau' }));

    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));
    expect(
      screen.getAllByText('Công ty A')[0].closest('[aria-busy]'),
    ).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Sau' })).toBeInTheDocument();
    expect(screen.getByText('Trang 2 / 3 · 45 giao dịch')).toBeInTheDocument();
    expect(
      screen.getAllByText('Công ty A')[0].closest('[aria-busy]'),
    ).toHaveAttribute('inert');
  });

  it('drops the bulk selection while the next page loads', async () => {
    apiRequest.mockReset();
    apiRequest
      .mockResolvedValueOnce({
        items: [
          {
            transaction: {
              id: 'tx-1',
              providerTransactionId: 'TX-1',
              amount: 10_000,
              transactionDateTime: '2026-08-01',
              counterpartyAccountNumber: '001',
              counterpartyName: 'Công ty A',
              transferContent: 'note',
              status: 'PENDING_REVIEW',
              version: 1,
            },
            topCandidate: null,
          },
        ],
        total: 45,
        page: 1,
        limit: 20,
      })
      .mockReturnValueOnce(new Promise(() => {}));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click((await screen.findAllByRole('checkbox'))[1]);
    expect(await screen.findByText('Đã chọn 1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sau' }));

    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));
    // Skip / prepaid / match must not act on the previous page's rows.
    await waitFor(() =>
      expect(screen.queryByText('Đã chọn 1')).not.toBeInTheDocument(),
    );
  });

  it('does not flash the "nothing to review" state while an empty search is cleared', async () => {
    apiRequest.mockReset();
    apiRequest
      .mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20 })
      .mockReturnValueOnce(new Promise(() => {}));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/exceptions?search=zzz']}>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText('Không tìm thấy giao dịch phù hợp.'),
    ).toBeInTheDocument();

    fireEvent.change(
      screen.getByPlaceholderText('Tìm tên, số tài khoản, nội dung…'),
      { target: { value: '' } },
    );

    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByText('Không có giao dịch cần xử lý.'),
    ).not.toBeInTheDocument();
  });

  it('shows the transfer content column with a fallback when it is blank', async () => {
    apiRequest.mockResolvedValue({
      items: [
        {
          transaction: {
            id: 'tx-1',
            providerTransactionId: 'TX-1',
            amount: 10_000,
            transactionDateTime: '2026-08-01',
            counterpartyAccountNumber: '001',
            counterpartyName: 'A',
            transferContent: 'Thanh toan hoa don INV-001',
            status: 'PENDING_REVIEW',
            version: 1,
          },
          topCandidate: null,
        },
        {
          transaction: {
            id: 'tx-2',
            providerTransactionId: 'TX-2',
            amount: 20_000,
            transactionDateTime: '2026-08-02',
            counterpartyAccountNumber: '002',
            counterpartyName: 'B',
            transferContent: '   ',
            status: 'PENDING_REVIEW',
            version: 1,
          },
          topCandidate: null,
        },
      ],
      total: 2,
      page: 1,
      limit: 20,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole('columnheader', {
        name: 'Nội dung chuyển khoản',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Thanh toan hoa don INV-001')).toBeInTheDocument();
    expect(screen.getByText('Không có nội dung')).toBeInTheDocument();
  });

  it('clamps long transfer content to 2 lines but keeps the full text reachable', async () => {
    const longContent =
      'Thanh toan hoa don INV-001 cho don hang thang 8 nam 2026, vui long lien he ke toan neu co sai sot ve so tien hoac noi dung giao dich';
    apiRequest.mockResolvedValue({
      items: [
        {
          transaction: {
            id: 'tx-1',
            providerTransactionId: 'TX-1',
            amount: 10_000,
            transactionDateTime: '2026-08-01',
            counterpartyAccountNumber: '001',
            counterpartyName: 'A',
            transferContent: longContent,
            status: 'PENDING_REVIEW',
            version: 1,
          },
          topCandidate: null,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const contentEl = await screen.findByText(longContent);
    expect(contentEl).toHaveClass('line-clamp-2');
    await expect(hoverTooltip(contentEl)).resolves.toBe(longContent);
  });

  it('keeps a 200-character payer name from wrapping one word per line', async () => {
    const longName =
      'Công ty Trách nhiệm Hữu hạn Một Thành viên Thương mại Dịch vụ Sản xuất Xuất Nhập Khẩu Tổng hợp Vật liệu Xây dựng và Nội thất Việt Nam Số 30 — Chi nhánh Vùng Miền Trời Nước Sài Gòn Miền Bắc Miền Trung';
    apiRequest.mockResolvedValue({
      items: [
        {
          transaction: {
            id: 'tx-long',
            providerTransactionId: 'TX-LONG',
            amount: 987_654_321_000,
            transactionDateTime: '2026-08-01',
            counterpartyAccountNumber: '001',
            counterpartyName: longName,
            transferContent: 'Thanh toan',
            status: 'PENDING_REVIEW',
            version: 1,
          },
          topCandidate: null,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // `break-words` inside a narrow column pushed this to ~20 lines and a
    // ~397px row; the payer name must stay on one clipped line.
    const nameEl = await screen.findByText(longName);
    expect(nameEl).toHaveClass('truncate');
    await expect(hoverTooltip(nameEl)).resolves.toBe(longName);
  });

  it('shows a current AI recommendation as a qualitative advisory badge', async () => {
    apiRequest.mockResolvedValue({
      items: [
        {
          transaction: {
            id: 'tx-1',
            providerTransactionId: 'TX-1',
            amount: 10_000,
            transactionDateTime: '2026-08-01',
            counterpartyAccountNumber: '001',
            counterpartyName: 'A',
            transferContent: 'note',
            status: 'PENDING_REVIEW',
            version: 1,
          },
          topCandidate: null,
          aiRecommendation: {
            status: 'SUCCEEDED',
            recommendedReceivableId: 'rec-1',
            confidence: 85,
            reason: 'Tên người chuyển và số tiền phù hợp.',
            isCurrent: true,
          },
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Gợi ý AI · Cao')).toBeInTheDocument();
  });

  it('does not open the split dialog when a row checkbox receives keyboard input', async () => {
    apiRequest.mockResolvedValue({
      items: [
        {
          transaction: {
            id: 'tx-1',
            providerTransactionId: 'TX-1',
            amount: 10_000,
            transactionDateTime: '2026-08-01',
            counterpartyAccountNumber: '001',
            counterpartyName: 'A',
            transferContent: 'note',
            status: 'PENDING_REVIEW',
            version: 1,
          },
          topCandidate: null,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const rowCheckbox = (await screen.findAllByRole('checkbox'))[1];
    fireEvent.keyDown(rowCheckbox, { key: ' ' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('explains how to recover when loading the review queue fails', async () => {
    apiRequest.mockRejectedValue(new Error('network'));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(
        'Không thể tải danh sách giao dịch cần xử lý. Vui lòng thử lại.',
      ),
    ).toBeInTheDocument();
  });

  it.each([
    ['', 'Không có giao dịch cần xử lý.'],
    ['không khớp', 'Không tìm thấy giao dịch phù hợp.'],
  ])('shows the correct empty state for search %s', async (search, message) => {
    apiRequest.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/?search=${search}`]}>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('empty-state')).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it('shows the payer account and its linked customers, separate from the candidate', async () => {
    apiRequest.mockResolvedValue({
      items: [
        {
          transaction: {
            id: 'tx-1',
            providerTransactionId: 'TX-1',
            amount: 10_000,
            transactionDateTime: '2026-08-01',
            counterpartyAccountNumber: '0123456789',
            counterpartyName: 'NGUYEN VAN A',
            transferContent: 'note',
            status: 'PENDING_REVIEW',
            version: 1,
          },
          topCandidate: {
            id: 'c1',
            receivableId: 'r1',
            customerId: 'cust-1',
            customerName: 'Công ty A',
            totalScore: 90,
          },
          aiRecommendation: null,
          payer: {
            accountNumberMasked: '••••6789',
            name: 'NGUYEN VAN A',
            linkedCustomers: [
              { customerId: 'c1', customerName: 'Công ty A' },
              { customerId: 'c2', customerName: 'Công ty B' },
            ],
          },
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('••••6789')).toBeInTheDocument();
    expect(screen.getByText('Công ty B')).toBeInTheDocument();
    expect(screen.getByText(/người chuyển khoản/i)).toBeInTheDocument();
  });

  it('caps pathological masked account strings while keeping their final digits', async () => {
    apiRequest.mockResolvedValue({
      items: [
        {
          transaction: {
            id: 'tx-long-account',
            providerTransactionId: 'TX-LONG-ACCOUNT',
            amount: 10_000,
            transactionDateTime: '2026-08-01',
            counterpartyAccountNumber: '001',
            counterpartyName: 'Công ty A',
            transferContent: 'note',
            status: 'PENDING_REVIEW',
            version: 1,
          },
          topCandidate: null,
          payer: {
            accountNumberMasked: `${'*'.repeat(46)}3210`,
            name: 'Công ty A',
            linkedCustomers: [],
          },
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('********3210')).toBeInTheDocument();
    expect(screen.queryByText(`${'*'.repeat(46)}3210`)).not.toBeInTheDocument();
  });

  // Below lg the queue uses cards; from lg to xl the score and transfer
  // content columns are hidden because both are repeated in the review dialog.
  it('drops the two advisory columns between lg and xl so amount and action stay on screen', async () => {
    apiRequest.mockResolvedValue({
      items: [
        {
          transaction: {
            id: 'tx-1',
            providerTransactionId: 'TX-1',
            amount: 23_000_000,
            transactionDateTime: '2026-08-01',
            counterpartyAccountNumber: '001',
            counterpartyName: 'Công ty TNHH Giải pháp Kho vận Việt Trung',
            transferContent: 'Đặt cọc hợp đồng',
            status: 'PENDING_REVIEW',
            version: 1,
          },
          topCandidate: null,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('23.000.000 ₫');

    const headers = screen.getAllByRole('columnheader');
    const payerHeader = headers.find(
      (th) => th.textContent === 'Người chuyển khoản',
    );
    const contentHeader = headers.find(
      (th) => th.textContent === 'Nội dung chuyển khoản',
    );
    const scoreHeader = headers.find(
      (th) => th.textContent === 'Điểm cao nhất',
    );

    // The payer column is the one that must survive to stay scannable.
    expect(payerHeader?.className).toContain('min-w-0');
    expect(payerHeader?.className).not.toContain('max-lg:hidden');

    // The two advisory columns are the ones that go.
    expect(contentHeader?.className).toContain('lg:max-xl:hidden');
    expect(scoreHeader?.className).toContain('lg:max-xl:hidden');

    const cells = screen
      .getAllByRole('row')
      .slice(1)
      .flatMap((row) => [...row.querySelectorAll('td')]);
    const payerCell = cells.find((td) => td.textContent?.includes('Giải pháp'));
    const contentCell = cells.find((td) => td.textContent?.includes('Đặt cọc'));
    expect(payerCell?.className).toContain('min-w-0');
    expect(payerCell?.className).not.toContain('max-lg:hidden');
    expect(contentCell?.className).toContain('lg:max-xl:hidden');

    // Amount and action are never hidden at any width.
    const amountCell = cells.find((td) =>
      td.textContent?.includes('23.000.000'),
    );
    const actionHeader = headers.find(
      (th) => th.textContent?.trim() === 'Hành động',
    );
    expect(amountCell?.className).not.toContain('hidden');
    // Action is never one of the columns dropped between lg and xl; it only
    // hides below lg, where the row is a card and the action sits beside
    // the amount instead of under a header.
    expect(actionHeader?.className).not.toContain('md:max-lg:hidden');
  });

  it('labels the action column so the trailing "Xử lý" links have a header', async () => {
    apiRequest.mockResolvedValue({
      items: [
        {
          transaction: {
            id: 'tx-1',
            providerTransactionId: 'TX-1',
            amount: 23_000_000,
            transactionDateTime: '2026-08-01',
            counterpartyAccountNumber: '001',
            counterpartyName: 'Công ty TNHH Giải pháp Kho vận Việt Trung',
            transferContent: 'Đặt cọc hợp đồng',
            status: 'PENDING_REVIEW',
            version: 1,
          },
          topCandidate: null,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('23.000.000 ₫');

    // The column used to render only an `sr-only` "Thao tác", so a screen
    // full of trailing "Xử lý" links had no visible header above them. A
    // visible label costs ~80px and only matters once the row is a table
    // again, so it stays hidden on the phone card layout.
    const actionHeader = screen.getByRole('columnheader', {
      name: 'Hành động',
    });
    expect(actionHeader).toHaveClass('max-lg:hidden');
    expect(actionHeader).not.toHaveClass('sr-only');

    // The header must not claim more width than the single word it labels.
    expect(actionHeader).toHaveClass('w-[6.5rem]', 'text-right');
  });

  // `max-lg:h-auto max-lg:px-0` was meant to tighten the action into the
  // card layout, but it also stripped its vertical padding: measured at
  // 390px the button rendered 29x16px, far under the 44px touch target and
  // under the 24px minimum even. The link tone is fine; the hit area is not.
  it('keeps the mobile action button tappable instead of collapsing to 16px', async () => {
    apiRequest.mockResolvedValue({
      items: [
        {
          transaction: {
            id: 'tx-1',
            providerTransactionId: 'TX-1',
            amount: 23_000_000,
            transactionDateTime: '2026-08-01',
            counterpartyAccountNumber: '001',
            counterpartyName: 'Công ty TNHH Giải pháp Kho vận Việt Trung',
            transferContent: 'Đặt cọc hợp đồng',
            status: 'PENDING_REVIEW',
            version: 1,
          },
          topCandidate: null,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExceptionsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const action = await screen.findByRole('button', { name: 'Xử lý' });

    // It stays a link-toned button in the card, but the hit area is padded
    // back out instead of collapsing to the glyph's own line box.
    expect(action.className).not.toContain('max-lg:h-auto');
    expect(action.className).toContain('max-lg:min-h-9');
    expect(action.className).toContain('max-lg:px-2');
  });
});
