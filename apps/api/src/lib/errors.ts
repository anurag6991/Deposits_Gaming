import { ERROR_CODES, type ErrorCode } from '@deposits/shared';

/**
 * The only error type handlers should throw.
 *
 * Carries a shared error code so the UI can react to a stable identifier rather
 * than parsing message text. The message shown to the user comes from the shared
 * ERROR_CODES table, so wording stays consistent across every endpoint.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields: Record<string, string> | undefined;
  /** Detail for the log only. Never serialised to the client. */
  readonly internal: unknown;

  constructor(
    code: ErrorCode,
    options: {
      status?: number;
      message?: string;
      fields?: Record<string, string>;
      internal?: unknown;
    } = {},
  ) {
    super(options.message ?? ERROR_CODES[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.fields = options.fields;
    this.internal = options.internal;
    Error.captureStackTrace?.(this, AppError);
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHENTICATED':
    case 'SESSION_EXPIRED':
    case 'INVALID_CREDENTIALS':
      return 401;
    case 'FORBIDDEN':
    case 'ACCOUNT_DISABLED':
    case 'PASSWORD_CHANGE_REQUIRED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
    case 'TASK_ALREADY_OPEN':
    case 'DEPOSIT_COMPLETED':
      return 409;
    case 'VALIDATION_FAILED':
    case 'INVALID_AMOUNT':
    case 'INSUFFICIENT_BALANCE':
    case 'UNSUPPORTED_FILE_TYPE':
    case 'IMPORT_NOT_PENDING':
    case 'NO_VALID_ROWS':
      return 422;
    case 'UPLOAD_TOO_LARGE':
      return 413;
    case 'ACCOUNT_LOCKED':
    case 'RATE_LIMITED':
      return 429;
    case 'INTERNAL':
      return 500;
    // Business-rule refusals: the request was well formed, the state says no.
    case 'NO_TEST_DATA':
    case 'TIMER_ACTIVE':
    case 'TARGET_REACHED':
    case 'OFFER_NOT_ACTIVE':
    case 'OFFER_EXPIRED':
    case 'NOT_ASSIGNED':
    case 'TASK_NOT_OPEN':
    case 'TASK_EXPIRED':
      return 409;
    default:
      return 400;
  }
}

export const notFound = () => new AppError('NOT_FOUND');
export const forbidden = () => new AppError('FORBIDDEN');
