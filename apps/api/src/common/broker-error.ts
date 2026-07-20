/**
 * Error raised by broker gateways. The global exception filter renders it as
 * `{ error: { code, message } }` with the mapped HTTP status
 * (docs/WEBULL-INTEGRATION.md §6).
 */
export class BrokerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

export const brokerErrors = {
  authFailed: (message = 'Broker authentication failed') =>
    new BrokerError('BROKER_AUTH_FAILED', message, 401),
  insufficientBuyingPower: (message = 'Insufficient buying power') =>
    new BrokerError('INSUFFICIENT_BUYING_POWER', message, 400),
  orderRejected: (message = 'Order rejected') => new BrokerError('ORDER_REJECTED', message, 400),
  rateLimited: (message = 'Broker rate limit exceeded') =>
    new BrokerError('BROKER_RATE_LIMITED', message, 503),
  unavailable: (message = 'Broker is unreachable') =>
    new BrokerError('BROKER_UNAVAILABLE', message, 503),
  marketClosed: (message = 'Market is closed') => new BrokerError('MARKET_CLOSED', message, 400),
  orderNotFound: (orderId: string) =>
    new BrokerError('ORDER_NOT_FOUND', `Order not found: ${orderId}`, 404),
  orderNotOpen: (orderId: string, status: string) =>
    new BrokerError(
      'ORDER_NOT_OPEN',
      `Order ${orderId} cannot be cancelled in status ${status}`,
      400,
    ),
  contractNotFound: (message: string) => new BrokerError('CONTRACT_NOT_FOUND', message, 400),
  /** Market-data quote subscription missing on the Webull app (not an auth
   *  failure — 403 so clients don't treat it as session expiry). */
  permissionDenied: (message: string) => new BrokerError('BROKER_PERMISSION_DENIED', message, 403),
};
