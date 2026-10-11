import type { EntityManager } from 'typeorm';
import type {
  BankTransaction,
  BankTransactionStatus,
} from '../domain/bank-transaction';

export interface IBankTransactionRepository {
  save(transaction: BankTransaction, manager?: EntityManager): Promise<void>;
  findById(id: string): Promise<BankTransaction | null>;
  findByIdForUpdate(
    id: string,
    manager: EntityManager,
  ): Promise<BankTransaction | null>;
  findManyByStatus(
    status: BankTransactionStatus[],
    options?: { skip?: number; take?: number; search?: string },
  ): Promise<BankTransaction[]>;
  countByStatus(
    status: BankTransactionStatus[],
    search?: string,
  ): Promise<number>;
}

export const BANK_TRANSACTION_REPOSITORY = Symbol(
  'BANK_TRANSACTION_REPOSITORY',
);
