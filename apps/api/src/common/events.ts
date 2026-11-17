import { Global, Injectable, Module } from '@nestjs/common';

/**
 * Događaj u realnom vremenu. Objavljuje se TEK POSLE uspešnog commit-a transakcije
 * (servisi skupljaju događaje u transakciji i vraćaju ih; objava ide posle).
 * Klijenti (KDS, kasa) posle ponovnog povezivanja uvek ponovo učitaju stanje preko REST-a,
 * pa propušten događaj ne može da ostavi pogrešno stanje - WebSocket je samo "obaveštenje".
 */
export interface RealtimeEvent {
  type: string;
  locationId: string;
  /** Ako je postavljeno, događaj ide samo pretplatnicima te pripremne pozicije (i opštim pretplatnicima lokala). */
  stationId?: string | null;
  data: Record<string, unknown>;
}

type Listener = (e: RealtimeEvent) => void;

@Injectable()
export class EventBus {
  private listeners = new Set<Listener>();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  publish(e: RealtimeEvent) {
    for (const l of this.listeners) {
      try { l(e); } catch { /* slušalac ne sme da obori objavu */ }
    }
  }

  publishAll(list: RealtimeEvent[] | undefined) {
    for (const e of list ?? []) this.publish(e);
  }
}

@Global()
@Module({ providers: [EventBus], exports: [EventBus] })
export class EventsModule {}
