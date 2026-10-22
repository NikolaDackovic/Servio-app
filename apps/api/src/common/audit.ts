import { auditLogs } from '../db/schema';
import { DbOrTx } from '../db/db.module';
import { AuthUser } from './auth-context';

/**
 * Upis u revizijski trag. Poziva se UNUTAR iste transakcije kao i poslovna promena,
 * tako da promena i njen trag nastaju zajedno ili nijedno.
 * Nikada ne upisivati lozinke, PIN-ove, tokene ni tajne u `data`.
 */
export async function audit(
  tx: DbOrTx,
  user: Pick<AuthUser, 'organizationId' | 'userId'>,
  action: string,
  entity: string,
  entityId: string,
  data?: Record<string, unknown>,
  requestId?: string,
) {
  await tx.insert(auditLogs).values({
    organizationId: user.organizationId,
    userId: user.userId,
    action,
    entity,
    entityId,
    data: data ?? null,
    requestId: requestId ?? null,
  });
}
