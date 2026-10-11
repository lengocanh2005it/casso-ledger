import { ReceivableStatus } from '@casso-ar/shared-types';
import type { EntityManager } from 'typeorm';
import { AppError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-code';
import { BalanceHistoryActorType } from '../../receivable-balance-history/domain/balance-history-actor-type';
import { Receivable } from '../../receivables/domain/receivable';
import { createAiMatchingRecommendation } from '../../webhooks/domain/ai-matching-recommendation';
import { BankTransaction } from '../../webhooks/domain/bank-transaction';
import { MatchBankTransactionUseCase } from './match-bank-transaction.usecase';

function buildTransaction(
  overrides: Partial<
    Pick<BankTransaction, 'version' | 'status' | 'amount' | 'aiRecommendation'>
  > = {},
): BankTransaction {
  return new BankTransaction({
    id: 'bt-1',
    organizationId: 'org-1',
    bankConnectionId: 'conn-1',
    webhookInboxId: 'wh-1',
    providerTransactionId: 'TX-001',
    amount: overrides.amount ?? 30_000_000,
    transactionDateTime: new Date('2026-08-01'),
    counterpartyAccountNumber: '0011002233',
    counterpartyName: 'CONG TY B',
    transferContent: 'payment',
    status: overrides.status ?? 'PENDING_REVIEW',
    version: overrides.version ?? 1,
    createdAt: new Date('2026-08-01'),
    aiRecommendation: overrides.aiRecommendation ?? null,
  });
}

function buildReceivable(id: string, customerId = 'cust-1'): Receivable {
  return new Receivable({
    id,
    organizationId: 'org-1',
    customerId,
    invoiceId: null,
    originalAmount: 30_000_000,
    paidAmount: 0,
    dueDate: new Date('2026-08-20'),
    status: ReceivableStatus.OPEN,
    salesRepresentativeId: null,
    createdAt: new Date('2026-07-20'),
    closedAt: null,
    version: 1,
  });
}

function buildUseCase(
  options: {
    transaction?: BankTransaction | null;
    receivables?: Record<string, Receivable | null>;
  } = {},
) {
  const bankTransactionRepo = {
    findByIdForUpdate: jest
      .fn()
      .mockResolvedValue(options.transaction ?? buildTransaction()),
    save: jest.fn(),
  };
  const receivableRepo = {
    findByIdForUpdate: jest.fn((id: string) =>
      Promise.resolve(options.receivables?.[id.toLowerCase()] ?? null),
    ),
  };
  const paymentRepo = { save: jest.fn() };
  const allocatePaymentUseCase = {
    allocateWithinTransaction: jest
      .fn()
      .mockResolvedValue({ customerId: 'cust-1', becameClosed: false }),
    emitAllocationEvents: jest.fn(),
  };
  const manager = {} as EntityManager;
  const dataSource = {
    transaction: jest.fn(
      async (callback: (value: EntityManager) => Promise<unknown>) => {
        const result = await callback(manager);
        expect(
          allocatePaymentUseCase.emitAllocationEvents,
        ).not.toHaveBeenCalled();
        return result;
      },
    ),
  };
  const tenantContext = { getOrganizationId: () => 'org-1' };
  const auditContext = {
    setBefore: jest.fn(),
    setAfter: jest.fn(),
    setAfterStatePatch: jest.fn(),
  };

  const useCase = new MatchBankTransactionUseCase(
    bankTransactionRepo as never,
    receivableRepo as never,
    paymentRepo as never,
    allocatePaymentUseCase as never,
    dataSource as never,
    tenantContext as never,
    auditContext as never,
    { record: jest.fn() } as never,
  );
  return {
    useCase,
    bankTransactionRepo,
    receivableRepo,
    paymentRepo,
    allocatePaymentUseCase,
    auditContext,
  };
}

const input = {
  bankTransactionId: 'bt-1',
  allocations: [{ receivableId: 'rec-1', amount: 30_000_000 }],
  version: 1,
  allocatedByUserId: 'user-1',
};

describe('MatchBankTransactionUseCase', () => {
  it('rejects a stale version with OPTIMISTIC_LOCK_CONFLICT', async () => {
    const { useCase } = buildUseCase({
      transaction: buildTransaction({ version: 2 }),
    });

    await expect(useCase.execute(input)).rejects.toMatchObject({
      errorCode: ErrorCode.OPTIMISTIC_LOCK_CONFLICT,
    });
  });

  it('rejects a transaction that is no longer pending review', async () => {
    const { useCase } = buildUseCase({
      transaction: buildTransaction({ status: 'MATCHED' }),
    });

    await expect(useCase.execute(input)).rejects.toBeInstanceOf(AppError);
  });

  it('matches an UNMATCHED transaction the same way as a pending-review one', async () => {
    const {
      useCase,
      bankTransactionRepo,
      paymentRepo,
      allocatePaymentUseCase,
    } = buildUseCase({
      transaction: buildTransaction({ status: 'UNMATCHED' }),
      receivables: { 'rec-1': buildReceivable('rec-1') },
    });

    const result = await useCase.execute(input);

    expect(paymentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ totalAmount: 30_000_000 }),
      expect.anything(),
    );
    expect(
      allocatePaymentUseCase.allocateWithinTransaction,
    ).toHaveBeenCalledTimes(1);
    expect(bankTransactionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'MATCHED' }),
      expect.anything(),
    );
    expect(result.status).toBe('MATCHED');
  });

  it('rejects an UNMATCHED transaction whose version no longer matches', async () => {
    const { useCase } = buildUseCase({
      transaction: buildTransaction({ status: 'UNMATCHED', version: 2 }),
    });

    await expect(useCase.execute(input)).rejects.toMatchObject({
      errorCode: ErrorCode.OPTIMISTIC_LOCK_CONFLICT,
    });
  });

  it('rejects allocations whose sum exceeds the transaction amount', async () => {
    const { useCase } = buildUseCase({
      transaction: buildTransaction({ amount: 20_000_000 }),
      receivables: { 'rec-1': buildReceivable('rec-1') },
    });

    await expect(
      useCase.execute({
        ...input,
        allocations: [{ receivableId: 'rec-1', amount: 25_000_000 }],
      }),
    ).rejects.toMatchObject({ errorCode: ErrorCode.VALIDATION_ERROR });
  });

  it('rejects an allocation whose receivable does not exist', async () => {
    const { useCase } = buildUseCase();

    await expect(useCase.execute(input)).rejects.toMatchObject({
      errorCode: ErrorCode.RECEIVABLE_NOT_FOUND,
    });
  });

  it('creates one payment, allocates each item, and marks the transaction matched', async () => {
    const {
      useCase,
      bankTransactionRepo,
      paymentRepo,
      allocatePaymentUseCase,
      auditContext,
    } = buildUseCase({
      receivables: {
        'rec-1': buildReceivable('rec-1'),
        'rec-2': buildReceivable('rec-2'),
      },
    });

    const result = await useCase.execute({
      ...input,
      allocations: [
        { receivableId: 'rec-1', amount: 15_000_000 },
        { receivableId: 'rec-2', amount: 10_000_000 },
      ],
    });

    expect(paymentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cust-1',
        totalAmount: 30_000_000,
        allocatedAmount: 0,
      }),
      expect.anything(),
    );
    expect(
      allocatePaymentUseCase.allocateWithinTransaction,
    ).toHaveBeenCalledTimes(2);
    expect(
      allocatePaymentUseCase.allocateWithinTransaction,
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        receivableId: 'rec-1',
        amount: 15_000_000,
        allocatedByUserId: 'user-1',
        provenance: {
          actorType: BalanceHistoryActorType.USER,
          actorUserId: 'user-1',
        },
      }),
    );
    expect(bankTransactionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'MATCHED' }),
      expect.anything(),
    );
    expect(auditContext.setBefore).toHaveBeenCalled();
    expect(auditContext.setAfterStatePatch).toHaveBeenCalledWith({
      allocatedReceivableIds: ['rec-1', 'rec-2'],
      aiAccepted: false,
    });
    expect(result.status).toBe('MATCHED');
    expect(allocatePaymentUseCase.emitAllocationEvents).toHaveBeenCalledTimes(
      2,
    );
    expect(allocatePaymentUseCase.emitAllocationEvents).toHaveBeenNthCalledWith(
      1,
      {
        paymentId: expect.any(String),
        receivableId: 'rec-1',
        amount: 15_000_000,
        allocatedByUserId: 'user-1',
        organizationId: 'org-1',
        customerId: 'cust-1',
        becameClosed: false,
      },
    );
    expect(allocatePaymentUseCase.emitAllocationEvents).toHaveBeenNthCalledWith(
      2,
      {
        paymentId: expect.any(String),
        receivableId: 'rec-2',
        amount: 10_000_000,
        allocatedByUserId: 'user-1',
        organizationId: 'org-1',
        customerId: 'cust-1',
        becameClosed: false,
      },
    );
  });

  it('locks receivables by ID while applying allocations in request order', async () => {
    const { useCase, receivableRepo, allocatePaymentUseCase } = buildUseCase({
      receivables: {
        'rec-1': buildReceivable('rec-1'),
        'rec-2': buildReceivable('rec-2'),
      },
    });

    await useCase.execute({
      ...input,
      allocations: [
        { receivableId: 'rec-2', amount: 5_000_000 },
        { receivableId: 'rec-1', amount: 5_000_000 },
      ],
    });

    expect(
      receivableRepo.findByIdForUpdate.mock.calls.map(([receivableId]) =>
        String(receivableId),
      ),
    ).toEqual(['rec-1', 'rec-2']);
    expect(
      allocatePaymentUseCase.allocateWithinTransaction.mock.calls.map(
        ([, allocation]) => allocation.receivableId,
      ),
    ).toEqual(['rec-2', 'rec-1']);
  });

  it('locks equivalent UUIDs in the same order regardless of casing', async () => {
    const receivableIdA = 'a0000000-0000-4000-8000-000000000001';
    const receivableIdB = 'b0000000-0000-4000-8000-000000000002';
    const { useCase, receivableRepo, allocatePaymentUseCase } = buildUseCase({
      receivables: {
        [receivableIdA]: buildReceivable(receivableIdA),
        [receivableIdB]: buildReceivable(receivableIdB),
      },
    });

    const lockOrders: string[][] = [];
    for (const allocations of [
      [
        { receivableId: receivableIdA.toUpperCase(), amount: 5_000_000 },
        { receivableId: receivableIdB, amount: 5_000_000 },
      ],
      [
        { receivableId: receivableIdB.toUpperCase(), amount: 5_000_000 },
        { receivableId: receivableIdA, amount: 5_000_000 },
      ],
    ]) {
      await useCase.execute({ ...input, allocations });
      lockOrders.push(
        receivableRepo.findByIdForUpdate.mock.calls.map(([id]) => String(id)),
      );
      receivableRepo.findByIdForUpdate.mockClear();
      allocatePaymentUseCase.emitAllocationEvents.mockClear();
    }

    expect(lockOrders).toEqual([
      [receivableIdA, receivableIdB],
      [receivableIdA, receivableIdB],
    ]);
  });

  it('rejects receivables belonging to different customers', async () => {
    const { useCase } = buildUseCase({
      receivables: {
        'rec-1': buildReceivable('rec-1', 'cust-1'),
        'rec-2': buildReceivable('rec-2', 'cust-2'),
      },
    });

    await expect(
      useCase.execute({
        ...input,
        allocations: [
          { receivableId: 'rec-1', amount: 10_000_000 },
          { receivableId: 'rec-2', amount: 10_000_000 },
        ],
      }),
    ).rejects.toMatchObject({ errorCode: ErrorCode.CUSTOMER_MISMATCH });
  });

  it('records aiAccepted when the reviewer allocates the recommended receivable', async () => {
    const recommendation = createAiMatchingRecommendation({
      status: 'SUCCEEDED',
      recommendedReceivableId: 'rec-1',
      confidence: 80,
      reason: 'Khớp.',
      model: 'gpt-4o-mini',
      promptVersion: 'matching-v1',
      evaluatedAt: '2026-08-01T00:00:00.000Z',
    });
    const { useCase, auditContext } = buildUseCase({
      transaction: buildTransaction({ aiRecommendation: recommendation }),
      receivables: { 'rec-1': buildReceivable('rec-1') },
    });

    await useCase.execute(input);

    expect(auditContext.setAfterStatePatch).toHaveBeenCalledWith({
      allocatedReceivableIds: ['rec-1'],
      aiAccepted: true,
    });
  });
});
