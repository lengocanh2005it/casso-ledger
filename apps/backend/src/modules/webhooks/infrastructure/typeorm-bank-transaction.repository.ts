import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { EntityManager, FindOptionsWhere, Repository } from 'typeorm';
import { ILike, In } from 'typeorm';
import { toLikePattern } from '../../../common/database/like-pattern';
import { BaseRepository } from '../../../common/tenancy/base.repository';
import { TenantContextService } from '../../../common/tenancy/tenant-context';
import type { IBankTransactionRepository } from '../application/bank-transaction-repository.port';
import {
  BankTransaction,
  type BankTransactionStatus,
} from '../domain/bank-transaction';
import { BankTransactionOrmEntity } from './bank-transaction.orm-entity';

function toOrm(transaction: BankTransaction): BankTransactionOrmEntity {
  return {
    id: transaction.id,
    organizationId: transaction.organizationId,
    bankConnectionId: transaction.bankConnectionId,
    webhookInboxId: transaction.webhookInboxId,
    providerTransactionId: transaction.providerTransactionId,
    amount: transaction.amount,
    transactionDateTime: transaction.transactionDateTime,
    counterpartyAccountNumber: transaction.counterpartyAccountNumber,
    counterpartyName: transaction.counterpartyName,
    transferContent: transaction.transferContent,
    status: transaction.status,
    version: transaction.version,
    createdAt: transaction.createdAt,
    aiRecommendation: transaction.aiRecommendation,
  };
}

function toDomain(row: BankTransactionOrmEntity): BankTransaction {
  return new BankTransaction({
    id: row.id,
    organizationId: row.organizationId,
    bankConnectionId: row.bankConnectionId,
    webhookInboxId: row.webhookInboxId,
    providerTransactionId: row.providerTransactionId,
    amount: row.amount,
    transactionDateTime: row.transactionDateTime,
    counterpartyAccountNumber: row.counterpartyAccountNumber,
    counterpartyName: row.counterpartyName,
    transferContent: row.transferContent,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    aiRecommendation: row.aiRecommendation,
  });
}

@Injectable()
export class TypeOrmBankTransactionRepository
  extends BaseRepository<BankTransactionOrmEntity>
  implements IBankTransactionRepository
{
  constructor(
    @InjectRepository(BankTransactionOrmEntity)
    repo: Repository<BankTransactionOrmEntity>,
    tenantContext: TenantContextService,
  ) {
    super(repo, tenantContext);
  }

  async save(
    transaction: BankTransaction,
    manager?: EntityManager,
  ): Promise<void> {
    await this.scopedSaveWithManager(toOrm(transaction), manager);
  }

  async findById(id: string): Promise<BankTransaction | null> {
    const row = await this.scopedFindOne({ id });
    return row ? toDomain(row) : null;
  }

  async findByIdForUpdate(
    id: string,
    manager: EntityManager,
  ): Promise<BankTransaction | null> {
    const organizationId = this.tenantContext.getOrganizationId();
    const row = await manager.findOne(BankTransactionOrmEntity, {
      where: { id, organizationId },
      lock: { mode: 'pessimistic_write' },
    });
    return row ? toDomain(row) : null;
  }

  async findManyByStatus(
    status: BankTransactionStatus[],
    options?: { skip?: number; take?: number; search?: string },
  ): Promise<BankTransaction[]> {
    const organizationId = this.tenantContext.getOrganizationId();
    const rows = await this.ormRepo.find({
      where: searchWhere(organizationId, status, options?.search),
      order: { createdAt: 'ASC' },
      skip: options?.skip,
      take: options?.take,
    });
    return rows.map(toDomain);
  }

  async countByStatus(
    status: BankTransactionStatus[],
    search?: string,
  ): Promise<number> {
    const organizationId = this.tenantContext.getOrganizationId();
    return this.ormRepo.count({
      where: searchWhere(organizationId, status, search),
    });
  }
}

// A search term ILIKE-matches any of the three counterparty/content fields
// (OR); TypeORM ORs across an array of where-objects, each still AND'd with
// organizationId + status.
function searchWhere(
  organizationId: string,
  status: BankTransactionStatus[],
  search: string | undefined,
):
  | FindOptionsWhere<BankTransactionOrmEntity>
  | FindOptionsWhere<BankTransactionOrmEntity>[] {
  const base: FindOptionsWhere<BankTransactionOrmEntity> = {
    organizationId,
    status: In(status),
  };
  if (!search) return base;
  const term = ILike(toLikePattern(search));
  return [
    { ...base, counterpartyName: term },
    { ...base, counterpartyAccountNumber: term },
    { ...base, transferContent: term },
  ];
}
