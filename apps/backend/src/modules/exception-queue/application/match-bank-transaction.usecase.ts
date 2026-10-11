import { randomUUID } from 'node:crypto';
import { ReceivableStatus } from '@casso-ar/shared-types';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditContextService } from '../../../common/audit/audit-context';
import { AppError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-code';
import { TenantContextService } from '../../../common/tenancy/tenant-context';
import { LedgerEventRecorderService } from '../../ledger/application/ledger-event-recorder.service';
import { LedgerEventKind } from '../../ledger/domain/ledger-event-kind';
import { LedgerEventSubjectType } from '../../ledger/domain/ledger-event-subject-type';
import { AllocatePaymentUseCase } from '../../payments/application/allocate-payment.usecase';
import {
  type IPaymentRepository,
  PAYMENT_REPOSITORY,
} from '../../payments/application/payment-repository.port';
import { Payment } from '../../payments/domain/payment';
import { BalanceHistoryActorType } from '../../receivable-balance-history/domain/balance-history-actor-type';
import {
  type IReceivableRepository,
  RECEIVABLE_REPOSITORY,
} from '../../receivables/application/receivable-repository.port';
import type { Receivable } from '../../receivables/domain/receivable';
import {
  BANK_TRANSACTION_REPOSITORY,
  type IBankTransactionRepository,
} from '../../webhooks/application/bank-transaction-repository.port';
import {
  BankTransaction,
  isActionableStatus,
} from '../../webhooks/domain/bank-transaction';

export interface MatchAllocationItem {
  receivableId: string;
  amount: number;
}

export interface MatchBankTransactionInput {
  bankTransactionId: string;
  allocations: MatchAllocationItem[];
  version: number;
  allocatedByUserId: string;
}

@Injectable()
export class MatchBankTransactionUseCase {
  constructor(
    @Inject(BANK_TRANSACTION_REPOSITORY)
    private readonly bankTransactionRepo: IBankTransactionRepository,
    @Inject(RECEIVABLE_REPOSITORY)
    private readonly receivableRepo: IReceivableRepository,
    @Inject(PAYMENT_REPOSITORY)
    private readonly paymentRepo: IPaymentRepository,
    private readonly allocatePaymentUseCase: AllocatePaymentUseCase,
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly auditContext: AuditContextService,
    private readonly ledgerRecorder: LedgerEventRecorderService,
  ) {}

  async execute(input: MatchBankTransactionInput): Promise<BankTransaction> {
    if (input.allocations.length === 0) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'Vui lòng chọn ít nhất một khoản phải thu.',
      );
    }

    const allocationResults: Array<{
      paymentId: string;
      receivableId: string;
      amount: number;
      customerId: string;
      becameClosed: boolean;
    }> = [];

    const matchedTransaction = await this.dataSource.transaction(
      async (manager) => {
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

        this.auditContext.setBefore(transaction);
        if (
          transaction.version !== input.version ||
          !isActionableStatus(transaction.status)
        ) {
          throw new AppError(
            ErrorCode.OPTIMISTIC_LOCK_CONFLICT,
            'Giao dịch đã được xử lý bởi người dùng khác.',
          );
        }

        const totalAllocation = input.allocations.reduce(
          (total, allocation) => total + allocation.amount,
          0,
        );
        if (
          input.allocations.some(
            (allocation) =>
              !Number.isInteger(allocation.amount) || allocation.amount <= 0,
          ) ||
          totalAllocation > transaction.amount
        ) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            'Tổng số tiền phân bổ không hợp lệ.',
          );
        }

        const lockedReceivables = new Map<string, Receivable>();
        const requestedByReceivable = new Map<string, number>();
        const receivableIds = [
          ...new Set(
            input.allocations.map((allocation) =>
              allocation.receivableId.toLowerCase(),
            ),
          ),
        ].sort();
        for (const receivableId of receivableIds) {
          const receivable = await this.receivableRepo.findByIdForUpdate(
            receivableId,
            manager,
          );
          if (receivable) {
            lockedReceivables.set(receivableId, receivable);
          }
        }

        for (const allocation of input.allocations) {
          const receivableId = allocation.receivableId.toLowerCase();
          const receivable = lockedReceivables.get(receivableId);
          if (!receivable) {
            throw new AppError(
              ErrorCode.RECEIVABLE_NOT_FOUND,
              'Không tìm thấy khoản phải thu.',
              { receivableId: allocation.receivableId },
            );
          }
          if (
            receivable.status !== ReceivableStatus.OPEN &&
            receivable.status !== ReceivableStatus.PARTIALLY_PAID
          ) {
            throw new AppError(
              ErrorCode.VALIDATION_ERROR,
              'Chỉ có thể phân bổ vào khoản phải thu đang mở.',
              { receivableId: allocation.receivableId },
            );
          }
          const requestedAmount =
            (requestedByReceivable.get(receivableId) ?? 0) + allocation.amount;
          if (requestedAmount > receivable.remainingAmount) {
            throw new AppError(
              ErrorCode.ALLOCATION_EXCEEDS_REMAINING,
              'Số tiền phân bổ vượt quá số dư còn lại của khoản phải thu.',
              { receivableId: allocation.receivableId },
            );
          }
          requestedByReceivable.set(receivableId, requestedAmount);
        }

        const firstReceivable = lockedReceivables.get(
          input.allocations[0].receivableId.toLowerCase(),
        );
        if (!firstReceivable) {
          throw new AppError(
            ErrorCode.RECEIVABLE_NOT_FOUND,
            'Không tìm thấy khoản phải thu.',
          );
        }
        for (const receivable of lockedReceivables.values()) {
          if (receivable.customerId !== firstReceivable.customerId) {
            throw new AppError(
              ErrorCode.CUSTOMER_MISMATCH,
              'Các khoản phải thu phải thuộc cùng một khách hàng.',
            );
          }
        }
        const payment = new Payment({
          id: randomUUID(),
          organizationId: this.tenantContext.getOrganizationId(),
          customerId: firstReceivable.customerId,
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

        for (const allocation of input.allocations) {
          const result =
            await this.allocatePaymentUseCase.allocateWithinTransaction(
              manager,
              {
                paymentId: payment.id,
                receivableId: allocation.receivableId,
                amount: allocation.amount,
                allocatedByUserId: input.allocatedByUserId,
                provenance: {
                  actorType: BalanceHistoryActorType.USER,
                  actorUserId: input.allocatedByUserId,
                },
              },
            );
          allocationResults.push({
            paymentId: payment.id,
            receivableId: allocation.receivableId,
            amount: allocation.amount,
            customerId: result.customerId,
            becameClosed: result.becameClosed,
          });
        }

        const matched = transaction.markMatched();
        await this.bankTransactionRepo.save(matched, manager);
        return matched;
      },
    );

    const allocatedReceivableIds = [
      ...new Set(
        input.allocations
          .filter((allocation) => allocation.amount > 0)
          .map((allocation) => allocation.receivableId),
      ),
    ];
    const recommendedReceivableId =
      matchedTransaction.aiRecommendation?.status === 'SUCCEEDED'
        ? matchedTransaction.aiRecommendation.recommendedReceivableId
        : null;
    this.auditContext.setAfterStatePatch({
      allocatedReceivableIds,
      aiAccepted:
        recommendedReceivableId !== null &&
        allocatedReceivableIds.includes(recommendedReceivableId),
    });

    const organizationId = this.tenantContext.getOrganizationId();
    for (const result of allocationResults) {
      await this.allocatePaymentUseCase.emitAllocationEvents({
        paymentId: result.paymentId,
        receivableId: result.receivableId,
        amount: result.amount,
        allocatedByUserId: input.allocatedByUserId,
        organizationId,
        customerId: result.customerId,
        becameClosed: result.becameClosed,
      });
    }

    return matchedTransaction;
  }
}
