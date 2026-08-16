export type SessionErrorCode =
  | "INVALID_SESSION_ID"
  | "SESSION_EXISTS"
  | "SESSION_NOT_FOUND"
  | "SESSION_CLOSED"
  | "CORRUPT_EVENT_LOG"
  | "UNSUPPORTED_SESSION_VERSION"
  | "INCOMPATIBLE_TASK"
  | "INCOMPATIBLE_WORKSPACE"
  | "REWIND_POINT_NOT_FOUND"
  | "UNSAFE_RESUME";

export class SessionError extends Error {
  readonly code: SessionErrorCode;

  constructor(
    code: SessionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SessionError";
    this.code = code;
  }
}
