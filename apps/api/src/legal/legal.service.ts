import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  LegalAcceptanceStatus,
  LegalDocument,
  LegalDocumentSlug,
  LegalDocumentSummary,
} from '@0dtetrader/shared-types';
import { errors, isUniqueViolation } from '../common/api-exception';
import { PrismaService } from '../prisma/prisma.service';

export const LEGAL_VERSION = '2026-08-05';
const DOCUMENTS: ReadonlyArray<{
  slug: LegalDocumentSlug;
  title: string;
  requiresAcceptance: boolean;
}> = [
  { slug: 'about', title: 'About 0dteTrader', requiresAcceptance: false },
  { slug: 'terms', title: 'Terms and Conditions', requiresAcceptance: true },
  { slug: 'privacy', title: 'Privacy Policy', requiresAcceptance: false },
  { slug: 'risk', title: 'Options Trading Risk Disclosure', requiresAcceptance: true },
  { slug: 'open-source-licenses', title: 'Open-Source Licenses', requiresAcceptance: false },
];

@Injectable()
export class LegalService {
  private readonly markdown = new Map<LegalDocumentSlug, string>();

  constructor(private readonly prisma: PrismaService) {}

  summaries(origin: string): LegalDocumentSummary[] {
    return DOCUMENTS.map((document) => ({
      ...document,
      version: LEGAL_VERSION,
      publicUrl:
        document.slug === 'privacy'
          ? `${origin}/v1/legal/privacy-policy`
          : `${origin}/v1/legal/${document.slug}`,
    }));
  }

  document(slug: string, origin: string): LegalDocument {
    const summary = this.summaries(origin).find((candidate) => candidate.slug === slug);
    if (!summary) throw errors.notFound('LEGAL_DOCUMENT_NOT_FOUND', 'No such legal document');
    return { ...summary, markdown: this.read(summary.slug) };
  }

  async status(userId: string, origin: string): Promise<LegalAcceptanceStatus> {
    const accepted = await this.prisma.legalAcceptance.findMany({ where: { userId } });
    return {
      documents: this.summaries(origin).map((document) => {
        const row = accepted.find(
          (candidate) =>
            candidate.document === document.slug && candidate.version === document.version,
        );
        return {
          ...document,
          accepted: !document.requiresAcceptance || Boolean(row),
          acceptedAt: row?.acceptedAt.toISOString() ?? null,
        };
      }),
    };
  }

  async accept(
    userId: string,
    document: 'terms' | 'risk',
    version: string,
    origin: string,
  ): Promise<LegalAcceptanceStatus> {
    if (version !== LEGAL_VERSION) {
      throw errors.conflict(
        'LEGAL_VERSION_CHANGED',
        'This document changed; review the current version before accepting',
      );
    }
    try {
      await this.prisma.legalAcceptance.create({ data: { userId, document, version } });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    return this.status(userId, origin);
  }

  privacyHtml(origin: string): string {
    const document = this.document('privacy', origin);
    const escaped = document.markdown
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>0dteTrader Privacy Policy</title><style>body{max-width:760px;margin:40px auto;padding:0 20px;background:#0b0f17;color:#e8edf6;font:16px/1.6 system-ui,sans-serif}pre{white-space:pre-wrap;font:inherit}a{color:#38bdf8}</style></head><body><pre>${escaped}</pre></body></html>`;
  }

  private read(slug: LegalDocumentSlug): string {
    const cached = this.markdown.get(slug);
    if (cached) return cached;
    const candidates = [
      resolve(process.cwd(), 'docs', 'legal', `${slug}.md`),
      resolve(process.cwd(), '..', '..', 'docs', 'legal', `${slug}.md`),
    ];
    const path = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
    const value = readFileSync(path, 'utf8');
    this.markdown.set(slug, value);
    return value;
  }
}
