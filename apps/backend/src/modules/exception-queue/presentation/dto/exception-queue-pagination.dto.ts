import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../../../common/dto/pagination.dto';
import { MAX_SEARCH_LENGTH } from '../../../../common/validation/search-length';
import { ACTIONABLE_BANK_TRANSACTION_STATUSES } from '../../../webhooks/domain/bank-transaction';

export class ExceptionQueuePaginationDto extends PaginationDto {
  @ApiProperty({ type: String, required: false })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SEARCH_LENGTH)
  search?: string;

  @ApiProperty({
    type: String,
    enum: ACTIONABLE_BANK_TRANSACTION_STATUSES,
    required: false,
    description:
      'Defaults to every actionable status (PENDING_REVIEW + UNMATCHED).',
  })
  @IsOptional()
  @IsIn(ACTIONABLE_BANK_TRANSACTION_STATUSES)
  status?: (typeof ACTIONABLE_BANK_TRANSACTION_STATUSES)[number];
}
