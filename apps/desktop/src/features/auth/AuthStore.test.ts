import type { LegalDocument, LegalDocumentSummary } from '@0dtetrader/shared-types';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../core/api/ApiClient';
import type { SessionStore } from '../../core/api/SessionStore';
import type { QuoteSocket } from '../../core/api/QuoteSocket';
import type { SettingsStore } from '../../core/storage/SettingsStore';
import { AuthStore } from './AuthStore';

const summaries: LegalDocumentSummary[] = [
  {
    slug: 'terms',
    title: 'Terms and Conditions',
    version: '2026-08-05',
    publicUrl: 'https://api.example.test/v1/legal/terms',
    requiresAcceptance: true,
  },
  {
    slug: 'risk',
    title: 'Options Trading Risk Disclosure',
    version: '2026-08-05',
    publicUrl: 'https://api.example.test/v1/legal/risk',
    requiresAcceptance: true,
  },
];

const documents: LegalDocument[] = summaries.map((summary) => ({
  ...summary,
  markdown: `# ${summary.title}`,
}));

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(options: { legalFailure?: Error } = {}) {
  let accepted = false;
  const api = {
    legalStatus: vi.fn(async () => {
      if (options.legalFailure) throw options.legalFailure;
      return {
        documents: summaries.map((summary) => ({
          ...summary,
          accepted,
          acceptedAt: accepted ? '2026-08-05T12:00:00.000Z' : null,
        })),
      };
    }),
    legalDocument: vi.fn(async (slug: LegalDocument['slug']) => {
      const document = documents.find((candidate) => candidate.slug === slug);
      if (!document) throw new Error('missing fixture');
      return document;
    }),
    acceptLegal: vi.fn(async () => {
      accepted = true;
      return { documents: [] };
    }),
  };
  const session = {
    onUnauthenticated: vi.fn(() => () => undefined),
    restoreSession: vi.fn(async () => ({ status: 'authenticated' as const })),
    signIn: vi.fn(),
    signOut: vi.fn(async () => undefined),
  };
  const socket = { connect: vi.fn(), disconnect: vi.fn() };
  const settings = {
    hasAcceptedRiskDisclaimer: true,
    hasCompletedServerSelection: true,
  };
  const store = new AuthStore(
    api as unknown as ApiClient,
    session as unknown as SessionStore,
    settings as unknown as SettingsStore,
    socket as unknown as QuoteSocket,
  );
  return { api, session, socket, store };
}

describe('AuthStore legal gate', () => {
  it('keeps the socket disconnected until both required documents are accepted', async () => {
    const { api, socket, store } = harness();

    await store.start();
    await flush();

    expect(store.getState().state).toBe('legal');
    expect(
      store
        .getState()
        .legalDocuments.map((document) => document.slug)
        .sort(),
    ).toEqual(['risk', 'terms']);
    expect(socket.connect).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalled();

    await store.acceptRequiredLegal();

    expect(api.acceptLegal).toHaveBeenCalledTimes(2);
    expect(store.getState().state).toBe('authenticated');
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('fails closed when current acceptance cannot be verified', async () => {
    const { socket, store } = harness({ legalFailure: new Error('backend unavailable') });

    await store.start();
    await flush();

    expect(store.getState().state).toBe('startupRecovery');
    expect(store.getState().startupRecovery?.title).toBe('Cannot verify required disclosures');
    expect(socket.connect).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalled();
  });
});
