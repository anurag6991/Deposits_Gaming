/**
 * Error codes shared by the API and the UI.
 *
 * The API returns a code plus a human message. The UI may map a code to better
 * wording or an action, but must never need to parse the message text. Internal
 * details (SQL, stack traces, constraint names) never reach the client.
 */

export const ERROR_CODES = {
  // auth
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  ACCOUNT_DISABLED: 'This account has been disabled.',
  ACCOUNT_LOCKED: 'Too many failed attempts. Try again later.',
  SESSION_EXPIRED: 'Your session has expired. Please sign in again.',
  UNAUTHENTICATED: 'You need to sign in to do that.',
  FORBIDDEN: 'You do not have permission to do that.',
  PASSWORD_CHANGE_REQUIRED: 'You must change your password before continuing.',

  // validation
  VALIDATION_FAILED: 'Some of the information provided is not valid.',
  NOT_FOUND: 'That item could not be found.',

  // tasks and data
  NO_TEST_DATA: 'No eligible test data is currently available for this offer.',
  TIMER_ACTIVE: 'This offer is not available yet. Please wait for the timer.',
  TARGET_REACHED: 'The monthly target for this offer has already been met.',
  OFFER_NOT_ACTIVE: 'This offer is not currently active.',
  OFFER_EXPIRED: 'This offer has expired. Ask an admin to extend it.',
  NOT_ASSIGNED: 'You are not assigned to this offer.',
  TASK_ALREADY_OPEN: 'You already have a task in progress. Finish or cancel it first.',
  TASK_NOT_OPEN: 'That task is no longer open.',
  TASK_EXPIRED: 'That task timed out and the test data was returned to the pool.',

  // deposits and money
  INSUFFICIENT_BALANCE: 'The withdrawal is larger than the recorded balance.',
  INVALID_AMOUNT: 'Amount must be greater than zero.',
  DEPOSIT_COMPLETED: 'This deposit is marked completed and can no longer be changed.',

  // imports
  UPLOAD_TOO_LARGE: 'That file is too large.',
  UNSUPPORTED_FILE_TYPE: 'Only CSV and XLSX files can be uploaded.',
  IMPORT_NOT_PENDING: 'That import has already been completed or cancelled.',
  NO_VALID_ROWS: 'The file contained no valid rows to import.',

  // generic
  RATE_LIMITED: 'Too many requests. Please slow down.',
  CONFLICT: 'That change conflicts with the current state. Refresh and try again.',
  INTERNAL: 'Something went wrong. The issue has been logged.',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ApiErrorBody {
  success: false;
  code: ErrorCode;
  message: string;
  /** Field-level detail, only for VALIDATION_FAILED. */
  fields?: Record<string, string>;
}

export interface ApiSuccessBody<T> {
  success: true;
  data: T;
}
