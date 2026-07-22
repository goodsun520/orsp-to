import type { Response } from 'express';

/** Mirrors the standard ORSP error codes/status pairs from SPECIFICATION.md. */
export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  retryable = false,
): void {
  res.status(status).set('Cache-Control', 'no-store').json({
    error: { code, message, retryable },
  });
}

export const notFound = (res: Response, message = 'Unknown route') =>
  sendError(res, 404, 'ROUTE_NOT_FOUND', message);

export const invalidParameter = (res: Response, message: string) =>
  sendError(res, 400, 'INVALID_PARAMETER', message);

export const bookNotFound = (res: Response) =>
  sendError(res, 404, 'BOOK_NOT_FOUND', 'Unknown book ID');

export const chapterNotFound = (res: Response) =>
  sendError(res, 404, 'CHAPTER_NOT_FOUND', 'Unknown chapter ID');

export const internalError = (res: Response, message = 'Unexpected source error') =>
  sendError(res, 500, 'INTERNAL_ERROR', message, true);

export const unavailable = (res: Response, message: string) =>
  sendError(res, 503, 'UNAVAILABLE', message, true);

export const methodNotAllowed = (res: Response) => {
  res.set('Allow', 'GET, OPTIONS');
  sendError(res, 405, 'METHOD_NOT_ALLOWED', 'This endpoint only supports GET.');
};
