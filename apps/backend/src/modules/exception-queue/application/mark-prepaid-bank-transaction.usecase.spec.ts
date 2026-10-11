import type { EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/errors/error-code';
import { BankTransaction } from '../../webhooks/domain/bank-transaction';
import { MarkPrepaidBankTransactionUseCase } from './mark-prepaid-bank-transaction.usecase';

function buildTransaction(
  status: BankTransaction['status'] = 'PENDING_REVIEW',
) {
  return new BankTransaction({
    id: 'bt-1',
    organizationId: 'org-1',
    bankConnectionId: 'conn-1',
    webhookInboxId: 'wh-1',
    providerTransactionId: 'TX-001',
    amount: 8_000_000,
    transactionDateTime: new Date('2026-08-01'),
    counterpartyAccountNumber: '0011002233',
    counterpartyName: 'CONG TY C',
    transferContent: 'advance payment',
    status,
    version: 1,
    createdAt: new Date('2026-08-01'),
  });
}

function buildUseCase(
  transaction: BankTransaction | null = buildTransaction(),
) {
  const bankTransactionRepo = {
    findByIdForUpdate: jest.fn().mockResolvedValue(transaction),
    save: jest.fn(),
  };
  const paymentRepo = { save: jest.fn() };
  const customerRepo = {
    findById: jest.fn().mockResolvedValue({ id: 'cust-1' }),
  };
  const dataSource = {
    transaction: jest.fn(
      (callback: (value: EntityManager) => Promise<unknown>) =>
        callback({} as EntityManager),
    ),
  };
  const auditContext = { setBefore: jest.fn(), setAfter: jest.fn() };
  const useCase = new MarkPrepaidBankTransactionUseCase(
    bankTransactionRepo as never,
    paymentRepo as never,
    customerRepo as never,
    dataSource as never,
    { getOrganizationId: () => 'org-1' } as never,
    auditContext as never,
    { record: jest.fn() } as never,
  );
  return {
    useCase,
    bankTransactionRepo,
    paymentRepo,
    customerRepo,
    auditContext,
  };
}

describe('MarkPrepaidBankTransactionUseCase', () => {
  it('creates an unallocated customer payment and marks the transaction prepaid', async () => {
    const { useCase, paymentRepo, bankTransactionRepo, auditContext } =
      buildUseCase();

    const result = await useCase.execute({
      bankTransactionId: 'bt-1',
      customerId: 'cust-1',
    });

    expect(paymentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cust-1',
        allocatedAmount: 0,
        totalAmount: 8_000_000,
      }),
      expect.anything(),
    );
    expect(bankTransactionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PREPAID' }),
      expect.anything(),
    );
    expect(auditContext.setBefore).toHaveBeenCalled();
    expect(result.transaction.status).toBe('PREPAID');
  });

  it('rejects a transaction already processed', async () => {
    const { useCase } = buildUseCase(buildTransaction('MATCHED'));

    await expect(
      useCase.execute({ bankTransactionId: 'bt-1', customerId: 'cust-1' }),
    ).rejects.toMatchObject({ errorCode: ErrorCode.CONFLICT });
  });

  it('marks an UNMATCHED transaction prepaid', async () => {
    const { useCase, paymentRepo } = buildUseCase(
      buildTransaction('UNMATCHED'),
    );

    const result = await useCase.execute({
      bankTransactionId: 'bt-1',
      customerId: 'cust-1',
    });

    expect(paymentRepo.save).toHaveBeenCalled();
    expect(result.transaction.status).toBe('PREPAID');
  });

  it('rejects a customer outside the current tenant', async () => {
    const { useCase, customerRepo } = buildUseCase();
    customerRepo.findById.mockResolvedValue(null);

    await expect(
      useCase.execute({ bankTransactionId: 'bt-1', customerId: 'cust-2' }),
    ).rejects.toMatchObject({ errorCode: ErrorCode.NOT_FOUND });
  });

  it('returns NOT_FOUND when the bank transaction does not exist', async () => {
    const { useCase } = buildUseCase(null);

    await expect(
      useCase.execute({ bankTransactionId: 'missing', customerId: 'cust-1' }),
    ).rejects.toMatchObject({ errorCode: ErrorCode.NOT_FOUND });
  });
});
