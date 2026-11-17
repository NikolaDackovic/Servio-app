import { FormEvent, useRef, useState } from 'react';
import { api, storage } from '@shared/api';
import { ErrorBox, Modal, Spinner, useLoad, useToast } from '@shared/ui';
import { NameDialog } from './TableMap';
import { Column, DataTable } from './DataTable';

interface Role { id: string; code: string; name: string; permissions: string[]; users: number }
interface User { id: string; firstName: string; lastName: string; fullName: string; username: string | null; email: string | null; roleId: string; roleName: string; active: boolean; hasPin: boolean; hasPassword: boolean; hasCard?: boolean }
interface Perm { code: string; group: string; label: string }

/** Preuzimanje fajla sa API-ja (izvoz u Excel/CSV) uz token prijavljenog korisnika. */
export async function download(path: string, fileName: string) {
  const res = await fetch(`/api/v1${path}`, { headers: { Authorization: `Bearer ${storage.token}` } });
  if (!res.ok) throw new Error(`Izvoz nije uspeo (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = fileName; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const toBase64 = (f: File) => new Promise<string>((ok, fail) => {
  const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => fail(r.error); r.readAsDataURL(f);
});

/** Traka za Excel: izvoz (XLSX/CSV) i uvoz fajla; greške uvoza po redovima. */
export function ExcelBar({ exportPath, fileBase, importPath, onImported }: { exportPath: string; fileBase: string; importPath: string; onImported: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ row: number; message: string }[] | null>(null);
  const pick = async (f?: File) => {
    if (!f) return;
    setBusy(true); setErrors(null);
    try {
      const r = await api('POST', importPath, { fileName: f.name, contentBase64: await toBase64(f) });
      toast('ok', `Uvezeno: novih ${r.created}, izmenjenih ${r.updated}`); onImported();
    } catch (e: any) {
      if (e.details?.errors) setErrors(e.details.errors); else toast('err', e.message);
    } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  return (
    <>
      <div className="excel-bar">
        <button className="btn sm" onClick={() => download(`${exportPath}?format=xlsx`, `${fileBase}.xlsx`).catch((e) => toast('err', e.message))}>⭳ Izvoz u Excel</button>
        <button className="btn sm" onClick={() => download(`${exportPath}?format=csv`, `${fileBase}.csv`).catch((e) => toast('err', e.message))}>CSV</button>
        <button className="btn sm" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uvozim…' : '⭱ Uvoz iz Excel-a'}</button>
        <input ref={input} type="file" accept=".xlsx,.csv" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      </div>
      {errors && (
        <div className="card import-errors">
          <h3>Uvoz nije izvršen: {errors.length} redova sa greškom (ništa nije upisano)</h3>
          <table className="tbl"><tbody>{errors.map((e) => <tr key={e.row}><td>Red {e.row}</td><td>{e.message}</td></tr>)}</tbody></table>
          <button className="btn sm" onClick={() => setErrors(null)}>Zatvori</button>
        </div>
      )}
    </>
  );
}

/** Korisnici: ime, prezime, korisničko ime, šifra za kasu (PIN), lozinka za ADMIN, uloga, aktivan. */
export function Users() {
  const list = useLoad(() => api<User[]>('GET', '/users'), []);
  const roles = useLoad(() => api<Role[]>('GET', '/roles'), []);
  const [edit, setEdit] = useState<User | 'new' | null>(null);
  const columns: Column<User>[] = [
    { key: 'name', label: 'Ime i prezime', value: (u) => u.fullName, render: (u) => <strong>{u.fullName}</strong> },
    { key: 'username', label: 'Korisničko ime', value: (u) => u.username ?? '' },
    { key: 'email', label: 'Email', value: (u) => u.email ?? '' },
    { key: 'role', label: 'Uloga', value: (u) => u.roleName, filter: 'select' },
    { key: 'pin', label: 'Šifra (kasa)', value: (u) => (u.hasPin ? 'da' : 'ne'), filter: 'select' },
    { key: 'card', label: 'Kartica', value: (u) => (u.hasCard ? 'da' : 'ne'), filter: 'select' },
    { key: 'pass', label: 'Lozinka (ADMIN)', value: (u) => (u.hasPassword ? 'da' : 'ne'), filter: 'select' },
    { key: 'active', label: 'Status', value: (u) => (u.active ? 'Aktivan' : 'Neaktivan'), filter: 'select',
      render: (u) => (u.active ? <span className="badge paid">Aktivan</span> : <span className="badge cancelled">Neaktivan</span>) },
  ];
  return (
    <div className="page">
      <div className="toolbar">
        <span className="muted">Zaposleni: šifra (PIN) ili kartica za kasu, lozinka za ADMIN.</span>
        <button className="btn primary" onClick={() => setEdit('new')} disabled={!roles.data}>+ Korisnik</button>
      </div>
      <ExcelBar exportPath="/users/export" fileBase="korisnici" importPath="/users/import" onImported={list.reload} />
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : (
        <DataTable columns={columns} rows={list.data ?? []} rowKey={(u) => u.id} onRowClick={setEdit} rowClass={(u) => (u.active ? undefined : 'inactive')} empty="Nema korisnika." />
      )}
      {edit && roles.data && <UserForm user={edit === 'new' ? null : edit} roles={roles.data} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
    </div>
  );
}

function UserForm({ user, roles, onClose, onSaved }: { user: User | null; roles: Role[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    firstName: user?.firstName ?? '', lastName: user?.lastName ?? '', username: user?.username ?? '', email: user?.email ?? '',
    roleId: user?.roleId ?? roles.find((r) => r.code === 'WAITER')?.id ?? roles[0]?.id, pin: '', password: '', active: user?.active ?? true,
  });
  // kartica: '' = bez promene, broj = nova kartica, null = ukloni
  const [card, setCard] = useState<string | null>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    const body: any = { firstName: f.firstName.trim(), lastName: f.lastName.trim(), username: f.username.trim().toLowerCase(), roleId: f.roleId };
    if (f.email.trim()) body.email = f.email.trim(); else if (user?.email) body.email = null;
    if (f.pin) body.pin = f.pin;
    if (f.password) body.password = f.password;
    if (card === null) body.card = null; else if (card.trim()) body.card = card.trim();
    try {
      if (user) await api('PATCH', `/users/${user.id}`, { ...body, active: f.active });
      else await api('POST', '/users', body);
      toast('ok', 'Korisnik sačuvan'); onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={user ? `Korisnik: ${user.fullName}` : 'Novi korisnik'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="grid2 tight">
          <label>Ime<input className="input" value={f.firstName} required maxLength={60} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></label>
          <label>Prezime<input className="input" value={f.lastName} maxLength={60} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></label>
        </div>
        <label>Korisničko ime<input className="input" value={f.username} required maxLength={40} placeholder="npr. marko" onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase().replace(/\s/g, '') })} /></label>
        <label>Uloga<select className="input" value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <div className="grid2 tight">
          <label>Šifra za kasu (PIN, 1-10 cifara){user?.hasPin && <small className="muted">prazno = bez promene</small>}
            <input className="input" inputMode="numeric" value={f.pin} maxLength={10} placeholder={user?.hasPin ? '••••' : ''} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} /></label>
          <label>Lozinka za ADMIN (opciono){user?.hasPassword && <small className="muted">prazno = bez promene</small>}
            <input className="input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        </div>
        <label>Kartica (čitač kartica){user?.hasCard && card === '' && <small className="ok-text"> ✓ kartica je dodeljena</small>}
          <span className="row gap">
            <input className="input" value={card ?? ''} disabled={card === null} placeholder={card === null ? 'kartica će biti uklonjena' : 'kliknite ovde i prislonite karticu na čitač'}
              onChange={(e) => setCard(e.target.value.replace(/[^0-9A-Za-z]/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); /* čitač završava Enter-om - ne šalje formu */ }} />
            {user?.hasCard && <button type="button" className="btn sm danger-ghost" onClick={() => setCard(card === null ? '' : null)}>{card === null ? 'Vrati' : 'Ukloni karticu'}</button>}
          </span>
          <small className="muted">Zaposleni se prijavljuje na kasu prislanjanjem kartice umesto kucanja šifre (i za sto, storno, kraj dana).</small></label>
        <label>Email (opciono)<input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        {user && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Aktivan (neaktivan ne može da se prijavi)</label>}
        {error !== undefined && <ErrorBox error={error} />}
        <div className="modal-actions">
          <button className="btn primary" disabled={busy}>{busy ? 'Čuvam…' : 'Sačuvaj'}</button>
          <button type="button" className="btn" onClick={onClose}>Odustani</button>
        </div>
      </form>
    </Modal>
  );
}

/** Uloge i prava: levo uloge, desno prava izabrane uloge po grupama (štikliranje). */
export function Roles() {
  const toast = useToast();
  const roles = useLoad(() => api<Role[]>('GET', '/roles'), []);
  const perms = useLoad(() => api<Perm[]>('GET', '/permissions'), []);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; permissions: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const role = roles.data?.find((r) => r.id === sel) ?? null;
  const pick = (r: Role) => { setSel(r.id); setDraft({ name: r.name, permissions: [...r.permissions] }); };
  const groups = [...new Set((perms.data ?? []).map((p) => p.group))];
  const locked = role?.code === 'ADMIN';
  const dirty = !!role && !!draft && (draft.name !== role.name || [...draft.permissions].sort().join() !== [...role.permissions].sort().join());

  const save = async () => {
    if (!role || !draft) return;
    setBusy(true);
    try {
      await api('PATCH', `/roles/${role.id}`, locked ? { name: draft.name } : draft);
      toast('ok', 'Uloga sačuvana - prava važe odmah'); roles.reload();
    } catch (e: any) { toast('err', e.message); } finally { setBusy(false); }
  };
  const [naming, setNaming] = useState(false);
  const create = async (name: string) => {
    try {
      const r = await api<Role>('POST', '/roles', { name, permissions: ['order.read', 'order.write', 'payment.create', 'catalog.read', 'table.read'] });
      setNaming(false); await roles.reload(); pick({ ...r, users: 0 });
    } catch (e: any) { toast('err', e.message); }
  };
  const remove = async () => {
    if (!role || !window.confirm(`Obrisati ulogu "${role.name}"?`)) return;
    try { await api('DELETE', `/roles/${role.id}`); setSel(null); setDraft(null); roles.reload(); }
    catch (e: any) { toast('err', e.message); }
  };

  if ((roles.loading && !roles.data) || (perms.loading && !perms.data)) return <Spinner />;
  if (roles.error || perms.error) return <ErrorBox error={roles.error ?? perms.error} onRetry={() => { roles.reload(); perms.reload(); }} />;
  return (
    <div className="page wide roles">
      <aside className="card roles-list">
        <div className="row-between"><h3>Uloge</h3><button className="btn sm primary" onClick={() => setNaming(true)}>+ Uloga</button></div>
        {naming && <NameDialog title="Nova uloga" label="Naziv (npr. Šanker)" onClose={() => setNaming(false)} onSave={create} />}
        {roles.data!.map((r) => (
          <button key={r.id} className={`role-item ${sel === r.id ? 'on' : ''}`} onClick={() => pick(r)}>
            <b>{r.name}</b><span>{r.users} korisnika · {r.permissions.length} prava</span>
          </button>
        ))}
      </aside>
      <section className="card roles-perms">
        {!role || !draft ? <p className="muted">Izaberite ulogu levo da biste podesili šta sme da radi.</p> : (
          <>
            <div className="row-between">
              <input className="input role-name" value={draft.name} maxLength={40} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <div className="btn-row tight">
                <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Čuvam…' : 'Sačuvaj'}</button>
                {!locked && <button className="btn danger-ghost" disabled={role.users > 0} title={role.users ? 'Uloga ima korisnike' : ''} onClick={remove}>Obriši</button>}
              </div>
            </div>
            {locked && <div className="notice">Administrator uvek ima sva prava.</div>}
            {groups.map((g) => (
              <div key={g} className="perm-group">
                <div className="perm-group-title">{g}
                  {!locked && <span>
                    <button className="link" onClick={() => setDraft({ ...draft, permissions: [...new Set([...draft.permissions, ...perms.data!.filter((p) => p.group === g).map((p) => p.code)])] })}>sve</button>
                    <button className="link" onClick={() => setDraft({ ...draft, permissions: draft.permissions.filter((c) => !perms.data!.some((p) => p.group === g && p.code === c)) })}>ništa</button>
                  </span>}
                </div>
                {perms.data!.filter((p) => p.group === g).map((p) => (
                  <label key={p.code} className="perm">
                    <input type="checkbox" disabled={locked} checked={locked || draft.permissions.includes(p.code)}
                      onChange={(e) => setDraft({ ...draft, permissions: e.target.checked ? [...draft.permissions, p.code] : draft.permissions.filter((c) => c !== p.code) })} />
                    {p.label}
                  </label>
                ))}
              </div>
            ))}
          </>
        )}
      </section>
    </div>
  );
}
