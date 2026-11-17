/** Program (Electron) ili pregledač: "Promeni server" ima smisla samo u programu Servio. */
const DESKTOP = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);
const host = () => (typeof location !== 'undefined' ? location.host : '');
const local = () => /^(localhost|127\.0\.0\.1)(:|$)/.test(host());

/**
 * Na koji server (glavnu kasu) je ADMIN povezan. Na glavnoj kasi: "ovaj računar"; na drugom računaru: IP adresa
 * glavne kase. U programu dugme "Promeni server" (dodatni računar se ponovo povezuje na glavnu kasu).
 */
export function ServerInfo({ compact }: { compact?: boolean }) {
  const where = local() ? 'ovaj računar (glavna kasa)' : host();
  return (
    <div className={compact ? 'srv-chip' : 'srv-info'} title={`Server: ${host()}\nADMIN sa drugog računara: instalirajte Servio i izaberite „Povezivanje na glavnu kasu“ (IP adresa glavne kase), ili u pregledaču otvorite http://<IP glavne kase>:<port>/admin`}>
      <span className="srv-dot" aria-hidden />{compact ? host() : <>Server: <b>{where}</b></>}
      {DESKTOP && !compact && <button type="button" className="link" onClick={() => window.open('servio://reconnect')}>Promeni server</button>}
    </div>
  );
}
