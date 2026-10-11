import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';
import { AuditContextService } from '../../../common/audit/audit-context';
import { AppError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-code';
import {
  BANK_TRANSACTION_REPOSITORY,
  type IBankTransactionRepository,
} from '../../webhooks/application/bank-transaction-repository.port';
import {
  BankTransaction,
  isActionableStatus,
} from '../../webhooks/domain/bank-transaction';

@Injectable()
export class SkipBankTransactionUseCase {
  constructor(
    @Inject(BANK_TRANSACTION_REPOSITORY)
    private readonly bankTransactionRepo: IBankTransactionRepository,
    private readonly dataSource: DataSource,
    private readonly auditContext: AuditContextService,
  ) {}

  async execute(bankTransactionId: string): Promise<BankTransaction> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const transaction = await this.bankTransactionRepo.findByIdForUpdate(
        bankTransactionId,
        manager,
      );
      if (!transaction) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          'Không tìm thấy giao dịch ngân hàng.',
        );
      }
      if (transaction.status === 'IGNORED') return transaction;
      if (!isActionableStatus(transaction.status)) {
        throw new AppError(ErrorCode.CONFLICT, 'Giao dịch đã được xử lý.');
      }

      this.auditContext.setBefore(transaction);
      const ignored = transaction.markIgnored();
      await this.bankTransactionRepo.save(ignored, manager);
      return ignored;
    });
  }
}
