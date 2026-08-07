import { Body, Controller, Get, Header, Headers, Param, Post } from '@nestjs/common';
import {
  LegalAcceptanceStatus,
  LegalDocument,
  LegalDocumentSummary,
} from '@0dtetrader/shared-types';
import { AuthenticatedUser, CurrentUser } from '../common/current-user.decorator';
import { Public } from '../common/public.decorator';
import { LegalAcceptanceDto } from './dto/legal-acceptance.dto';
import { LegalService } from './legal.service';

function origin(host: string | undefined, forwardedProto: string | undefined): string {
  const protocol = forwardedProto?.split(',')[0]?.trim() || 'https';
  return `${protocol}://${host ?? 'localhost'}`;
}

@Controller('legal')
export class PublicLegalController {
  constructor(private readonly legal: LegalService) {}

  @Public()
  @Get()
  list(
    @Headers('host') host?: string,
    @Headers('x-forwarded-proto') protocol?: string,
  ): LegalDocumentSummary[] {
    return this.legal.summaries(origin(host, protocol));
  }

  @Public()
  @Get('privacy-policy')
  @Header('content-type', 'text/html; charset=utf-8')
  privacyPolicy(
    @Headers('host') host?: string,
    @Headers('x-forwarded-proto') protocol?: string,
  ): string {
    return this.legal.privacyHtml(origin(host, protocol));
  }

  @Public()
  @Get(':slug')
  get(
    @Param('slug') slug: string,
    @Headers('host') host?: string,
    @Headers('x-forwarded-proto') protocol?: string,
  ): LegalDocument {
    return this.legal.document(slug, origin(host, protocol));
  }
}

@Controller('me/legal')
export class UserLegalController {
  constructor(private readonly legal: LegalService) {}

  @Get()
  status(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('host') host?: string,
    @Headers('x-forwarded-proto') protocol?: string,
  ): Promise<LegalAcceptanceStatus> {
    return this.legal.status(user.userId, origin(host, protocol));
  }

  @Post('accept')
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: LegalAcceptanceDto,
    @Headers('host') host?: string,
    @Headers('x-forwarded-proto') protocol?: string,
  ): Promise<LegalAcceptanceStatus> {
    return this.legal.accept(user.userId, dto.document, dto.version, origin(host, protocol));
  }
}
