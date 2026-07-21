import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BrokerageAuthorization,
  Snaptrade,
  UserIDandSecret,
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

@Injectable()
export class SnapTradeClient {
  private readonly logger = new Logger(SnapTradeClient.name);
  private readonly clientId: string;
  private readonly consumerKey: string;

  constructor(private readonly config: ConfigService) {
    this.clientId = config.get<string>('snaptrade.clientId') ?? '';
    this.consumerKey = config.get<string>('snaptrade.consumerKey') ?? '';
  }

  private sdk(mode: TradingMode): Snaptrade {
    const baseUrl =
      mode === 'practice'
        ? (this.config.get<string>('snaptrade.sandboxBaseUrl') ??
          'https://api.sandbox.snaptrade.com')
        : (this.config.get<string>('snaptrade.prodBaseUrl') ?? 'https://api.snaptrade.com');
    return new Snaptrade({
      clientId: this.clientId,
      consumerKey: this.consumerKey,
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

  private async call<T>(mode: TradingMode, fn: (sdk: Snaptrade) => Promise<T>): Promise<T> {
    try {
      return await fn(this.sdk(mode));
    } catch (err) {
      throw this.mapError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Auth / identity
  // -------------------------------------------------------------------------

  async registerUser(mode: TradingMode, userId: string): Promise<UserIDandSecret> {
    this.logger.log(`registerUser mode=${mode} userId=${userId}`);
    return this.call(mode, (sdk) =>
      sdk.authentication.registerSnapTradeUser({ userId }).then((r) => r.data),
    );
  }

  async authorize(
    mode: TradingMode,
    userId: string,
    userSecret: string,
    opts?: {
      brokerage?: string;
      immediateRedirect?: boolean;
      customRedirect?: string;
      reconnect?: string;
      connectionType?: 'read' | 'trade' | 'trade-if-available';
    },
  ): Promise<{ redirectUrl: string }> {
    const response = await this.call<{ redirectURI?: string }>(mode, (sdk) =>
      sdk.authentication
        .loginSnapTradeUser({
          userId,
          userSecret,
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
    userId: string,
    userSecret: string,
  ): Promise<BrokerageAuthorization[]> {
    return this.call(mode, (sdk) =>
      sdk.connections.listBrokerageAuthorizations({ userId, userSecret }).then((r) => r.data),
    );
  }

  async listConnectionAccounts(
    mode: TradingMode,
    userId: string,
    userSecret: string,
    authorizationId: string,
  ): Promise<Account[]> {
    return this.call(mode, (sdk) =>
      sdk.connections
        .listBrokerageAuthorizationAccounts({ authorizationId, userId, userSecret })
        .then((r) => r.data),
    );
  }

  async deleteConnection(
    mode: TradingMode,
    userId: string,
    userSecret: string,
    authorizationId: string,
  ): Promise<void> {
    await this.call(mode, (sdk) =>
      sdk.connections.removeBrokerageAuthorization({ authorizationId, userId, userSecret }),
    );
  }

  async refreshConnection(
    mode: TradingMode,
    userId: string,
    userSecret: string,
    authorizationId: string,
  ): Promise<BrokerageAuthorizationRefreshConfirmation> {
    return this.call(mode, (sdk) =>
      sdk.connections
        .refreshBrokerageAuthorization({ authorizationId, userId, userSecret })
        .then((r) => r.data),
    );
  }

  // -------------------------------------------------------------------------
  // Account data
  // -------------------------------------------------------------------------

  async getAllAccountPositions(
    mode: TradingMode,
    userId: string,
    userSecret: string,
    accountId: string,
  ): Promise<AllAccountPositionsResponse> {
    return this.call(mode, (sdk) =>
      sdk.accountInformation
        .getAllAccountPositions({ userId, userSecret, accountId })
        .then((r) => r.data),
    );
  }

  async getOpenOrders(
    mode: TradingMode,
    userId: string,
    userSecret: string,
    accountId: string,
  ): Promise<AccountOrderRecord[]> {
    return this.call(mode, (sdk) =>
      sdk.accountInformation
        .getUserAccountOrders({ userId, userSecret, accountId, state: 'open', days: 30 })
        .then((r) => r.data),
    );
  }

  // -------------------------------------------------------------------------
  // Trading — preview
  // -------------------------------------------------------------------------

  async previewEquityOrder(
    mode: TradingMode,
    userId: string,
    userSecret: string,
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
    return this.call(mode, (sdk) =>
      sdk.trading.getOrderImpact({ userId, userSecret, ...payload } as any).then((r) => r.data),
    );
  }

  async previewOptionOrder(
    mode: TradingMode,
    userId: string,
    userSecret: string,
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
    return this.call(mode, (sdk) =>
      sdk.trading
        .getOptionImpact({ userId, userSecret, accountId, ...payload } as any)
        .then((r) => r.data),
    );
  }

  // -------------------------------------------------------------------------
  // Trading — execute
  // -------------------------------------------------------------------------

  async placeEquityOrder(
    mode: TradingMode,
    userId: string,
    userSecret: string,
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
    return this.call(mode, (sdk) =>
      sdk.trading.placeForceOrder({ userId, userSecret, ...payload } as any).then((r) => r.data),
    );
  }

  async placeOptionOrder(
    mode: TradingMode,
    userId: string,
    userSecret: string,
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
    return this.call(mode, (sdk) =>
      sdk.trading
        .placeMlegOrder({ userId, userSecret, accountId, ...payload } as any)
        .then((r) => r.data),
    );
  }

  async cancelOrder(
    mode: TradingMode,
    userId: string,
    userSecret: string,
    accountId: string,
    brokerageOrderId: string,
  ): Promise<CancelOrderResponse> {
    return this.call(mode, (sdk) =>
      sdk.trading
        .cancelOrder({ userId, userSecret, accountId, brokerage_order_id: brokerageOrderId })
        .then((r) => r.data),
    );
  }

  // -------------------------------------------------------------------------
  // Quotes (per-account equity/option — not bulk chain)
  // -------------------------------------------------------------------------

  async getAccountQuotes(
    mode: TradingMode,
    userId: string,
    userSecret: string,
    accountId: string,
    symbols: string[],
  ): Promise<unknown> {
    return this.call(mode, (sdk) =>
      sdk.trading
        .getUserAccountQuotes({
          userId,
          userSecret,
          symbols: symbols.join(','),
          accountId,
          useTicker: false,
        })
        .then((r) => r.data),
    );
  }

  async getAccountOptionQuotes(
    mode: TradingMode,
    userId: string,
    userSecret: string,
    accountId: string,
    symbol: string,
  ): Promise<unknown> {
    return this.call(mode, (sdk) =>
      sdk.trading
        .getUserAccountOptionQuotes({ userId, userSecret, accountId, symbol })
        .then((r) => r.data),
    );
  }
}
