/**
 * Test environment. Loaded via jest setupFiles before any module imports.
 * Tests never touch Postgres/Redis — PrismaService is replaced with the
 * in-memory fake (see in-memory-prisma.service.ts), so `npm test` runs
 * without any live services.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef';
process.env.JWT_ACCESS_TTL = '900';
process.env.JWT_REFRESH_TTL = '1209600';
// 32 bytes of 0x07, base64 — a valid key used only in tests.
process.env.CRED_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.BROKER_GATEWAY = 'mock';
process.env.DATABASE_URL = 'postgresql://unused:unused@localhost:5432/unused';
