import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';
import { AuditContextService } from '../../../common/audit/audit-context';
import { AppError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-code';
import { TenantContextService } from '../../../common/tenancy/tenant-context';
import {
  CUSTOMER_REPOSITORY,
  type ICustomerRepository,
} from '../../customers/application/customer-repository.port';
import { LedgerEventRecorderService } from '../../ledger/application/ledger-event-recorder.service';
import { LedgerEventKind } from '../../ledger/domain/ledger-event-kind';
import { LedgerEventSubjectType } from '../../ledger/domain/ledger-event-subject-type';
import {
  type IPaymentRepository,
  PAYMENT_REPOSITORY,
} from '../../payments/application/payment-repository.port';
import { Payment } from '../../payments/domain/payment';
import {
  BANK_TRANSACTION_REPOSITORY,
  type IBankTransactionRepository,
} from '../../webhooks/application/bank-transaction-repository.port';
import {
  BankTransaction,
  isActionableStatus,
} from '../../webhooks/domain/bank-transaction';

export interface MarkPrepaidBankTransactionInput {
  bankTransactionId: string;
  customerId: string;
}

export interface MarkPrepaidBankTransactionResult {
  transaction: BankTransaction;
  payment: Payment;
}

@Injectable()
export class MarkPrepaidBankTransactionUseCase {
  constructor(
    @Inject(BANK_TRANSACTION_REPOSITORY)
    private readonly bankTransactionRepo: IBankTransactionRepository,
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepo: IPaymentRepository,
    @Inject(CUSTOMER_REPOSITORY)
    private readonly customerRepo: ICustomerRepository,
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly auditContext: AuditContextService,
    private readonly ledgerRecorder: LedgerEventRecorderService,
  ) {}

  async execute(
    input: MarkPrepaidBankTransactionInput,
  ): Promise<MarkPrepaidBankTransactionResult> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const transaction = await this.bankTransactionRepo.findByIdForUpdate(
        input.bankTransactionId,
        manager,
      );
      if (!transaction) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          'Không tìm thấy giao dịch ngân hàng.',
        );
      }
      if (!isActionableStatus(transaction.status)) {
        throw new AppError(ErrorCode.CONFLICT, 'Giao dịch đã được xử lý.');
      }

      const customer = await this.customerRepo.findById(input.customerId);
      if (!customer) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          'Không tìm thấy khách hàng trong tổ chức hiện tại.',
        );
      }

      this.auditContext.setBefore(transaction);
      const prepaid = transaction.markPrepaid();
      const payment = new Payment({
        id: randomUUID(),
        organizationId: this.tenantContext.getOrganizationId(),
        customerId: customer.id,
        bankTransactionId: transaction.id,
        totalAmount: transaction.amount,
        allocatedAmount: 0,
        payerName: transaction.counterpartyName,
        receivedAt: transaction.transactionDateTime,
        createdAt: new Date(),
      });
      await this.paymentRepo.save(payment, manager);
      await this.ledgerRecorder.record({
        organizationId: payment.organizationId,
        subjectType: LedgerEventSubjectType.PAYMENT,
        subjectId: payment.id,
        kind: LedgerEventKind.PAYMENT_RECEIVED,
        amount: payment.totalAmount,
        manager,
      });
      await this.bankTransactionRepo.save(prepaid, manager);
      return { transaction: prepaid, payment };
    });
  }
}
