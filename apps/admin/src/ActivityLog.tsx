import { api } from '@shared/api';
import { ErrorBox, Spinner, useLoad } from '@shared/ui';
import { Column, DataTable } from './DataTable';

interface Entry { id: string; at: string; action: string; entity: string; entityId: string; data: Record<string, any> | null; user: string | null }

/** Nazivi radnji u dnevniku; nepoznate radnje se prikazuju tehničkim nazivom. */
const ACTION: Record<string, string> = {
  'order.open': 'Otvoren račun', 'order.item.add': 'Dodata stavka', 'order.item.update': 'Izmena stavke', 'order.item.remove': 'Obrisana neposlata stavka',
  'order.send': 'Poslato u pripremu', 'order.item.void': 'Storno stavke', 'order.void_all': 'Storno računa', 'order.cancel': 'Otkazan račun', 'order.close': 'Zatvoren račun',
  'order.discount.set': 'Popust na računu', 'order.discount.remove': 'Popust uklonjen', 'order.buyer.set': 'Kupac na računu', 'order.buyer.remove': 'Kupac uklonjen',
  'order.transfer': 'Predaja drugom konobaru', 'order.items.move_out': 'Prebacivanje stavki', 'order.items.move_in': 'Primljene stavke', 'order.move_table': 'Prebacivanje stola',
  'order.merge': 'Spajanje računa', 'order.merged_into': 'Spojen u drugi račun', 'order.emptied_by_move': 'Ispražnjen prebacivanjem', 'order.rename': 'Naziv ture',
  'payment.create': 'Naplata', 'fiscal.retry': 'Ponovna fiskalizacija',
  'day.open': 'Otvaranje dana', 'day.close': 'Zatvaranje dana', 'day.merge': 'Spajanje smena', 'day.split': 'Podela smene',
  'shift.open': 'Otvaranje smene', 'shift.close': 'Zatvaranje smene', 'staff_shift.end': 'Kraj smene zaposlenog',
  'product.create': 'Novi proizvod', 'product.update': 'Izmena proizvoda', 'product.price.change': 'Promena cene', 'product.image.set': 'Slika proizvoda', 'product.image.remove': 'Slika uklonjena',
  'category.create': 'Nova grupa', 'category.update': 'Izmena grupe', 'category.import': 'Uvoz grupa',
  'recipe.create': 'Novi normativ', 'recipe.update': 'Izmena normativa', 'recipe.activate': 'Normativ aktiviran', 'recipe.retire': 'Normativ povučen',
  'user.create': 'Novi korisnik', 'user.update': 'Izmena korisnika', 'role.create': 'Nova uloga', 'role.update': 'Izmena uloge', 'role.delete': 'Uloga obrisana',
  'discount.create': 'Novi popust', 'discount.update': 'Izmena popusta', 'happy_hour.create': 'Novi happy hour', 'happy_hour.update': 'Izmena happy hour', 'happy_hour.delete': 'Happy hour obrisan',
  'price_list.create': 'Novi cenovnik', 'price_list.update': 'Izmena cenovnika', 'price_list.items': 'Cene u cenovniku', 'price_list.delete': 'Cenovnik obrisan', 'price_list.kasa': 'Cenovnik na kasi',
  'stock.doc.create': 'Novi dokument', 'stock.doc.post': 'Proknjižen dokument', 'stock.doc.cancel': 'Storno dokumenta',
  'table.create': 'Novi sto', 'table.update': 'Izmena stola', 'table.delete': 'Sto obrisan', 'table.layout': 'Raspored stolova', 'table.restore': 'Sto vraćen',
  'settings.kasa': 'Podešavanja kase', 'device.create': 'Novi računar', 'device.update': 'Izmena računara',
  'print.receipt': 'Štampa računa', 'print.day_report': 'Štampa pazara', 'print.shift_report': 'Štampa smene', 'print.retry': 'Ponovna štampa',
  'kds.ticket.status': 'KDS status', 'kds.item.ready': 'KDS stavka spremna',
};
const ENTITY: Record<string, string> = {
  order: 'Račun', business_day: 'Dan', product: 'Proizvod', user: 'Korisnik', role: 'Uloga', discount: 'Popust', price_list: 'Cenovnik',
  location: 'Lokal', device: 'Računar', table: 'Sto', category: 'Grupa', stock_document: 'Dokument', happy_hour: 'Happy hour', cash_shift: 'Smena',
};

const detail = (e: Entry) => {
  const d = e.data ?? {};
  const parts: string[] = [];
  if (d.reason) parts.push(`razlog: ${d.reason}`);
  if (d.name) parts.push(String(d.name));
  if (d.from !== undefined && d.to !== undefined) parts.push(`${d.from} → ${d.to}`);
  if (d.percent) parts.push(`${Number(d.percent)}%`);
  if (d.amount) parts.push(`iznos ${d.amount}`);
  return parts.join(' · ');
};

/** Dnevnik aktivnosti: ko je, kada i šta uradio (storna, zatvaranje dana, promene cena…), poslednjih 1000 radnji. */
export function ActivityLog() {
  const r = useLoad(() => api<Entry[]>('GET', '/audit-logs?limit=1000'), []);
  if (r.loading && !r.data) return <Spinner />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const columns: Column<Entry>[] = [
    { key: 'at', label: 'Vreme', value: (e) => e.at, render: (e) => new Date(e.at).toLocaleString('sr-Latn-RS'), filter: false, width: 170 },
    { key: 'user', label: 'Korisnik', value: (e) => e.user ?? 'sistem', filter: 'select' },
    { key: 'action', label: 'Radnja', value: (e) => ACTION[e.action] ?? e.action, filter: 'select' },
    { key: 'entity', label: 'Odnosi se na', value: (e) => ENTITY[e.entity] ?? e.entity, filter: 'select' },
    { key: 'detail', label: 'Detalji', value: detail },
  ];
  return (
    <div className="page wide">
      <div className="toolbar">
        <span className="muted">Svaka radnja u sistemu je zabeležena i ne može se obrisati. Filtrirajte po korisniku ili radnji (npr. Storno računa).</span>
        <button className="btn" onClick={r.reload}>Osveži</button>
      </div>
      <DataTable columns={columns} rows={r.data ?? []} rowKey={(e) => e.id} empty="Dnevnik je prazan."
        rowClass={(e) => (['order.item.void', 'order.void_all', 'order.cancel', 'stock.doc.cancel'].includes(e.action) ? 'storno' : undefined)} />
    </div>
  );
}
