import bcrypt from 'bcryptjs';
import { createHmac } from 'crypto';

const BCRYPT_ROUNDS = 12;

export const hashSecret = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS);
export const verifySecret = (plain: string, hash: string | null | undefined) =>
  hash ? bcrypt.compare(plain, hash) : Promise.resolve(false);

/** Deterministički HMAC PIN-a — za pretragu po PIN-u bez čuvanja samog PIN-a. */
export const pinLookup = (pin: string, pepper: string) => createHmac('sha256', pepper).update(pin).digest('hex');
