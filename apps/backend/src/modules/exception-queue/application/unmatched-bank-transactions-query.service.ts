import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-code';
import {
  maskAccountNumber,
  safeNormalizeAccountNumber,
} from '../../bank-accounts/application/account-number-normalizer';
import {
  CUSTOMER_BANK_ACCOUNT_REPOSITORY,
  type ICustomerBankAccountRepository,
} from '../../bank-accounts/application/customer-bank-account-repository.port';
import {
  CUSTOMER_REPOSITORY,
  type ICustomerRepository,
} from '../../customers/application/customer-repository.port';
import {
  type IInvoiceRepository,
  INVOICE_REPOSITORY,
} from '../../invoices/application/invoice-repository.port';
import { loadReceivableRelatedData } from '../../receivables/application/load-receivable-related-data';
import {
  type IReceivableRepository,
  RECEIVABLE_REPOSITORY,
} from '../../receivables/application/receivable-repository.port';
import {
  BANK_TRANSACTION_REPOSITORY,
  type IBankTransactionRepository,
} from '../../webhooks/application/bank-transaction-repository.port';
import { hasClearLead } from '../../webhooks/application/can-auto-match';
import {
  type IMatchingCandidateRepository,
  MATCHING_CANDIDATE_REPOSITORY,
} from '../../webhooks/application/matching-candidate-repository.port';
import type { AiMatchingRecommendation } from '../../webhooks/domain/ai-matching-recommendation';
import type { BankTransaction } from '../../webhooks/domain/bank-transaction';
import { ACTIONABLE_BANK_TRANSACTION_STATUSES } from '../../webhooks/domain/bank-transaction';
import type { MatchingCandidate } from '../../webhooks/domain/matching-candidate';

export interface AiMatchingRecommendationView {
  status: AiMatchingRecommendation['status'];
  recommendedReceivableId: string | null;
  confidence: number | null;
  reason: string | null;
  isCurrent: boolean;
}

export interface PayerLinkedCustomerView {
  customerId: string;
  customerName: string;
}

export interface PayerView {
  accountNumberMasked: string;
  name: string;
  linkedCustomers: PayerLinkedCustomerView[];
}

export interface UnmatchedBankTransactionView {
  transaction: BankTransaction;
  topCandidate: MatchingCandidateView | null;
  /** Derived at read time: top candidate leads the runner-up by < 10 points. */
  isAmbiguous: boolean;
  aiRecommendation: AiMatchingRecommendationView | null;
  payer: PayerView;
}

export interface MatchingCandidateView {
  candidate: MatchingCandidate;
  invoiceNumber: string | null;
  customerName: string | null;
  remainingAmount: number | null;
  dueDate: Date | null;
}

export interface UnmatchedBankTransactionPage {
  items: UnmatchedBankTransactionView[];
  total: number;
  page: number;
  limit: number;
}

@Injectable()
export class UnmatchedBankTransactionsQueryService {
  constructor(
    @Inject(BANK_TRANSACTION_REPOSITORY)
    private readonly bankTransactionRepo: IBankTransactionRepository,
    @Inject(MATCHING_CANDIDATE_REPOSITORY)
    private readonly matchingCandidateRepo: IMatchingCandidateRepository,
    @Inject(RECEIVABLE_REPOSITORY)
    private readonly receivableRepo: IReceivableRepository,
    @Inject(CUSTOMER_REPOSITORY)
    private readonly customerRepo: ICustomerRepository,
    @Inject(INVOICE_REPOSITORY)
    private readonly invoiceRepo: IInvoiceRepository,
    @Inject(CUSTOMER_BANK_ACCOUNT_REPOSITORY)
    private readonly bankAccountRepo: Pick<
      ICustomerBankAccountRepository,
      'findActiveByAccountNumbers'
    >,
  ) {}

  async execute(
    page = 1,
    limit = 20,
    search?: string,
    status?: (typeof ACTIONABLE_BANK_TRANSACTION_STATUSES)[number],
  ): Promise<UnmatchedBankTransactionPage> {
    const statuses = status
      ? [status]
      : [...ACTIONABLE_BANK_TRANSACTION_STATUSES];
    const [pageTransactions, total] = await Promise.all([
      this.bankTransactionRepo.findManyByStatus(statuses, {
        skip: (page - 1) * limit,
        take: limit,
        ...(search ? { search } : {}),
      }),
      this.bankTransactionRepo.countByStatus(statuses, search),
    ]);
    const pageTransactionIds = pageTransactions.map(
      (transaction) => transaction.id,
    );
    const [topCandidates, runnerUpScores] = await Promise.all([
      this.matchingCandidateRepo.findTopByBankTransactionIds(
        pageTransactionIds,
      ),
      this.matchingCandidateRepo.findRunnerUpScoresByBankTransactionIds(
        pageTransactionIds,
      ),
    ]);
    const candidateViews = await this.toCandidateViews([
      ...topCandidates.values(),
    ]);
    const candidateViewsById = new Map(
      candidateViews.map((view) => [view.candidate.id, view]),
    );
    const recommendationIds = pageTransactions.flatMap((transaction) => {
      const recommendation = transaction.aiRecommendation;
      return recommendation?.status === 'SUCCEEDED' &&
        recommendation.recommendedReceivableId
        ? [recommendation.recommendedReceivableId]
        : [];
    });
    const openReceivableIds = new Set(
      recommendationIds.length > 0
        ? (
            await this.receivableRepo.findOpenByIds([
              ...new Set(recommendationIds),
            ])
          ).map((receivable) => receivable.id)
        : [],
    );

    const counterpartyAccountNumbers = pageTransactions
      .map((transaction) => transaction.counterpartyAccountNumber)
      .filter((value): value is string => Boolean(value));
    const payerLinks =
      counterpartyAccountNumbers.length > 0
        ? await this.bankAccountRepo.findActiveByAccountNumbers(
            counterpartyAccountNumbers,
          )
        : [];
    const payerCustomerNames =
      payerLinks.length > 0
        ? await this.customerRepo.findByIds([
            ...new Set(payerLinks.map((link) => link.customerId)),
          ])
        : new Map<string, { name: string }>();
    // link.accountNumber is the normalized DB value — group by it and look up
    // each transaction's counterparty number through the same normalizer.
    const linkedCustomersByAccount = new Map<
      string,
      PayerLinkedCustomerView[]
    >();
    for (const link of payerLinks) {
      const list = linkedCustomersByAccount.get(link.accountNumber) ?? [];
      list.push({
        customerId: link.customerId,
        customerName: payerCustomerNames.get(link.customerId)?.name ?? '',
      });
      linkedCustomersByAccount.set(link.accountNumber, list);
    }

    return {
      items: pageTransactions.map((transaction) => {
        const candidate = topCandidates.get(transaction.id);
        const accountNumber = transaction.counterpartyAccountNumber;
        const normalizedAccount = accountNumber
          ? safeNormalizeAccountNumber(accountNumber)
          : null;
        const linkedCustomers = normalizedAccount
          ? (linkedCustomersByAccount.get(normalizedAccount) ?? [])
          : [];
        return {
          transaction,
          topCandidate: candidate
            ? (candidateViewsById.get(candidate.id) ?? null)
            : null,
          isAmbiguous:
            !!candidate &&
            !hasClearLead(
              candidate.totalScore,
              runnerUpScores.get(transaction.id) ?? null,
            ),
          aiRecommendation: toRecommendationView(
            transaction.aiRecommendation,
            openReceivableIds,
          ),
          payer: {
            accountNumberMasked: accountNumber
              ? maskAccountNumber(accountNumber)
              : '',
            name: transaction.counterpartyName ?? '',
            linkedCustomers,
          },
        };
      }),
      total,
      page,
      limit,
    };
  }

  async countQueue(): Promise<number> {
    return this.bankTransactionRepo.countByStatus([
      ...ACTIONABLE_BANK_TRANSACTION_STATUSES,
    ]);
  }

  async candidates(
    bankTransactionId: string,
  ): Promise<MatchingCandidateView[]> {
    const transaction =
      await this.bankTransactionRepo.findById(bankTransactionId);
    if (!transaction) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy giao dịch ngân hàng.',
      );
    }
    return this.toCandidateViews(
      await this.matchingCandidateRepo.findByBankTransactionId(
        bankTransactionId,
      ),
    );
  }

  private async toCandidateViews(
    candidates: MatchingCandidate[],
  ): Promise<MatchingCandidateView[]> {
    if (candidates.length === 0) return [];
    const receivables = await this.receivableRepo.findByIds([
      ...new Set(candidates.map((candidate) => candidate.receivableId)),
    ]);
    const { customers, invoices } = await loadReceivableRelatedData(
      [...receivables.values()],
      candidates.map((candidate) => candidate.customerId),
      this.customerRepo,
      this.invoiceRepo,
    );

    return candidates.map((candidate) => {
      const receivable = receivables.get(candidate.receivableId);
      return {
        candidate,
        invoiceNumber: receivable?.invoiceId
          ? (invoices.get(receivable.invoiceId)?.invoiceNumber ?? null)
          : null,
        customerName: customers.get(candidate.customerId)?.name ?? null,
        remainingAmount: receivable
          ? receivable.originalAmount - receivable.paidAmount
          : null,
        dueDate: receivable?.dueDate ?? null,
      };
    });
  }
}

function toRecommendationView(
  recommendation: AiMatchingRecommendation | null | undefined,
  openReceivableIds: Set<string>,
): AiMatchingRecommendationView | null {
  if (!recommendation) return null;
  return {
    status: recommendation.status,
    recommendedReceivableId: recommendation.recommendedReceivableId,
    confidence: recommendation.confidence,
    reason: recommendation.reason,
    isCurrent:
      recommendation.status === 'SUCCEEDED' &&
      recommendation.recommendedReceivableId !== null &&
      openReceivableIds.has(recommendation.recommendedReceivableId),
  };
}
