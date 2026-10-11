import { randomUUID } from 'node:crypto';
import { ReceivableStatus } from '@casso-ar/shared-types';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import request from 'supertest';
import type { StartedTestContainer } from 'testcontainers';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuditLogOrmEntity } from '../src/common/audit/audit-log.orm-entity';
import { configureApp } from '../src/configure-app';
import { CustomerOrmEntity } from '../src/modules/customers/infrastructure/customer.orm-entity';
import { LedgerEventOrmEntity } from '../src/modules/ledger/infrastructure/ledger-event.orm-entity';
import { Role } from '../src/modules/organizations/domain/membership';
import { MembershipOrmEntity } from '../src/modules/organizations/infrastructure/membership.orm-entity';
import { PaymentOrmEntity } from '../src/modules/payments/infrastructure/payment.orm-entity';
import { ReceivableBalanceHistoryOrmEntity } from '../src/modules/receivable-balance-history/infrastructure/receivable-balance-history.orm-entity';
import { ReceivableOrmEntity } from '../src/modules/receivables/infrastructure/receivable.orm-entity';
import { UserOrmEntity } from '../src/modules/users/infrastructure/user.orm-entity';
import { ProcessWebhookUseCase } from '../src/modules/webhooks/application/process-webhook.usecase';
import { BankTransactionOrmEntity } from '../src/modules/webhooks/infrastructure/bank-transaction.orm-entity';
import { MatchingCandidateOrmEntity } from '../src/modules/webhooks/infrastructure/matching-candidate.orm-entity';
import { WebhookInboxOrmEntity } from '../src/modules/webhooks/infrastructure/webhook-inbox.orm-entity';
import { startTestRedis } from './helpers/test-redis';
import { createTwoPartyStartGate } from './helpers/two-party-start-gate';

describe('Exception Queue (e2e)', () => {
  let container: StartedPostgreSqlContainer;
  let redis: StartedTestContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let token: string;
  const organizationId = '00000000-0000-4000-8000-000000000101';
  const userId = '00000000-0000-4000-8000-000000000102';

  beforeAll(async () => {
    redis = await startTestRedis();
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DB_HOST = container.getHost();
    process.env.DB_PORT = String(container.getMappedPort(5432));
    process.env.DB_USERNAME = container.getUsername();
    process.env.DB_PASSWORD = container.getPassword();
    process.env.DB_DATABASE = container.getDatabase();
    process.env.JWT_SECRET = 'exception-queue-e2e-secret';
    process.env.RESEND_API_KEY = 'exception-queue-e2e-resend-key';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideModule(TypeOrmModule)
      .useModule(
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: container.getHost(),
          port: container.getMappedPort(5432),
          username: container.getUsername(),
          password: container.getPassword(),
          database: container.getDatabase(),
          autoLoadEntities: true,
          synchronize: true,
          retryAttempts: 0,
        }),
      )
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    dataSource = moduleRef.get(DataSource);

    await dataSource.getRepository(UserOrmEntity).save({
      id: userId,
      name: 'Exception Queue User',
      email: 'exception-queue@example.com',
      passwordHash: 'test-hash',
      emailVerifiedAt: new Date(),
      createdAt: new Date(),
    });
    await dataSource.getRepository(MembershipOrmEntity).save({
      id: randomUUID(),
      organizationId,
      userId,
      role: Role.OWNER,
      invitedAt: new Date(),
      joinedAt: new Date(),
      createdAt: new Date(),
    });

    const jwt = moduleRef.get(JwtService);
    token = jwt.sign({ userId, organizationId, role: Role.OWNER });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await Promise.all([redis.stop(), container.stop()]);
  });

  async function createCustomer(id = randomUUID()): Promise<string> {
    await dataSource.getRepository(CustomerOrmEntity).save({
      id,
      organizationId,
      name: `Customer ${id.slice(-4)}`,
      taxCode: `TAX-${id.slice(-8)}`,
      email: `${id}@example.com`,
      phone: '0900000000',
      defaultPaymentTermDays: 30,
      creditLimit: 0,
      priority: 1,
      createdAt: new Date(),
    });
    return id;
  }

  async function createReceivable(
    customerId: string,
    originalAmount: number,
  ): Promise<string> {
    const id = randomUUID();
    await dataSource.getRepository(ReceivableOrmEntity).save({
      id,
      organizationId,
      customerId,
      invoiceId: null,
      originalAmount,
      paidAmount: 0,
      dueDate: new Date('2026-09-01'),
      status: ReceivableStatus.OPEN,
      salesRepresentativeId: null,
      createdAt: new Date(),
      closedAt: null,
      version: 1,
    });
    return id;
  }

  async function createReviewTransaction(amount: number): Promise<string> {
    const id = randomUUID();
    await dataSource.getRepository(BankTransactionOrmEntity).save({
      id,
      organizationId,
      bankConnectionId: randomUUID(),
      webhookInboxId: randomUUID(),
      providerTransactionId: `TX-${id}`,
      amount,
      transactionDateTime: new Date('2026-08-01'),
      counterpartyAccountNumber: '0011002233',
      counterpartyName: 'Exception Customer',
      transferContent: 'manual review',
      status: 'PENDING_REVIEW',
      version: 1,
      createdAt: new Date(),
    });
    return id;
  }

  async function fetchVersionViaApi(id: string): Promise<number> {
    const unmatched = await request(app.getHttpServer())
      .get('/api/v1/bank-transactions/unmatched')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const item = unmatched.body.items.find(
      (entry: { transaction: { id: string } }) => entry.transaction.id === id,
    );
    return item.transaction.version;
  }

  it('lets exactly one of two concurrent match requests succeed', async () => {
    const customerId = await createCustomer();
    const receivableId = await createReceivable(customerId, 30_000_000);
    const transactionId = await createReviewTransaction(30_000_000);
    const body = {
      allocations: [{ receivableId, amount: 30_000_000 }],
      version: await fetchVersionViaApi(transactionId),
    };

    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/v1/bank-transactions/${transactionId}/match`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', `match-a-${transactionId}`)
        .send(body),
      request(app.getHttpServer())
        .post(`/api/v1/bank-transactions/${transactionId}/match`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', `match-b-${transactionId}`)
        .send(body),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const transaction = await dataSource
      .getRepository(BankTransactionOrmEntity)
      .findOneByOrFail({ id: transactionId });
    expect(transaction.status).toBe('MATCHED');
    expect(Number(transaction.version)).toBe(2);
    expect(
      await dataSource.getRepository(PaymentOrmEntity).countBy({
        bankTransactionId: transactionId,
      }),
    ).toBe(1);
  }, 20_000);

  it('splits one transaction across receivables and leaves the remainder unallocated', async () => {
    const customerId = await createCustomer();
    const receivableIdA = await createReceivable(customerId, 20_000_000);
    const receivableIdB = await createReceivable(customerId, 15_000_000);
    const transactionId = await createReviewTransaction(30_000_000);

    await request(app.getHttpServer())
      .post(`/api/v1/bank-transactions/${transactionId}/match`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `match-split-${transactionId}`)
      .send({
        allocations: [
          { receivableId: receivableIdA, amount: 20_000_000 },
          { receivableId: receivableIdB, amount: 5_000_000 },
        ],
        version: await fetchVersionViaApi(transactionId),
      })
      .expect(201);

    const receivableA = await dataSource
      .getRepository(ReceivableOrmEntity)
      .findOneByOrFail({ id: receivableIdA });
    const receivableB = await dataSource
      .getRepository(ReceivableOrmEntity)
      .findOneByOrFail({ id: receivableIdB });
    expect(receivableA.status).toBe(ReceivableStatus.PAID);
    expect(Number(receivableA.paidAmount)).toBe(20_000_000);
    expect(receivableB.status).toBe(ReceivableStatus.PARTIALLY_PAID);
    expect(Number(receivableB.paidAmount)).toBe(5_000_000);

    const payment = await dataSource
      .getRepository(PaymentOrmEntity)
      .findOneByOrFail({ bankTransactionId: transactionId });
    expect(Number(payment.totalAmount)).toBe(30_000_000);
    expect(Number(payment.allocatedAmount)).toBe(25_000_000);

    const auditRowsA = await dataSource.getRepository(AuditLogOrmEntity).find({
      where: { organizationId, relatedReceivableId: receivableIdA },
    });
    const auditRowsB = await dataSource.getRepository(AuditLogOrmEntity).find({
      where: { organizationId, relatedReceivableId: receivableIdB },
    });
    expect(auditRowsA).toHaveLength(1);
    expect(auditRowsA[0].actionType).toBe('PAYMENT_ALLOCATE');
    expect(auditRowsA[0].afterState).toMatchObject({
      receivableId: receivableIdA,
      allocatedAmount: 20_000_000,
    });
    expect(auditRowsB).toHaveLength(1);
    expect(auditRowsB[0].afterState).toMatchObject({
      receivableId: receivableIdB,
      allocatedAmount: 5_000_000,
    });
  }, 20_000);

  it('matches concurrent transactions over the same receivables requested in reverse order', async () => {
    const customerId = await createCustomer();
    const receivableIdA = await createReceivable(customerId, 100_000_000);
    const receivableIdB = await createReceivable(customerId, 100_000_000);
    const transactionIdA = await createReviewTransaction(20_000_000);
    const transactionIdB = await createReviewTransaction(20_000_000);
    const [versionA, versionB] = await Promise.all([
      fetchVersionViaApi(transactionIdA),
      fetchVersionViaApi(transactionIdB),
    ]);

    const startTogether = createTwoPartyStartGate();
    const match = async (
      transactionId: string,
      version: number,
      receivables: string[],
    ) => {
      await startTogether();
      return request(app.getHttpServer())
        .post(`/api/v1/bank-transactions/${transactionId}/match`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', `reverse-order-${transactionId}`)
        .send({
          allocations: receivables.map((receivableId) => ({
            receivableId,
            amount: 5_000_000,
          })),
          version,
        });
    };

    const [first, second] = await Promise.all([
      match(transactionIdA, versionA, [
        receivableIdA.toUpperCase(),
        receivableIdB,
      ]),
      match(transactionIdB, versionB, [
        receivableIdB.toUpperCase(),
        receivableIdA,
      ]),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);

    for (const receivableId of [receivableIdA, receivableIdB]) {
      const receivable = await dataSource
        .getRepository(ReceivableOrmEntity)
        .findOneByOrFail({ id: receivableId, organizationId });
      expect(Number(receivable.paidAmount)).toBe(10_000_000);
    }
    for (const transactionId of [transactionIdA, transactionIdB]) {
      const bankTransaction = await dataSource
        .getRepository(BankTransactionOrmEntity)
        .findOneByOrFail({ id: transactionId, organizationId });
      const payment = await dataSource
        .getRepository(PaymentOrmEntity)
        .findOneByOrFail({ bankTransactionId: transactionId, organizationId });
      expect(bankTransaction.status).toBe('MATCHED');
      expect(Number(payment.allocatedAmount)).toBe(10_000_000);
    }
  }, 20_000);

  it('flags a pending-review transaction ambiguous only when the top candidate leads by less than 10 points', async () => {
    const customerId = await createCustomer();
    const saveCandidates = async (
      bankTransactionId: string,
      scores: number[],
    ): Promise<void> => {
      for (const totalScore of scores) {
        await dataSource.getRepository(MatchingCandidateOrmEntity).save({
          id: randomUUID(),
          organizationId,
          bankTransactionId,
          receivableId: await createReceivable(customerId, 1_000_000),
          customerId,
          referenceCodeScore: 0,
          amountScore: 0,
          customerBankAccountScore: 0,
          payerNameScore: 0,
          timingScore: 0,
          totalScore,
          createdAt: new Date(),
        });
      }
    };
    const narrow = await createReviewTransaction(1_000_000);
    const exactMargin = await createReviewTransaction(1_000_000);
    const clear = await createReviewTransaction(1_000_000);
    const single = await createReviewTransaction(1_000_000);
    const none = await createReviewTransaction(1_000_000);
    await saveCandidates(narrow, [91, 95, 40]);
    await saveCandidates(exactMargin, [85, 95]);
    await saveCandidates(clear, [60, 95]);
    await saveCandidates(single, [85]);

    const response = await request(app.getHttpServer())
      .get('/api/v1/bank-transactions/unmatched?limit=100')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const ambiguousById = new Map<string, boolean>(
      response.body.items.map(
        (entry: { transaction: { id: string }; isAmbiguous: boolean }) => [
          entry.transaction.id,
          entry.isAmbiguous,
        ],
      ),
    );
    expect(ambiguousById.get(narrow)).toBe(true);
    expect(ambiguousById.get(exactMargin)).toBe(false);
    expect(ambiguousById.get(clear)).toBe(false);
    expect(ambiguousById.get(single)).toBe(false);
    expect(ambiguousById.get(none)).toBe(false);
  }, 30_000);

  it('queues a low-scoring webhook transaction and matches it end to end', async () => {
    const customerId = await createCustomer();
    const receivableId = await createReceivable(customerId, 12_000_000);
    // An unknown payer account and an invoice-free description score below the
    // exception threshold, so the webhook stores the transaction UNMATCHED.
    const inboxId = randomUUID();
    await dataSource.getRepository(WebhookInboxOrmEntity).save({
      id: inboxId,
      organizationId,
      bankConnectionId: randomUUID(),
      providerTransactionId: '2043301',
      rawPayload: {
        error: 0,
        data: {
          id: 2_043_301,
          transactionDateTime: '2026-08-20 10:00:00',
          accountNumber: '99887766',
          amount: 12_000_000,
          description: 'chuyen tien',
          counterAccountNumber: '5500009999',
          counterAccountName: 'Unknown Payer',
        },
      },
      receivedAt: new Date(),
      status: 'RECEIVED',
      processedAt: null,
      errorMessage: null,
      retryCount: 0,
    });
    await app
      .get(ProcessWebhookUseCase, { strict: false })
      .execute(inboxId, organizationId);

    const transaction = await dataSource
      .getRepository(BankTransactionOrmEntity)
      .findOneByOrFail({ providerTransactionId: '2043301', organizationId });
    expect(transaction.status).toBe('UNMATCHED');

    const queue = await request(app.getHttpServer())
      .get('/api/v1/bank-transactions/unmatched?limit=100')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    // AC: the queue list and count include UNMATCHED without any filter.
    expect(queue.body.total).toBeGreaterThanOrEqual(1);
    const queued = queue.body.items.find(
      (entry: { transaction: { id: string } }) =>
        entry.transaction.id === transaction.id,
    );
    expect(queued).toBeDefined();
    expect(queued.transaction.status).toBe('UNMATCHED');
    // Nothing scored high enough to suggest, so the reviewer picks by hand.
    expect(queued.topCandidate).toBeNull();

    const counted = await request(app.getHttpServer())
      .get('/api/v1/bank-transactions/pending-review-count')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(counted.body.count).toBe(queue.body.total);

    const filtered = await request(app.getHttpServer())
      .get('/api/v1/bank-transactions/unmatched?limit=100&status=UNMATCHED')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      filtered.body.items.every(
        (entry: { transaction: { status: string } }) =>
          entry.transaction.status === 'UNMATCHED',
      ),
    ).toBe(true);
    expect(filtered.body.total).toBeLessThanOrEqual(queue.body.total);

    await request(app.getHttpServer())
      .post(`/api/v1/bank-transactions/${transaction.id}/match`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `match-unmatched-${transaction.id}`)
      .send({
        allocations: [{ receivableId, amount: 12_000_000 }],
        version: queued.transaction.version,
      })
      .expect(201);

    const receivable = await dataSource
      .getRepository(ReceivableOrmEntity)
      .findOneByOrFail({ id: receivableId });
    expect(receivable.status).toBe(ReceivableStatus.PAID);
    expect(Number(receivable.paidAmount)).toBe(12_000_000);

    const payment = await dataSource
      .getRepository(PaymentOrmEntity)
      .findOneByOrFail({ bankTransactionId: transaction.id });
    expect(Number(payment.allocatedAmount)).toBe(12_000_000);
    expect(Number(payment.totalAmount) - Number(payment.allocatedAmount)).toBe(
      0,
    );
    expect(
      (
        await dataSource
          .getRepository(BankTransactionOrmEntity)
          .findOneByOrFail({ id: transaction.id })
      ).status,
    ).toBe('MATCHED');

    const history = await dataSource
      .getRepository(ReceivableBalanceHistoryOrmEntity)
      .find({
        where: { organizationId, receivableId },
        order: { effectiveAt: 'ASC', sequence: 'ASC' },
      });
    expect(history.length).toBeGreaterThan(0);
    expect(Number(history.at(-1)?.remainingAmount)).toBe(0);

    const ledgerEvents = await dataSource
      .getRepository(LedgerEventOrmEntity)
      .find({ where: { organizationId, subjectId: payment.id } });
    expect(ledgerEvents.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['PAYMENT_RECEIVED']),
    );
  }, 30_000);
});
