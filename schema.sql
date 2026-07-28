-- ============================================================================
--  GreenLoop — Schéma de base de données (Supabase / PostgreSQL)
--  Traçabilité du matériel traiteur : sortie en presta/livraison, retour,
--  manquants, casse/perte à facturer.
--
--  À exécuter dans Supabase : SQL Editor > New query > coller > Run.
--  Idempotent : peut être relancé sans casser l'existant.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";      -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- 1. Profils utilisateurs (livreurs / admin)
--    Adossé à auth.users de Supabase.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nom         text not null default '',
  role        text not null default 'livreur'   -- 'livreur' | 'admin'
              check (role in ('livreur', 'admin')),
  created_at  timestamptz not null default now()
);

-- Crée automatiquement un profil à chaque inscription
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, nom)
  values (new.id, coalesce(new.raw_user_meta_data->>'nom', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 2. Clients
-- ---------------------------------------------------------------------------
create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  nom         text not null,
  adresse     text,
  contact     text,
  telephone   text,
  email       text,
  actif       boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. Catalogue matériel : les TYPES
--    suivi = 'unite'    -> chaque exemplaire a un QR (caisses, gros matériel)
--    suivi = 'quantite' -> on compte (vaisselle, ustensiles)
-- ---------------------------------------------------------------------------
create table if not exists public.materiel_types (
  id             uuid primary key default gen_random_uuid(),
  nom            text not null,
  categorie      text,                       -- ex: 'Caisses', 'Vaisselle', 'Ustensiles', 'Gros matériel'
  suivi          text not null default 'quantite'
                 check (suivi in ('unite', 'quantite')),
  unite          text default 'pièce',       -- libellé d'unité pour l'affichage
  prix_unitaire  numeric(10,2) not null default 0,  -- prix de remplacement (facturation casse/perte)
  actif          boolean not null default true,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. Unités individuelles (seulement pour les types suivi='unite')
--    code = valeur encodée dans le QR collé sur la pièce.
-- ---------------------------------------------------------------------------
create table if not exists public.materiel_units (
  id          uuid primary key default gen_random_uuid(),
  type_id     uuid not null references public.materiel_types(id) on delete cascade,
  code        text not null unique,           -- ex: 'GL-CAISSE-000042'
  libelle     text,                            -- optionnel : "Caisse bleue n°42"
  statut      text not null default 'disponible'  -- 'disponible' | 'sorti' | 'perdu' | 'casse' | 'reforme'
              check (statut in ('disponible','sorti','perdu','casse','reforme')),
  created_at  timestamptz not null default now()
);
create index if not exists idx_units_type on public.materiel_units(type_id);
create index if not exists idx_units_statut on public.materiel_units(statut);

-- ---------------------------------------------------------------------------
-- 5. Prestations (un événement / une livraison chez un client)
-- ---------------------------------------------------------------------------
create table if not exists public.prestations (
  id           uuid primary key default gen_random_uuid(),
  reference    text,                            -- ex: numéro de dossier Briffe
  client_id    uuid references public.clients(id) on delete set null,
  libelle      text,                            -- ex: "Cocktail 120p - Mairie de Lille"
  date_presta  date,
  statut       text not null default 'en_cours' -- 'en_cours' | 'livre' | 'clos'
               check (statut in ('en_cours','livre','clos')),
  notes        text,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_presta_client on public.prestations(client_id);
create index if not exists idx_presta_statut on public.prestations(statut);

-- ---------------------------------------------------------------------------
-- 6. Mouvements : chaque scan / saisie de sortie ou de retour
--    sens = 'sortie' (livré chez le client) | 'retour' (récupéré)
--    - unité : unit_id renseigné, quantite = 1
--    - quantité : unit_id NULL, quantite = n
-- ---------------------------------------------------------------------------
create table if not exists public.mouvements (
  id            uuid primary key default gen_random_uuid(),
  prestation_id uuid not null references public.prestations(id) on delete cascade,
  sens          text not null check (sens in ('sortie','retour')),
  type_id       uuid not null references public.materiel_types(id) on delete restrict,
  unit_id       uuid references public.materiel_units(id) on delete set null,
  quantite      integer not null default 1 check (quantite > 0),
  par_user      uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_mvt_presta on public.mouvements(prestation_id);
create index if not exists idx_mvt_unit on public.mouvements(unit_id);
create index if not exists idx_mvt_type on public.mouvements(type_id);

-- ---------------------------------------------------------------------------
-- 7. Facturation des manquants (casse / perte)
-- ---------------------------------------------------------------------------
create table if not exists public.facturations (
  id            uuid primary key default gen_random_uuid(),
  prestation_id uuid not null references public.prestations(id) on delete cascade,
  type_id       uuid not null references public.materiel_types(id) on delete restrict,
  unit_id       uuid references public.materiel_units(id) on delete set null,
  motif         text not null default 'perte'   -- 'perte' | 'casse' | 'autre'
                check (motif in ('perte','casse','autre')),
  quantite      integer not null default 1 check (quantite > 0),
  prix_unitaire numeric(10,2) not null default 0,
  montant       numeric(10,2) generated always as (quantite * prix_unitaire) stored,
  statut        text not null default 'a_facturer'  -- 'a_facturer' | 'facture' | 'annule'
                check (statut in ('a_facturer','facture','annule')),
  notes         text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_fact_presta on public.facturations(prestation_id);

-- ============================================================================
--  VUE : bilan des manquants par prestation
--  Pour chaque (prestation, type) : quantité sortie, retournée, manquante.
-- ============================================================================
create or replace view public.v_bilan_manquants as
with sorties as (
  select prestation_id, type_id, sum(quantite) as q_sortie
  from public.mouvements where sens = 'sortie'
  group by prestation_id, type_id
),
retours as (
  select prestation_id, type_id, sum(quantite) as q_retour
  from public.mouvements where sens = 'retour'
  group by prestation_id, type_id
)
select
  s.prestation_id,
  s.type_id,
  t.nom          as type_nom,
  t.categorie,
  t.suivi,
  t.prix_unitaire,
  s.q_sortie,
  coalesce(r.q_retour, 0) as q_retour,
  greatest(s.q_sortie - coalesce(r.q_retour, 0), 0) as q_manquant
from sorties s
join public.materiel_types t on t.id = s.type_id
left join retours r
  on r.prestation_id = s.prestation_id and r.type_id = s.type_id;

-- ============================================================================
--  RLS : tout utilisateur authentifié peut lire/écrire.
--  (MVP simple ; on affinera livreur vs admin plus tard.)
-- ============================================================================
alter table public.profiles        enable row level security;
alter table public.clients         enable row level security;
alter table public.materiel_types  enable row level security;
alter table public.materiel_units  enable row level security;
alter table public.prestations     enable row level security;
alter table public.mouvements      enable row level security;
alter table public.facturations    enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','clients','materiel_types','materiel_units',
    'prestations','mouvements','facturations'
  ]
  loop
    execute format('drop policy if exists "auth_read_%1$s"  on public.%1$s;', t);
    execute format('drop policy if exists "auth_write_%1$s" on public.%1$s;', t);
    execute format(
      'create policy "auth_read_%1$s" on public.%1$s
         for select to authenticated using (true);', t);
    execute format(
      'create policy "auth_write_%1$s" on public.%1$s
         for all to authenticated using (true) with check (true);', t);
  end loop;
end $$;

-- ============================================================================
--  DONNÉES D'EXEMPLE (facultatif — supprime ce bloc si tu pars de zéro)
-- ============================================================================
insert into public.materiel_types (nom, categorie, suivi, unite, prix_unitaire) values
  ('Caisse navette',        'Caisses',        'unite',    'caisse',  35.00),
  ('Bac gastronorme inox',  'Gros matériel',  'unite',    'bac',     45.00),
  ('Assiette plate',        'Vaisselle',      'quantite', 'pièce',    4.50),
  ('Verre à eau',           'Vaisselle',      'quantite', 'pièce',    2.80),
  ('Couvert (fourchette)',  'Ustensiles',     'quantite', 'pièce',    1.90),
  ('Plat de service',       'Vaisselle',      'quantite', 'pièce',   12.00)
on conflict do nothing;

insert into public.clients (nom, adresse, contact) values
  ('Mairie de Lille',        '1 Place Augustin Laurent, Lille', 'Service événementiel'),
  ('EDHEC Business School',  '24 Av. Gustave Delory, Roubaix',  'Accueil')
on conflict do nothing;

-- Quelques unités de caisses avec QR (pour tester le scan)
do $$
declare
  caisse_type uuid;
  i int;
begin
  select id into caisse_type from public.materiel_types where nom = 'Caisse navette' limit 1;
  if caisse_type is not null then
    for i in 1..10 loop
      insert into public.materiel_units (type_id, code, libelle)
      values (caisse_type, 'GL-CAISSE-' || lpad(i::text, 6, '0'), 'Caisse navette n°' || i)
      on conflict (code) do nothing;
    end loop;
  end if;
end $$;

-- Fin du schéma.
