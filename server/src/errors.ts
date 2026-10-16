export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 422,
  ) {
    super(message);
  }
}
