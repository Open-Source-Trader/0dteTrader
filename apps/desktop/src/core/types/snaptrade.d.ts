export interface DesktopSnapTradeConnectionRecord {
  connectionId: string;
  brokerage: string;
  name: string;
  type: string;
  status: 'active' | 'broken' | 'pending';
  accountIds: string[];
  selectedAccountId: string | null;
  createdAt: string;
}

export interface DesktopSnapTradeConnectionStatus {
  configured: boolean;
  selectedAccountId: string | null;
}

export interface DesktopSnapTradeConnectionsResponse {
  connections: DesktopSnapTradeConnectionRecord[];
  accounts: Record<string, { accountId: string; name: string }[]>;
  status: DesktopSnapTradeConnectionStatus;
}

export interface DesktopSnapTradeAuthorizeResponse {
  redirectUrl: string;
}

export interface DesktopSnapTradeSelectResponse {
  accountId: string;
}
