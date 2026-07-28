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

1. **Matériel** → crée tes types. **Un QR par type** (pas un QR différent par
   exemplaire) : « Caisse crocodile » = un QR, « Caisse Araven 20L » = un autre, etc.
   - Le **code QR** est proposé automatiquement (bouton *Auto*) à partir du nom,
     tu peux le modifier. Il est **stocké dans la base** sur le type : tu peux
     donc réimprimer la même étiquette autant de fois que tu veux, à l'identique.
   - Renseigne le **prix de remplacement** : il sert au calcul de la facturation
     casse/perte.
   - Les types sans QR (ex. vaisselle comptée en vrac) se sélectionnent à la main
     dans le flux, sans scan.

### Imprimer / réimprimer les étiquettes QR (imprimante Brother DK)

Chaque exemplaire d'un type porte **la même étiquette**. Deux méthodes :

- **Depuis l'app** : écran d'un type → *Imprimer les étiquettes* → choisis le
  nombre d'exemplaires → *Imprimer* → sélectionne ton imprimante Brother et le
  format de ton rouleau DK. Pratique pour une réimpression rapide.
- **Brother P-touch Editor (recommandé pour du volume et de la réimpression à
  volonté)** : sur l'écran **Matériel**, bouton **CSV** → tu obtiens un fichier
  avec tous tes types et leurs codes. Dans P-touch Editor : *Fichier → Base de
  données → Parcourir* (importe le CSV), crée **un objet code-barres de type QR**
  lié à la colonne `code_qr`, ajoute le champ `nom` en texte, choisis ton étiquette
  DK, et imprime avec le nombre de copies voulu. Le CSV se régénère à tout moment,
  donc tu réimprimes n'importe quelle étiquette quand tu veux.

> Le QR encode juste le **code texte** (ex. `GL-ARAVEN20`). L'image n'est jamais
> stockée : elle est régénérée depuis le code, donc une réimpression est toujours
> strictement identique à l'originale.
2. **Clients** → ajoute tes clients (ou garde ceux d'exemple). Chaque client a un
   **type** :
   - **Ponctuel** : tout doit revenir au débarrassage. Sur l'écran *Manquants*
     d'une prestation, le bouton **Envoyer les manquants à la compta** ouvre un
     mail prérempli vers l'adresse compta (à régler dans **Paramètres**).
   - **Fixe** : le client garde du matériel d'une fois sur l'autre. Sa **fiche**
     affiche le **matériel détenu à l'instant T** (tout ce qui est sorti moins ce
     qui est revenu, toutes prestations confondues), avec la valeur totale.
     Boutons : **Envoyer le récap au client** (mail prérempli vers son email) et
     **Facturer ce matériel** (perte/casse) → crée les lignes à facturer.
   - Renseigne l'**email** du client (nécessaire pour lui envoyer un récap) et,
     dans **Compte → Paramètres**, l'**email du service compta**.
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
- **Emails (récap / manquants)** : pour l'instant les boutons ✉️ ouvrent ton
  application mail avec le message prérempli (destinataire, objet, corps) — tu
  n'as qu'à cliquer « Envoyer ». C'est immédiat et sans configuration. On pourra
  passer à un **envoi automatique** (sans ouvrir le client mail) via une petite
  fonction serveur Supabase + un service d'emailing, si tu le souhaites.
- **Import Sextan des clients** : à brancher — voir avec toi le meilleur canal
  (export CSV depuis Sextan, ou synchro via l'API Sextan côté serveur).
- **Modèle QR par type** : un même QR pour tous les exemplaires d'un type ; on
  scanne chaque caisse à la sortie (chaque scan = +1) puis au retour, et le
  manquant = sortie − retour. Les types sans QR se comptent à la main.

Des idées de suite : file d'attente hors-ligne, rôles livreur/admin, export du
rapport en PDF, rattachement au dossier Briffe, photo de la casse jointe à la
facturation, tableau de bord « où est mon matériel en ce moment ».
