import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BrokerageAuthorization,
  Snaptrade,
  SnaptradeAuth,
  AccountOrderRecord,
  AllAccountPositionsResponse,
  OptionImpact,
  ManualTradeAndImpact,
  CancelOrderResponse,
  MlegOrderResponse,
  Account,
  BrokerageAuthorizationRefreshConfirmation,
} from 'snaptrade-typescript-sdk';
import { TradingMode } from '@0dtetrader/shared-types';
import { brokerErrors } from '../../common/broker-error';
import { SnaptradeError } from 'snaptrade-typescript-sdk';

const SNAPTRADE_ERROR_CODES: Record<number, string> = {
  400: 'SNAPTRADE_BAD_REQUEST',
  401: 'SNAPTRADE_AUTH_FAILED',
  403: 'SNAPTRADE_FORBIDDEN',
  404: 'SNAPTRADE_NOT_FOUND',
  429: 'SNAPTRADE_RATE_LIMITED',
  500: 'SNAPTRADE_SERVER_ERROR',
  503: 'SNAPTRADE_UNAVAILABLE',
};

/**
 * Wraps the SnapTrade SDK under **Personal API key** auth (docs.snaptrade.com/docs/personal-vs-commercial):
 * every call authenticates with the end user's own `clientId`/`consumerKey` —
 * there is no server-side integrator identity and no app-managed `userId`/
 * `userSecret`. SnapTrade resolves "which user" purely from which key signed
 * the request, so every method here takes the caller's own key pair.
 */
@Injectable()
export class SnapTradeClient {
  private readonly logger = new Logger(SnapTradeClient.name);

  constructor(private readonly config: ConfigService) {}

  private sdk(mode: TradingMode, clientId: string, consumerKey: string): Snaptrade<any> {
    if (!clientId || !consumerKey) {
      throw brokerErrors.authFailed(
        'No SnapTrade credentials — save your Personal client ID/consumer key in Profile first',
      );
    }
    const baseUrl =
      mode === 'practice'
        ? (this.config.get<string>('snaptrade.sandboxBaseUrl') ??
          'https://api.sandbox.snaptrade.com')
        : (this.config.get<string>('snaptrade.prodBaseUrl') ?? 'https://api.snaptrade.com');
    return new Snaptrade({
      auth: SnaptradeAuth.personalApiKey({ clientId, consumerKey }),
      basePath: baseUrl,
    });
  }

  private mapError(err: unknown): Error {
    if (err instanceof SnaptradeError) {
      const code = SNAPTRADE_ERROR_CODES[err.status ?? 500] ?? 'SNAPTRADE_ERROR';
      return new Error(`${code}: ${err.message} (${err.status ?? 'network'})`);
    }
    if (err instanceof Error) return err;
    return new Error(`SnapTrade request failed: ${String(err)}`);
  }

  private async call<T>(
    mode: TradingMode,
    clientId: string,
    consumerKey: string,
    fn: (sdk: Snaptrade<any>) => Promise<T>,
  ): Promise<T> {
    try {
      return await fn(this.sdk(mode, clientId, consumerKey));
    } catch (err) {
      throw this.mapError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Auth / connection portal
  // -------------------------------------------------------------------------

  async authorize(
    mode: TradingMode,
    clientId: string,
    consumerKey: string,
    opts?: {
      brokerage?: string;
      immediateRedirect?: boolean;
      customRedirect?: string;
      reconnect?: string;
      connectionType?: 'read' | 'trade' | 'trade-if-available';
    },
  ): Promise<{ redirectUrl: string }> {
    const response = await this.call<{ redirectURI?: string }>(mode, clientId, consumerKey, (sdk) =>
      sdk.authentication
        .loginSnapTradeUser({
          broker: opts?.brokerage,
          immediateRedirect: opts?.immediateRedirect,
          customRedirect: opts?.customRedirect,
          reconnect: opts?.reconnect,
          connectionType: opts?.connectionType ?? 'trade',
        })
        .then((r) => {
          const data = r.data;
          if ('redirectURI' in data) return data as { redirectURI?: string };
          throw new Error('SnapTrade returned an encrypted response instead of a redirect URI');
        }),
    );
    return { redirectUrl: response.redirectURI ?? '' };
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  async listConnections(
    mode: TradingMode,
    clientId: string,
    consumerKey: string,
  ): Promise<BrokerageAuthorization[]> {
    return this.call(mode, clientId, consumerKey, (sdk) =>
      sdk.connections.listBrokerageAuthorizations({}).then((r) => r.data),
    );
  }

  async listConnectionAccounts(
    mode: TradingMode,
    clientId: string,
    consumerKey: string,
    authorizationId: string,
  ): Promise<Account[]> {
    return this.call(mode, clientId, consumerKey, (sdk) =>
      sdk.connections.listBrokerageAuthorizationAccounts({ authorizationId }).then((r) => r.data),
    );
  }

  async deleteConnection(
    mode: TradingMode,
    clientId: string,
    consumerKey: string,
    authorizationId: string,
  ): Promise<void> {
    await this.call(mode, clientId, consumerKey, (sdk) =>
      sdk.connections.removeBrokerageAuthorization({ authorizationId }),
    );
  }

  async refreshConnection(
    mode: TradingMode,
    clientId: string,
    consumerKey: string,
    authorizationId: string,
  ): Promise<BrokerageAuthorizationRefreshConfirmation> {
    return this.call(mode, clientId, consumerKey, (sdk) =>
      sdk.connections.refreshBrokerageAuthorization({ authorizationId }).then((r) => r.data),
    );
  }

  // -------------------------------------------------------------------------
  // Account data
  // -------------------------------------------------------------------------

  async getAllAccountPositions(
    mode: TradingMode,
    clientId: string,
    consumerKey: string,
    accountId: string,
  ): Promise<AllAccountPositionsResponse> {
    return this.call(mode, clientId, consumerKey, (sdk) =>
      sdk.accountInformation.getAllAccountPositions({ accountId }).then((r) => r.data),
    );
  }

  async getOpenOrders(
    mode: TradingMode,
    clientId: string,
    consumerKey: string,
    accountId: string,
  ): Promise<AccountOrderRecord[]> {
    return this.call(mode, clientId, consumerKey, (sdk) =>
      sdk.accountInformation
        .getUserAccountOrders({ accountId, state: 'open', days: 30 })
        .then((r) => r.data),
    );
  }

  // -------------------------------------------------------------------------
  // Trading — preview
  // -------------------------------------------------------------------------

  async previewEquityOrder(
    mode: TradingMode,
    clientId: string,
    consumerKey: string,
    payload: {
      account_id: string;
      action: 'BUY' | 'SELL';
      symbol: string;
      order_type: 'Market' | 'Limit';
      time_in_force: 'Day' | 'GTC';
      units: number;
      price?: number | null;
      universal_symbol_id: null;
    },
  ): Promise<ManualTradeAndImpact> {
    return this.call(mode, clientId, consumerKey, (sdk) =>
      sdk.trading.getOrderImpact({ ...payload } as any).then((r) => r.data),
    );
  }

  async previewOptionOrder(
    mode: TradingMode,
    clientId: string,
    consumerKey: string,
    accountId: string,
    payload: {
      order_type: 'MARKET' | 'LIMIT';
      time_in_force: 'Day' | 'GTC';
      limit_price?: string | null;
      price_effect?: 'DEBIT' | 'CREDIT' | 'EVEN';
      legs: {
        instrument: { symbol: string; instrument_type: 'OPTION' | 'EQUITY' };
        action: 'BUY' | 'SELL' | 'BUY_TO_OPEN' | 'BUY_TO_CLOSE' | 'SELL_TO_OPEN' | 'SELL_TO_CLOSE';
        units: number;
      }[];
    },
  ): Promise<OptionImpact> {
    return this.call(mode, clientId, consumerKey, (sdk) =>
      sdk.trading.getOptionImpact({ accountId, ...payload } as any).then((r) => r.data),
    );
  }

  // -------------------------------------------------------------------------
  // Trading — execute
  // -------------------------------------------------------------------------

  async placeEquityOrder(
    mode: TradingMode,
    clientId: string,
    consumerKey: string,
    payload: {
      account_id: string;
      action: 'BUY' | 'SELL';
      symbol: string;
      order_type: 'Market' | 'Limit';
      time_in_force: 'Day' | 'GTC';
      units: number;
      price?: number | null;
      client_order_id?: string | null;
      universal_symbol_id: null;
    },
  ): Promise<AccountOrderRecord> {
    return this.call(mode, clientId, consumerKey, (sdk) =>
      sdk.trading.placeForceOrder({ ...payload } as any).then((r) => r.data),
    );
  }

  async placeOptionOrder(
    mode: TradingMode,
    clientId: string,
    consumerKey: string,
    accountId: string,
    payload: {
      order_type: 'MARKET' | 'LIMIT';
      time_in_force: 'Day' | 'GTC';
      limit_price?: string | null;
      price_effect?: 'DEBIT' | 'CREDIT' | 'EVEN';
      legs: {
        instrument: { symbol: string; instrument_type: 'OPTION' | 'EQUITY' };
        action: 'BUY' | 'SELL' | 'BUY_TO_OPEN' | 'BUY_TO_CLOSE' | 'SELL_TO_OPEN' | 'SELL_TO_CLOSE';
        units: number;
      }[];
    },
  ): Promise<MlegOrderResponse> {
    return this.call(mode, clientId, consumerKey, (sdk) =>
      sdk.trading.placeMlegOrder({ accountId, ...payload } as any).then((r) => r.data),
    );
  }

  async cancelOrder(
    mode: TradingMode,
    clientId: string,
    consumerKey: string,
    accountId: string,
    brokerageOrderId: string,
  ): Promise<CancelOrderResponse> {
    return this.call(mode, clientId, consumerKey, (sdk) =>
      sdk.trading
        .cancelOrder({ accountId, brokerage_order_id: brokerageOrderId } as any)
        .then((r) => r.data),
    );
  }

  // -------------------------------------------------------------------------
  // Quotes (per-account equity/option — not bulk chain)
  // -------------------------------------------------------------------------

  async getAccountQuotes(
    mode: TradingMode,
    clientId: string,
    consumerKey: string,
    accountId: string,
    symbols: string[],
  ): Promise<unknown> {
    return this.call(mode, clientId, consumerKey, (sdk) =>
      sdk.trading
        .getUserAccountQuotes({
          symbols: symbols.join(','),
          accountId,
          useTicker: false,
        } as any)
        .then((r) => r.data),
    );
  }

  async getAccountOptionQuotes(
    mode: TradingMode,
    clientId: string,
    consumerKey: string,
    accountId: string,
    symbol: string,
  ): Promise<unknown> {
    return this.call(mode, clientId, consumerKey, (sdk) =>
      sdk.trading.getUserAccountOptionQuotes({ accountId, symbol } as any).then((r) => r.data),
    );
  }
}
