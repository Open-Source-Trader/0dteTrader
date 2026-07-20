import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * An HttpException whose response body carries a machine-readable `code`,
 * rendered by the global filter as `{ error: { code, message } }`.
 */
export class ApiException extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly code: string,
    message: string,
  ) {
    super({ code, message }, status);
  }
}

export const errors = {
  validation: (message: string) =>
    new ApiException(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', message),
  unauthorized: (code: string, message: string) =>
    new ApiException(HttpStatus.UNAUTHORIZED, code, message),
  forbidden: (code: string, message: string) =>
    new ApiException(HttpStatus.FORBIDDEN, code, message),
  notFound: (code: string, message: string) =>
    new ApiException(HttpStatus.NOT_FOUND, code, message),
  conflict: (code: string, message: string) => new ApiException(HttpStatus.CONFLICT, code, message),
  badRequest: (code: string, message: string) =>
    new ApiException(HttpStatus.BAD_REQUEST, code, message),
  unavailable: (code: string, message: string) =>
    new ApiException(HttpStatus.SERVICE_UNAVAILABLE, code, message),
};

/** True for Prisma P2002 unique-constraint violations (and test fakes). */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
