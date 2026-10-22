import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Poslovna greška sa stabilnim kodom. Klijenti se oslanjaju na `code`, ne na tekst poruke.
 * Format odgovora: { error: { code, message, details?, requestId } }
 */
export class AppError extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const NotFound = (what: string) => new AppError('NOT_FOUND', `${what} nije pronađen(a)`, HttpStatus.NOT_FOUND);
export const Conflict = (code: string, message: string, details?: unknown) =>
  new AppError(code, message, HttpStatus.CONFLICT, details);
export const Invalid = (code: string, message: string, details?: unknown) =>
  new AppError(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();
    const requestId = req.requestId;

    if (exception instanceof AppError) {
      return res.status(exception.getStatus()).json({
        error: { code: exception.code, message: exception.message, details: exception.details, requestId },
      });
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as any;
      const code =
        status === 401 ? 'UNAUTHORIZED' :
        status === 403 ? 'FORBIDDEN' :
        status === 404 ? 'NOT_FOUND' :
        status === 429 ? 'RATE_LIMITED' :
        status === 400 ? 'VALIDATION_FAILED' : 'HTTP_ERROR';
      const message = Array.isArray(body?.message) ? 'Neispravni ulazni podaci' : (body?.message ?? exception.message);
      const details = Array.isArray(body?.message) ? body.message : undefined;
      return res.status(status).json({ error: { code, message, details, requestId } });
    }

    // Kršenje ograničenja baze → 409 sa jasnim kodom (bez izlaganja SQL detalja).
    // Drizzle umotava grešku drajvera u `cause` — tražimo PostgreSQL kod u lancu.
    let pg = exception as { code?: string; constraint?: string; cause?: unknown };
    for (let i = 0; i < 3 && pg && !pg.code && pg.cause; i++) pg = pg.cause as typeof pg;
    if (pg?.code === '23505') {
      return res.status(409).json({ error: { code: 'DUPLICATE', message: 'Zapis sa istim jedinstvenim podacima već postoji', details: { constraint: pg.constraint }, requestId } });
    }
    if (pg?.code === '23514' || pg?.code === '23503') {
      return res.status(409).json({ error: { code: 'CONSTRAINT_VIOLATION', message: 'Operacija krši pravilo integriteta podataka', details: { constraint: pg.constraint }, requestId } });
    }

    this.logger.error(`[${requestId}] Neočekivana greška: ${(exception as Error)?.stack ?? exception}`);
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL', message: 'Neočekivana greška na serveru', requestId },
    });
  }
}
