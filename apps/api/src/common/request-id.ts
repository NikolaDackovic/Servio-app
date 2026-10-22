import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

/** Korelacioni ID: prihvata X-Request-Id (ako je razuman) ili generiše novi; vraća ga u odgovoru. */
export function requestIdMiddleware(req: Request & { requestId?: string }, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  const id = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
