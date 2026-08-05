/**
 * Test environment. Loaded via jest setupFiles before any module imports.
 * Unit tests replace PrismaService with the in-memory fake, so `npm test`
 * runs without live services by default. CI opts one transport integration
 * suite into its Postgres service with RUN_POSTGRES_INTEGRATION=1.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef';
process.env.JWT_ACCESS_TTL = '900';
process.env.JWT_REFRESH_TTL = '1209600';
// 32 bytes of 0x07, base64 — a valid key used only in tests.
process.env.CRED_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
// Most tests replace Prisma with the in-memory fake. CI also runs a small,
// explicitly opted-in suite against its Postgres service so cross-process
// ordering is exercised by the real database rather than simulated in one
// JavaScript heap.
if (process.env.RUN_POSTGRES_INTEGRATION !== '1') {
  process.env.DATABASE_URL = 'postgresql://unused:unused@localhost:5432/unused';
}
