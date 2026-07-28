# GreenLoop — Guide d'installation

Traçabilité du matériel traiteur : sortie en presta/livraison → retour → rapport
des manquants → facturation casse/perte. App web installable (PWA), même
écosystème que briffetools : **GitHub → Netlify**, avec une base de données
**Supabase**.

Tu as juste **3 étapes** : créer la base Supabase, renseigner 2 valeurs dans
`config.js`, déployer. Compte ~20 minutes.

---

## Étape 1 — Créer la base de données (Supabase)

1. Va sur **https://supabase.com** → *Start your project* → connecte-toi (GitHub
   possible). C'est gratuit et le palier gratuit suffit largement.
2. **New project** : donne un nom (ex. `greenloop`), choisis une région
   **Europe (Frankfurt / Paris)**, mets un mot de passe de base de données (garde-le
   quelque part). Attends ~2 min que le projet se crée.
3. Menu de gauche → **SQL Editor** → **New query**.
4. Ouvre le fichier **`schema.sql`** fourni, copie **tout** son contenu, colle-le
   dans l'éditeur, puis clique **Run** (en bas à droite). Tu dois voir
   *Success*. Ça crée toutes les tables + quelques données d'exemple (2 clients,
   6 types de matériel, 10 caisses de test).
5. Récupère tes 2 clés : menu **Project Settings** (roue crantée) → **API** (ou
   *Data API*). Note :
   - **Project URL** → ressemble à `https://abcdxyz.supabase.co`
   - **Project API keys → `anon` `public`** → une longue chaîne `eyJ…`

> Ces 2 valeurs ne sont **pas secrètes** : la clé `anon` est publique et protégée
> par les règles de sécurité (RLS) posées par le schéma. Tu peux les mettre sur
> GitHub sans risque.

### Autoriser les inscriptions (livreurs)
Menu **Authentication → Sign In / Providers → Email** : laisse **Email** activé.
Pour aller vite au démarrage, tu peux **désactiver "Confirm email"** (Authentication
→ Providers → Email → *Confirm email* = off) afin que les livreurs se connectent
sans étape de mail. Tu pourras le réactiver plus tard.

---

## Étape 2 — Renseigner `config.js`

Ouvre le fichier **`config.js`** et remplace les 2 valeurs :

```js
window.GREENLOOP_CONFIG = {
  SUPABASE_URL: "https://abcdxyz.supabase.co",   // ← ton Project URL
  SUPABASE_ANON_KEY: "eyJhbGciOi....",           // ← ta clé anon public
};
```

C'est la **seule** modification à faire dans le code.

---

## Étape 3 — Déployer (comme briffetools)

Tu connais déjà le flux GitHub → Netlify. En résumé :

1. Crée un repo GitHub (ex. `Briffe-hub/greenloop`) et dépose **tous** les
   fichiers du dossier (garde la structure, notamment le dossier `lib/`).
2. Sur **Netlify** → *Add new site* → *Import from GitHub* → choisis le repo.
3. **Build command** : *(laisse vide)* — **Publish directory** : `.` (la racine).
   Il n'y a pas d'étape de build, c'est du statique.
4. *Deploy*. Netlify te donne une URL `https://xxx.netlify.app`.

> Astuce : dans Netlify → *Site settings → Change site name* pour avoir une URL
> propre type `greenloop-briffe.netlify.app`.

---

## Installer l'app sur le téléphone des livreurs

Ouvre l'URL Netlify dans le navigateur du téléphone, puis :
- **iPhone (Safari)** : bouton *Partager* → *Sur l'écran d'accueil*.
- **Android (Chrome)** : menu ⋮ → *Installer l'application* / *Ajouter à l'écran d'accueil*.

L'app s'ouvre alors en plein écran comme une vraie appli, avec accès à l'appareil
photo pour scanner (le navigateur demandera l'autorisation caméra la 1ʳᵉ fois —
il faut accepter, et l'URL doit être en **https**, ce que Netlify fournit).

Chaque livreur crée son compte au premier lancement (bouton *Créer un compte*).

---

## Prise en main (dans l'ordre)

1. **Matériel** → crée tes types. Deux modes de suivi :
   - *À l'unité (QR)* pour les caisses, bacs, gros matériel → puis **Générer des
     unités** et **Imprimer les étiquettes QR** (bouton dédié) → colle une
     étiquette sur chaque pièce.
   - *Par quantité* pour la vaisselle, les couverts, les verres…
   - Renseigne le **prix de remplacement** : il sert au calcul de la facturation
     casse/perte.
2. **Clients** → ajoute tes clients (ou garde ceux d'exemple).
3. **Prestations** → crée une prestation (client + date).
4. Le jour J, sur le téléphone :
   - **Sortie** : scanne les caisses + saisis les quantités livrées → *Valider*.
   - **Retour** : à la récupération, rescanne + ressaisis ce qui revient → *Valider*.
5. **Rapport des manquants** : la différence sortie − retour s'affiche. Bouton
   pour **facturer** (casse ou perte), avec le montant calculé automatiquement.

---

## Structure des fichiers

```
greenloop/
├─ index.html         Page principale
├─ app.js             Toute la logique de l'app
├─ styles.css         Mise en forme
├─ config.js          ← tes 2 valeurs Supabase (à remplir)
├─ manifest.json      Métadonnées PWA (installation)
├─ sw.js              Service worker (installation / hors-ligne léger)
├─ icon-192.png       Icônes de l'app
├─ icon-512.png
├─ schema.sql         ← à exécuter dans Supabase (étape 1)
├─ GUIDE.md           Ce guide
└─ lib/               Librairies (Supabase, scan QR, génération QR) — ne pas supprimer
```

---

## Notes & limites de cette v1 (MVP)

- **Sécurité (RLS)** : tout utilisateur connecté peut lire/écrire. On pourra
  affiner *livreur* vs *admin* ensuite (ex. seul l'admin gère le catalogue).
- **Hors-ligne** : l'app *s'installe* et se lance hors-ligne, mais l'enregistrement
  d'une sortie/retour nécessite du réseau (écriture en base). Une file d'attente
  hors-ligne peut être ajoutée en v2 si les zones de livraison sont mal couvertes.
- **Facturation** : GreenLoop calcule et liste les montants à facturer. Le lien
  automatique vers la facturation Briffe pourra être branché ensuite.
- **Modèle hybride** : caisses/gros matériel à l'unité (QR), vaisselle/ustensiles
  par quantité — c'est le compromis retenu ensemble.

Des idées de suite : file d'attente hors-ligne, rôles livreur/admin, export du
rapport en PDF, rattachement au dossier Briffe, photo de la casse jointe à la
facturation, tableau de bord « où est mon matériel en ce moment ».
