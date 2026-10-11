import type { EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/errors/error-code';
import { BankTransaction } from '../../webhooks/domain/bank-transaction';
import { SkipBankTransactionUseCase } from './skip-bank-transaction.usecase';

function buildTransaction(
  status: BankTransaction['status'] = 'PENDING_REVIEW',
) {
  return new BankTransaction({
    id: 'bt-1',
    organizationId: 'org-1',
    bankConnectionId: 'conn-1',
    webhookInboxId: 'wh-1',
    providerTransactionId: 'TX-001',
    amount: 5_000_000,
    transactionDateTime: new Date('2026-08-01'),
    counterpartyAccountNumber: '0011002233',
    counterpartyName: 'NGUYEN VAN A',
    transferContent: 'unknown',
    status,
    version: 1,
    createdAt: new Date('2026-08-01'),
  });
}

describe('SkipBankTransactionUseCase', () => {
  it('marks a pending review transaction ignored inside a transaction', async () => {
    const transaction = buildTransaction();
    const bankTransactionRepo = {
      findByIdForUpdate: jest.fn().mockResolvedValue(transaction),
      save: jest.fn(),
    };
    const auditContext = { setBefore: jest.fn(), setAfter: jest.fn() };
    const manager = {} as EntityManager;
    const dataSource = {
      transaction: jest.fn(
        (callback: (value: EntityManager) => Promise<unknown>) =>
          callback(manager),
      ),
    };
    const useCase = new SkipBankTransactionUseCase(
      bankTransactionRepo as never,
      dataSource as never,
      auditContext as never,
    );

    await expect(useCase.execute('bt-1')).resolves.toMatchObject({
      status: 'IGNORED',
    });
    expect(bankTransactionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'IGNORED' }),
      manager,
    );
    expect(auditContext.setBefore).toHaveBeenCalledWith(transaction);
    expect(auditContext.setAfter).not.toHaveBeenCalled();
  });

  it('returns an already ignored transaction without writing it again', async () => {
    const transaction = buildTransaction('IGNORED');
    const bankTransactionRepo = {
      findByIdForUpdate: jest.fn().mockResolvedValue(transaction),
      save: jest.fn(),
    };
    const dataSource = {
      transaction: jest.fn(
        (callback: (value: EntityManager) => Promise<unknown>) =>
          callback({} as EntityManager),
      ),
    };
    const useCase = new SkipBankTransactionUseCase(
      bankTransactionRepo as never,
      dataSource as never,
      { setBefore: jest.fn(), setAfter: jest.fn() } as never,
    );

    await expect(useCase.execute('bt-1')).resolves.toBe(transaction);
    expect(bankTransactionRepo.save).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when the transaction does not exist', async () => {
    const bankTransactionRepo = {
      findByIdForUpdate: jest.fn().mockResolvedValue(null),
      save: jest.fn(),
    };
    const dataSource = {
      transaction: jest.fn(
        (callback: (value: EntityManager) => Promise<unknown>) =>
          callback({} as EntityManager),
      ),
    };
    const useCase = new SkipBankTransactionUseCase(
      bankTransactionRepo as never,
      dataSource as never,
      { setBefore: jest.fn(), setAfter: jest.fn() } as never,
    );

    await expect(useCase.execute('missing')).rejects.toMatchObject({
      errorCode: ErrorCode.NOT_FOUND,
    });
  });

  it('skips an UNMATCHED transaction', async () => {
    const bankTransactionRepo = {
      findByIdForUpdate: jest
        .fn()
        .mockResolvedValue(buildTransaction('UNMATCHED')),
      save: jest.fn(),
    };
    const dataSource = {
      transaction: jest.fn(
        (callback: (value: EntityManager) => Promise<unknown>) =>
          callback({} as EntityManager),
      ),
    };
    const useCase = new SkipBankTransactionUseCase(
      bankTransactionRepo as never,
      dataSource as never,
      { setBefore: jest.fn(), setAfter: jest.fn() } as never,
    );

    await expect(useCase.execute('bt-1')).resolves.toMatchObject({
      status: 'IGNORED',
    });
    expect(bankTransactionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'IGNORED' }),
      expect.anything(),
    );
  });

  it('still refuses a transaction that already reached a terminal status', async () => {
    const bankTransactionRepo = {
      findByIdForUpdate: jest
        .fn()
        .mockResolvedValue(buildTransaction('PREPAID')),
      save: jest.fn(),
    };
    const dataSource = {
      transaction: jest.fn(
        (callback: (value: EntityManager) => Promise<unknown>) =>
          callback({} as EntityManager),
      ),
    };
    const useCase = new SkipBankTransactionUseCase(
      bankTransactionRepo as never,
      dataSource as never,
      { setBefore: jest.fn(), setAfter: jest.fn() } as never,
    );

    await expect(useCase.execute('bt-1')).rejects.toMatchObject({
      errorCode: ErrorCode.CONFLICT,
    });
  });
});
