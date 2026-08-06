import { ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { AutoCandidatesDto, AUTO_CANDIDATES_VALIDATION_PIPE } from './auto-candidates.dto';

const metadata: ArgumentMetadata = { type: 'body', metatype: AutoCandidatesDto };

describe('AutoCandidatesDto', () => {
  it('accepts a normalized rank request', async () => {
    await expect(
      (AUTO_CANDIDATES_VALIDATION_PIPE as ValidationPipe).transform(
        { underlying: 'spx', expiration: '2026-08-05', optionType: 'call' },
        metadata,
      ),
    ).resolves.toMatchObject({
      underlying: 'spx',
      expiration: '2026-08-05',
      optionType: 'call',
    });
  });

  it.each([
    { underlying: '../SPX', expiration: '2026-08-05', optionType: 'call' },
    { underlying: 'SPX', expiration: 'tomorrow', optionType: 'call' },
    { underlying: 'SPX', expiration: '2026-08-05', optionType: 'straddle' },
    { underlying: 'SPX', expiration: '2026-08-05', optionType: 'call', spot: 6000 },
  ])('rejects invalid or client-authoritative rank input %#', async (value) => {
    await expect(
      (AUTO_CANDIDATES_VALIDATION_PIPE as ValidationPipe).transform(value, metadata),
    ).rejects.toMatchObject({ status: 400 });
  });
});
