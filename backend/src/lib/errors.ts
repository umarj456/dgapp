export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message?: string, public details?: unknown) {
    super(message ?? code);
  }
}
