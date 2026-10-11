import { Permission } from '@casso-ar/shared-types';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AuditActionType,
  AuditEntityType,
} from '../../../common/audit/audit.enums';
import { Audited } from '../../../common/audit/audited.decorator';
import { BatchIdsDto } from '../../../common/dto/batch-ids.dto';
import { AppError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-code';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import { PermissionGuard } from '../../../common/rbac/permission.guard';
import { RequirePermission } from '../../../common/rbac/require-permission.decorator';
import { ApiErrorResponse } from '../../../common/swagger/api-error-response.decorator';
import { ApiIdempotencyKey } from '../../../common/swagger/api-idempotency-key.decorator';
import { TenantContextService } from '../../../common/tenancy/tenant-context';
import { BatchMarkPrepaidBankTransactionUseCase } from '../application/batch-mark-prepaid-bank-transaction.usecase';
import { BatchMatchBankTransactionUseCase } from '../application/batch-match-bank-transaction.usecase';
import { BatchSkipBankTransactionUseCase } from '../application/batch-skip-bank-transaction.usecase';
import { MarkPrepaidBankTransactionUseCase } from '../application/mark-prepaid-bank-transaction.usecase';
import { MatchBankTransactionUseCase } from '../application/match-bank-transaction.usecase';
import { SkipBankTransactionUseCase } from '../application/skip-bank-transaction.usecase';
import { UnmatchedBankTransactionsQueryService } from '../application/unmatched-bank-transactions-query.service';
import { BatchMarkPrepaidBankTransactionDto } from './dto/batch-mark-prepaid-bank-transaction.dto';
import { BatchMatchBankTransactionDto } from './dto/batch-match-bank-transaction.dto';
import { ExceptionQueuePaginationDto } from './dto/exception-queue-pagination.dto';
import {
  BankTransactionResponseDto,
  MatchingCandidateResponseDto,
  toBankTransactionResponse,
  toMatchingCandidateResponse,
  toPaymentResponse,
  toUnmatchedResponse,
  UnmatchedBankTransactionPageResponseDto,
} from './dto/exception-queue-response.dto';
import { MarkPrepaidBankTransactionDto } from './dto/mark-prepaid-bank-transaction.dto';
import { MatchBankTransactionDto } from './dto/match-bank-transaction.dto';

@ApiTags('exception-queue')
@Controller('bank-transactions')
@UseGuards(PermissionGuard)
export class ExceptionQueueController {
  constructor(
    private readonly unmatchedQuery: UnmatchedBankTransactionsQueryService,
    private readonly matchUseCase: MatchBankTransactionUseCase,
    private readonly batchMatchUseCase: BatchMatchBankTransactionUseCase,
    private readonly skipUseCase: SkipBankTransactionUseCase,
    private readonly batchSkipUseCase: BatchSkipBankTransactionUseCase,
    private readonly markPrepaidUseCase: MarkPrepaidBankTransactionUseCase,
    private readonly batchMarkPrepaidUseCase: BatchMarkPrepaidBankTransactionUseCase,
    private readonly tenantContext: TenantContextService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('unmatched')
  @ApiOperation({
    summary: 'List unmatched bank transactions (exception queue)',
  })
  @ApiOkResponse({ type: UnmatchedBankTransactionPageResponseDto })
  @ApiErrorResponse(ErrorCode.VALIDATION_ERROR)
  @RequirePermission(Permission.PAYMENT_ALLOCATE)
  async unmatched(@Query() query: ExceptionQueuePaginationDto) {
    return toUnmatchedResponse(
      await this.unmatchedQuery.execute(
        query.page,
        query.limit,
        query.search,
        query.status,
      ),
    );
  }

  @Get('pending-review-count')
  @ApiOperation({
    summary: 'Count bank transactions still awaiting a reviewer decision',
  })
  @ApiOkResponse({
    description:
      'Number of transactions awaiting review (pending review + unmatched)',
    schema: {
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'number' } },
    },
  })
  @RequirePermission(Permission.PAYMENT_ALLOCATE)
  async pendingReviewCount() {
    return { count: await this.unmatchedQuery.countQueue() };
  }

  @Get(':id/candidates')
  @ApiOperation({ summary: 'List matching candidates for a transaction' })
  @ApiOkResponse({ type: [MatchingCandidateResponseDto] })
  @ApiErrorResponse(ErrorCode.VALIDATION_ERROR, ErrorCode.NOT_FOUND)
  @RequirePermission(Permission.PAYMENT_ALLOCATE)
  async candidates(@Param('id') id: string) {
    const candidates = await this.unmatchedQuery.candidates(id);
    return candidates.map(toMatchingCandidateResponse);
  }

  @Post(':id/match')
  @ApiOperation({ summary: 'Match a bank transaction to receivables' })
  @ApiIdempotencyKey()
  @ApiCreatedResponse({ type: BankTransactionResponseDto })
  @ApiErrorResponse(
    ErrorCode.VALIDATION_ERROR,
    ErrorCode.UNAUTHORIZED,
    ErrorCode.NOT_FOUND,
    ErrorCode.RECEIVABLE_NOT_FOUND,
    ErrorCode.CUSTOMER_MISMATCH,
    ErrorCode.ALLOCATION_EXCEEDS_REMAINING,
    ErrorCode.OPTIMISTIC_LOCK_CONFLICT,
    ErrorCode.IDEMPOTENCY_KEY_REUSED,
  )
  @RequirePermission(Permission.PAYMENT_ALLOCATE)
  @Audited(AuditActionType.PAYMENT_ALLOCATE, AuditEntityType.BANK_TRANSACTION)
  async match(
    @Param('id') id: string,
    @Body() dto: MatchBankTransactionDto,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    const user = this.tenantContext.getCurrentUser();
    if (!user) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 'Yêu cầu đăng nhập.');
    }
    return this.idempotency.execute(
      `POST /bank-transactions/${id}/match`,
      key,
      { id, ...dto },
      async () =>
        toBankTransactionResponse(
          await this.matchUseCase.execute({
            bankTransactionId: id,
            allocations: dto.allocations,
            version: dto.version,
            allocatedByUserId: user.userId,
          }),
        ),
    );
  }

  @Post('batch-match')
  @ApiOperation({ summary: 'Match multiple bank transactions' })
  @ApiIdempotencyKey()
  @ApiCreatedResponse({
    description: 'Per-item results (success items include the transaction)',
  })
  @ApiErrorResponse(
    ErrorCode.VALIDATION_ERROR,
    ErrorCode.UNAUTHORIZED,
    ErrorCode.IDEMPOTENCY_KEY_REUSED,
  )
  @RequirePermission(Permission.PAYMENT_ALLOCATE)
  async batchMatch(
    @Body() dto: BatchMatchBankTransactionDto,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.idempotency.execute(
      'POST /bank-transactions/batch-match',
      key,
      dto,
      async () => {
        const results = await this.batchMatchUseCase.execute(dto.items);
        return {
          results: results.map((result) =>
            result.status === 'success' && result.data
              ? { ...result, data: toBankTransactionResponse(result.data) }
              : result,
          ),
        };
      },
    );
  }

  @Post(':id/skip')
  @ApiOperation({ summary: 'Skip a bank transaction' })
  @ApiIdempotencyKey()
  @ApiCreatedResponse({ type: BankTransactionResponseDto })
  @ApiErrorResponse(
    ErrorCode.VALIDATION_ERROR,
    ErrorCode.NOT_FOUND,
    ErrorCode.CONFLICT,
    ErrorCode.IDEMPOTENCY_KEY_REUSED,
  )
  @RequirePermission(Permission.PAYMENT_ALLOCATE)
  @Audited(
    AuditActionType.BANK_TRANSACTION_SKIP,
    AuditEntityType.BANK_TRANSACTION,
  )
  async skip(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.idempotency.execute(
      `POST /bank-transactions/${id}/skip`,
      key,
      { id },
      async () => toBankTransactionResponse(await this.skipUseCase.execute(id)),
    );
  }

  @Post('batch-skip')
  @ApiOperation({ summary: 'Skip multiple bank transactions' })
  @ApiIdempotencyKey()
  @ApiCreatedResponse({
    description: 'Per-item results (success items include the transaction)',
  })
  @ApiErrorResponse(
    ErrorCode.VALIDATION_ERROR,
    ErrorCode.UNAUTHORIZED,
    ErrorCode.IDEMPOTENCY_KEY_REUSED,
  )
  @RequirePermission(Permission.PAYMENT_ALLOCATE)
  async batchSkip(
    @Body() dto: BatchIdsDto,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.idempotency.execute(
      'POST /bank-transactions/batch-skip',
      key,
      dto,
      async () => {
        const results = await this.batchSkipUseCase.execute(dto.ids);
        return {
          results: results.map((result) =>
            result.status === 'success' && result.data
              ? { ...result, data: toBankTransactionResponse(result.data) }
              : result,
          ),
        };
      },
    );
  }

  @Post(':id/mark-prepaid')
  @ApiOperation({ summary: 'Mark a bank transaction as prepaid' })
  @ApiIdempotencyKey()
  @ApiCreatedResponse({
    description: 'Updated transaction and the created credit payment',
    schema: {
      type: 'object',
      required: ['transaction', 'payment'],
      properties: {
        transaction: {
          $ref: '#/components/schemas/BankTransactionResponseDto',
        },
        payment: { $ref: '#/components/schemas/PaymentResponseDto' },
      },
    },
  })
  @ApiErrorResponse(
    ErrorCode.VALIDATION_ERROR,
    ErrorCode.NOT_FOUND,
    ErrorCode.CONFLICT,
    ErrorCode.IDEMPOTENCY_KEY_REUSED,
  )
  @RequirePermission(Permission.PAYMENT_ALLOCATE)
  @Audited(
    AuditActionType.BANK_TRANSACTION_MARK_PREPAID,
    AuditEntityType.BANK_TRANSACTION,
  )
  async markPrepaid(
    @Param('id') id: string,
    @Body() dto: MarkPrepaidBankTransactionDto,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.idempotency.execute(
      `POST /bank-transactions/${id}/mark-prepaid`,
      key,
      { id, ...dto },
      async () => {
        const result = await this.markPrepaidUseCase.execute({
          bankTransactionId: id,
          customerId: dto.customerId,
        });
        return {
          transaction: toBankTransactionResponse(result.transaction),
          payment: toPaymentResponse(result.payment),
        };
      },
    );
  }

  @Post('batch-mark-prepaid')
  @ApiOperation({ summary: 'Mark multiple bank transactions as prepaid' })
  @ApiIdempotencyKey()
  @ApiCreatedResponse({
    description:
      'Per-item results (success items include transaction and payment)',
  })
  @ApiErrorResponse(
    ErrorCode.VALIDATION_ERROR,
    ErrorCode.UNAUTHORIZED,
    ErrorCode.IDEMPOTENCY_KEY_REUSED,
  )
  @RequirePermission(Permission.PAYMENT_ALLOCATE)
  async batchMarkPrepaid(
    @Body() dto: BatchMarkPrepaidBankTransactionDto,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.idempotency.execute(
      'POST /bank-transactions/batch-mark-prepaid',
      key,
      dto,
      async () => {
        const results = await this.batchMarkPrepaidUseCase.execute(
          dto.bankTransactionIds,
          dto.customerId,
        );
        return {
          results: results.map((result) =>
            result.status === 'success' && result.data
              ? {
                  ...result,
                  data: {
                    transaction: toBankTransactionResponse(
                      result.data.transaction,
                    ),
                    payment: toPaymentResponse(result.data.payment),
                  },
                }
              : result,
          ),
        };
      },
    );
  }
}
