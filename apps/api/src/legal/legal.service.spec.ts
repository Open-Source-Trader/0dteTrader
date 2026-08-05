import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { LegalService } from './legal.service';

describe('LegalService', () => {
  let prisma: InMemoryPrismaService;
  let service: LegalService;
  let userId: string;

  beforeEach(async () => {
    prisma = new InMemoryPrismaService();
    service = new LegalService(prisma as never);
    userId = (await prisma.user.create({ data: { email: 'legal@example.com', passwordHash: 'x' } }))
      .id;
  });

  it('publishes every required document including a public privacy URL', () => {
    const documents = service.summaries('https://trade.example');
    expect(documents.map((document) => document.slug)).toEqual([
      'about',
      'terms',
      'privacy',
      'risk',
      'open-source-licenses',
    ]);
    expect(documents.find((document) => document.slug === 'privacy')?.publicUrl).toBe(
      'https://trade.example/v1/legal/privacy-policy',
    );
    expect(service.document('privacy', 'https://trade.example').markdown).toContain(
      '# Privacy Policy',
    );
  });

  it('records current terms/risk acceptance idempotently', async () => {
    const terms = service.summaries('https://trade.example').find((item) => item.slug === 'terms')!;
    await service.accept(userId, 'terms', terms.version, 'https://trade.example');
    const status = await service.accept(userId, 'terms', terms.version, 'https://trade.example');

    expect(prisma.legalAcceptances).toHaveLength(1);
    expect(status.documents.find((item) => item.slug === 'terms')?.accepted).toBe(true);
    expect(status.documents.find((item) => item.slug === 'risk')?.accepted).toBe(false);
  });

  it('refuses acceptance of a stale document version', async () => {
    await expect(
      service.accept(userId, 'risk', 'old', 'https://trade.example'),
    ).rejects.toMatchObject({ code: 'LEGAL_VERSION_CHANGED', status: 409 });
  });
});
