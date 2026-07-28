/* ===========================================================================
   GreenLoop — Application (PWA vanilla JS + Supabase)
   Traçabilité du matériel traiteur : sortie -> retour -> manquants -> facturation
   =========================================================================== */
(function () {
  "use strict";

  // ---- Config / client Supabase ------------------------------------------
  const CFG = window.GREENLOOP_CONFIG || {};
  const CONFIGURED =
    CFG.SUPABASE_URL &&
    CFG.SUPABASE_ANON_KEY &&
    !CFG.SUPABASE_URL.includes("VOTRE-PROJET") &&
    !CFG.SUPABASE_ANON_KEY.includes("VOTRE_CLE");

  let sb = null;
  if (CONFIGURED && window.supabase) {
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  }

  // ---- État global --------------------------------------------------------
  const state = { user: null, profile: null };

  // ---- Raccourcis DOM -----------------------------------------------------
  const app = document.getElementById("app");
  const nav = document.getElementById("nav");
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  const eur = (n) => (Number(n) || 0).toFixed(2).replace(".", ",") + " €";
  const dfr = (d) =>
    d ? new Date(d + "T00:00:00").toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }) : "—";

  function toast(msg, kind = "") {
    const t = document.createElement("div");
    t.className = "toast " + kind;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }
  const spinner = '<div class="spinner"></div>';

  // ---- Couches d'accès données -------------------------------------------
  const db = {
    async q(table, cb) {
      let query = sb.from(table).select("*");
      if (cb) query = cb(query);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    clients: () => db.q("clients", (q) => q.eq("actif", true).order("nom")),
    types: () => db.q("materiel_types", (q) => q.eq("actif", true).order("categorie").order("nom")),
    unitsByType: (id) => db.q("materiel_units", (q) => q.eq("type_id", id).order("code")),
    unitByCode: async (code) => {
      const { data, error } = await sb
        .from("materiel_units")
        .select("*, materiel_types(*)")
        .eq("code", code.trim())
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    prestations: () =>
      db.q("prestations", (q) => q.order("date_presta", { ascending: false }).order("created_at", { ascending: false })),
    prestation: async (id) => {
      const { data, error } = await sb
        .from("prestations")
        .select("*, clients(*)")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data;
    },
    mouvements: (pid) =>
      db.q("mouvements", (q) =>
        q.eq("prestation_id", pid)
      ).then((rows) => rows),
    bilan: (pid) => db.q("v_bilan_manquants", (q) => q.eq("prestation_id", pid)),
    facturations: (pid) => db.q("facturations", (q) => q.eq("prestation_id", pid).order("created_at")),
  };

  // =========================================================================
  //  ROUTEUR
  // =========================================================================
  const routes = {};
  function route(path, fn) { routes[path] = fn; }

  function parseHash() {
    const raw = (location.hash || "#/prestations").slice(1);
    return raw.split("/").filter(Boolean); // ex: ["prestation","abc","sortie"]
  }

  async function render() {
    if (!state.user) return; // géré par renderAuth
    const parts = parseHash();
    const head = parts[0] || "prestations";
    setNav(head);
    app.innerHTML = spinner;
    try {
      if (head === "prestations" && parts.length === 1) return viewPrestations();
      if (head === "prestation") {
        const id = parts[1];
        const sub = parts[2];
        if (sub === "sortie") return viewFlux(id, "sortie");
        if (sub === "retour") return viewFlux(id, "retour");
        if (sub === "manquants") return viewManquants(id);
        return viewPrestationDetail(id);
      }
      if (head === "nouvelle-presta") return viewPrestaForm();
      if (head === "materiel" && parts.length === 1) return viewMateriel();
      if (head === "type") return viewTypeDetail(parts[1]);
      if (head === "etiquettes") return viewEtiquettes(parts[1]);
      if (head === "clients") return viewClients();
      if (head === "compte") return viewCompte();
      go("prestations");
    } catch (e) {
      console.error(e);
      app.innerHTML = topbar("Erreur") + `<main><div class="card"><p>${esc(e.message || e)}</p></div></main>`;
    }
  }

  function go(path) { location.hash = "#/" + path; }
  function setNav(head) {
    nav.classList.toggle("hidden", false);
    $$("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.route === head));
  }
  nav.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) go(b.dataset.route);
  });
  window.addEventListener("hashchange", render);

  // ---- Fragments UI communs ----------------------------------------------
  function topbar(title, opts = {}) {
    const back = opts.back
      ? `<button class="back" onclick="history.length>1?history.back():(location.hash='#/${opts.back}')">‹ Retour</button>`
      : "";
    const act = opts.action
      ? `<button class="act" id="tb-action">${esc(opts.action)}</button>`
      : "";
    return `<div class="topbar">${back}<h1>${esc(title)}</h1>${act}</div>`;
  }
  const prestaBadge = (s) =>
    ({ en_cours: '<span class="badge amber">En cours</span>',
       livre: '<span class="badge blue">Livré</span>',
       clos: '<span class="badge green">Clos</span>' }[s] || "");

  // =========================================================================
  //  VUE : Liste des prestations
  // =========================================================================
  async function viewPrestations() {
    const list = await db.prestations();
    let cli = {};
    (await db.clients()).forEach((c) => (cli[c.id] = c.nom));
    const cards = list.length
      ? list
          .map(
            (p) => `
        <div class="card tap" onclick="location.hash='#/prestation/${p.id}'">
          <div class="grow">
            <div class="row between">
              <h3 class="truncate">${esc(p.libelle || p.reference || "Prestation")}</h3>
              ${prestaBadge(p.statut)}
            </div>
            <div class="sub">${esc(cli[p.client_id] || "Client ?")} · ${dfr(p.date_presta)}</div>
          </div>
          <div style="font-size:22px;color:#cbd5c9">›</div>
        </div>`
          )
          .join("")
      : `<div class="empty"><div class="big">📋</div>Aucune prestation.<br>Crée-en une pour commencer.</div>`;

    app.innerHTML =
      topbar("Prestations") +
      `<main>${cards}</main>
       <button class="fab" onclick="location.hash='#/nouvelle-presta'">＋</button>`;
  }

  // =========================================================================
  //  VUE : Nouvelle prestation
  // =========================================================================
  async function viewPrestaForm() {
    const clients = await db.clients();
    app.innerHTML =
      topbar("Nouvelle prestation", { back: "prestations" }) +
      `<main>
        <div class="card">
          <label>Libellé</label>
          <input id="f-lib" placeholder="Ex : Cocktail 120p – Mairie de Lille" />
          <label>Client</label>
          <select id="f-client">
            <option value="">— Choisir —</option>
            ${clients.map((c) => `<option value="${c.id}">${esc(c.nom)}</option>`).join("")}
          </select>
          <div class="field-row">
            <div><label>Date</label><input id="f-date" type="date" value="${new Date().toISOString().slice(0,10)}" /></div>
            <div><label>Référence</label><input id="f-ref" placeholder="N° dossier" /></div>
          </div>
          <label>Notes</label>
          <textarea id="f-notes" placeholder="Infos utiles pour le livreur…"></textarea>
          <button class="btn block" id="save">Créer la prestation</button>
        </div>
      </main>`;
    $("#save").onclick = async () => {
      const lib = $("#f-lib").value.trim();
      if (!lib) return toast("Ajoute un libellé", "err");
      $("#save").disabled = true;
      const { data, error } = await sb
        .from("prestations")
        .insert({
          libelle: lib,
          client_id: $("#f-client").value || null,
          date_presta: $("#f-date").value || null,
          reference: $("#f-ref").value.trim() || null,
          notes: $("#f-notes").value.trim() || null,
          created_by: state.user.id,
        })
        .select()
        .single();
      if (error) { $("#save").disabled = false; return toast(error.message, "err"); }
      go("prestation/" + data.id);
    };
  }

  // =========================================================================
  //  VUE : Détail prestation
  // =========================================================================
  async function viewPrestationDetail(id) {
    const p = await db.prestation(id);
    const bilan = await db.bilan(id);
    const totalSortie = bilan.reduce((s, b) => s + b.q_sortie, 0);
    const totalRetour = bilan.reduce((s, b) => s + b.q_retour, 0);
    const totalManq = bilan.reduce((s, b) => s + b.q_manquant, 0);

    app.innerHTML =
      topbar(p.libelle || "Prestation", { back: "prestations" }) +
      `<main>
        <div class="card">
          <div class="row between">
            <div class="grow">
              <h3>${esc(p.clients ? p.clients.nom : "Client ?")}</h3>
              <div class="sub">${dfr(p.date_presta)}${p.reference ? " · Réf " + esc(p.reference) : ""}</div>
            </div>
            ${prestaBadge(p.statut)}
          </div>
          ${p.notes ? `<div class="divider"></div><div class="sub">${esc(p.notes)}</div>` : ""}
        </div>

        <div class="stat">
          <div class="box"><div class="n">${totalSortie}</div><div class="l">Sortis</div></div>
          <div class="box"><div class="n green">${totalRetour}</div><div class="l">Revenus</div></div>
          <div class="box"><div class="n ${totalManq ? "red" : "green"}">${totalManq}</div><div class="l">Manquants</div></div>
        </div>

        <div class="btn-grid" style="margin-top:14px">
          <button class="btn" onclick="location.hash='#/prestation/${id}/sortie'">📤 Sortie<br><small style="font-weight:500">Livré chez le client</small></button>
          <button class="btn sec" onclick="location.hash='#/prestation/${id}/retour'">📥 Retour<br><small style="font-weight:500">Matériel récupéré</small></button>
        </div>
        <button class="btn ghost block" onclick="location.hash='#/prestation/${id}/manquants'">📊 Rapport des manquants${totalManq ? ` (${totalManq})` : ""}</button>

        <div class="section-title">Statut de la prestation</div>
        <div class="card">
          <select id="statut">
            <option value="en_cours" ${p.statut==="en_cours"?"selected":""}>En cours</option>
            <option value="livre" ${p.statut==="livre"?"selected":""}>Livré</option>
            <option value="clos" ${p.statut==="clos"?"selected":""}>Clos</option>
          </select>
        </div>
      </main>`;

    $("#statut").onchange = async (e) => {
      const { error } = await sb.from("prestations").update({ statut: e.target.value }).eq("id", id);
      toast(error ? error.message : "Statut mis à jour", error ? "err" : "ok");
    };
  }

  // =========================================================================
  //  VUE : Flux Sortie / Retour  (scan unités + quantités)
  // =========================================================================
  async function viewFlux(id, sens) {
    const p = await db.prestation(id);
    const types = await db.types();
    const unitTypes = types.filter((t) => t.suivi === "unite");
    const qtyTypes = types.filter((t) => t.suivi === "quantite");
    const label = sens === "sortie" ? "Sortie" : "Retour";
    const verb = sens === "sortie" ? "livrés" : "récupérés";

    // panier : unités scannées (map code->unit) + quantités (map typeId->n)
    const scanned = new Map();
    const qtys = {};
    qtyTypes.forEach((t) => (qtys[t.id] = 0));

    app.innerHTML =
      topbar(label + " · " + (p.libelle || ""), { back: "prestation/" + id }) +
      `<main>
        <div class="section-title">1. Scanner les caisses / gros matériel</div>
        <div class="card">
          <div id="scanner-box"></div>
          <div class="scan-hint" id="scan-hint">Vise un QR code…</div>
          <div class="field-row" style="margin-top:6px">
            <input id="manual-code" placeholder="ou saisir un code (GL-CAISSE-…)" />
            <button class="btn sm sec" id="manual-add" style="flex:0 0 auto">Ajouter</button>
          </div>
          <div class="scan-feed" id="scan-feed"></div>
        </div>

        <div class="section-title">2. Quantités (vaisselle, ustensiles…)</div>
        <div class="card" id="qty-card">
          ${qtyTypes.map((t) => `
            <div class="mat-line">
              <div class="name"><b>${esc(t.nom)}</b><small>${esc(t.categorie||"")}</small></div>
              <div class="qty" data-type="${t.id}">
                <button data-d="-1">−</button>
                <input type="number" inputmode="numeric" value="0" min="0" data-qtyinput="${t.id}" />
                <button data-d="1">＋</button>
              </div>
            </div>`).join("")}
        </div>

        <div class="card" style="position:sticky;bottom:calc(84px + var(--safe-b))">
          <div class="row between" style="margin-bottom:8px">
            <b id="recap">0 pièce(s) ${verb}</b>
          </div>
          <button class="btn ${sens==="sortie"?"":"sec"} block" id="valider">Valider ${label.toLowerCase()}</button>
        </div>
      </main>`;

    // -- stepper quantités
    const updateRecap = () => {
      const nUnits = scanned.size;
      const nQty = Object.values(qtys).reduce((a, b) => a + b, 0);
      $("#recap").textContent = `${nUnits + nQty} pièce(s) ${verb}` + (nUnits ? ` · ${nUnits} caisse(s)` : "");
    };
    $("#qty-card").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-d]");
      if (!b) return;
      const wrap = b.closest(".qty");
      const tid = wrap.dataset.type;
      const input = $(`[data-qtyinput="${tid}"]`);
      let v = Math.max(0, (parseInt(input.value) || 0) + parseInt(b.dataset.d));
      input.value = v; qtys[tid] = v; updateRecap();
    });
    $("#qty-card").addEventListener("input", (e) => {
      const inp = e.target.closest("[data-qtyinput]");
      if (!inp) return;
      const tid = inp.dataset.qtyinput;
      qtys[tid] = Math.max(0, parseInt(inp.value) || 0); updateRecap();
    });

    // -- ajout d'une unité scannée/saisie
    const feed = $("#scan-feed");
    async function addCode(code) {
      code = (code || "").trim();
      if (!code) return;
      if (scanned.has(code)) {
        beep(220); flashFeed(code, "dup", "déjà scanné");
        return;
      }
      const unit = await db.unitByCode(code).catch(() => null);
      if (!unit) { beep(160); flashFeed(code, "err", "code inconnu"); return; }
      scanned.set(code, unit);
      beep(660);
      renderFeed();
      updateRecap();
    }
    function renderFeed() {
      feed.innerHTML = Array.from(scanned.values())
        .map(
          (u) => `<div class="scan-item"><span>✅</span><span class="grow">${esc(u.libelle || (u.materiel_types && u.materiel_types.nom) || u.code)}</span>
            <span class="sub">${esc(u.code)}</span>
            <button class="btn sm ghost" data-rm="${esc(u.code)}" style="padding:4px 8px">✕</button></div>`
        )
        .join("");
    }
    function flashFeed(code, cls, msg) {
      const div = document.createElement("div");
      div.className = "scan-item " + cls;
      div.innerHTML = `<span>${cls === "dup" ? "⚠️" : "❌"}</span><span class="grow">${esc(code)}</span><span class="sub">${msg}</span>`;
      feed.prepend(div);
      setTimeout(() => div.remove(), 1800);
    }
    feed.addEventListener("click", (e) => {
      const b = e.target.closest("[data-rm]");
      if (b) { scanned.delete(b.dataset.rm); renderFeed(); updateRecap(); }
    });
    $("#manual-add").onclick = () => { addCode($("#manual-code").value); $("#manual-code").value = ""; };
    $("#manual-code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#manual-add").click(); });

    // -- scanner caméra
    startScanner(addCode);

    // -- validation
    $("#valider").onclick = async () => {
      const rows = [];
      scanned.forEach((u) => rows.push({
        prestation_id: id, sens, type_id: u.type_id, unit_id: u.id, quantite: 1, par_user: state.user.id,
      }));
      qtyTypes.forEach((t) => {
        if (qtys[t.id] > 0)
          rows.push({ prestation_id: id, sens, type_id: t.id, unit_id: null, quantite: qtys[t.id], par_user: state.user.id });
      });
      if (!rows.length) return toast("Rien à valider", "err");
      $("#valider").disabled = true;
      const { error } = await sb.from("mouvements").insert(rows);
      if (error) { $("#valider").disabled = false; return toast(error.message, "err"); }
      // maj statut des unités
      const unitIds = Array.from(scanned.values()).map((u) => u.id);
      if (unitIds.length) {
        await sb.from("materiel_units")
          .update({ statut: sens === "sortie" ? "sorti" : "disponible" })
          .in("id", unitIds);
      }
      stopScanner();
      toast(label + " enregistrée ✔", "ok");
      go("prestation/" + id);
    };
  }

  // ---- Scanner caméra (html5-qrcode) -------------------------------------
  let qrScanner = null;
  async function startScanner(onCode) {
    try {
      qrScanner = new Html5Qrcode("scanner-box", { verbose: false });
      let last = 0;
      await qrScanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decoded) => {
          const now = Date.now();
          if (now - last < 900) return; // anti-rafale
          last = now;
          onCode(decoded);
        },
        () => {}
      );
      const hint = document.getElementById("scan-hint");
      if (hint) hint.textContent = "Caméra active — vise un QR code";
    } catch (e) {
      const box = document.getElementById("scanner-box");
      if (box) box.innerHTML =
        `<div style="padding:24px;color:#fff;text-align:center;font-size:14px">📷 Caméra indisponible.<br>Utilise la saisie manuelle du code ci-dessous.</div>`;
    }
  }
  async function stopScanner() {
    if (qrScanner) {
      try { await qrScanner.stop(); qrScanner.clear(); } catch (e) {}
      qrScanner = null;
    }
  }
  window.addEventListener("hashchange", stopScanner);

  function beep(freq) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = freq; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      o.start(); o.stop(ctx.currentTime + 0.08);
    } catch (e) {}
  }

  // =========================================================================
  //  VUE : Rapport des manquants + facturation
  // =========================================================================
  async function viewManquants(id) {
    const p = await db.prestation(id);
    const bilan = await db.bilan(id);
    const mvts = await db.mouvements(id);
    const facts = await db.facturations(id);

    // cache des noms de types (défini AVANT de construire le HTML)
    const typeMap = {};
    (await db.types()).forEach((t) => (typeMap[t.id] = t));
    const typeName = (tid) => (typeMap[tid] ? typeMap[tid].nom : "Matériel");

    // unités précises manquantes (sorties mais pas revenues)
    const outUnits = new Set(mvts.filter((m) => m.sens === "sortie" && m.unit_id).map((m) => m.unit_id));
    const backUnits = new Set(mvts.filter((m) => m.sens === "retour" && m.unit_id).map((m) => m.unit_id));
    const missingUnitIds = [...outUnits].filter((u) => !backUnits.has(u));

    const manquants = bilan.filter((b) => b.q_manquant > 0);
    const totalFact = facts.filter((f) => f.statut !== "annule").reduce((s, f) => s + Number(f.montant), 0);

    app.innerHTML =
      topbar("Manquants · " + (p.libelle || ""), { back: "prestation/" + id }) +
      `<main>
        ${manquants.length === 0
          ? `<div class="card" style="text-align:center"><div style="font-size:34px">✅</div><b>Tout est revenu !</b><div class="sub">Aucun matériel manquant sur cette prestation.</div></div>`
          : `<div class="section-title">À réclamer / facturer</div>` +
            manquants.map((b) => `
              <div class="card">
                <div class="row between">
                  <div class="grow"><b>${esc(b.type_nom)}</b><div class="sub">${esc(b.categorie||"")} · ${b.q_sortie} sortis, ${b.q_retour} revenus</div></div>
                  <span class="badge red">${b.q_manquant} manquant${b.q_manquant>1?"s":""}</span>
                </div>
                <div class="sub" style="margin-top:6px">Remplacement estimé : ${eur(b.q_manquant * b.prix_unitaire)} (${eur(b.prix_unitaire)}/u)</div>
                <div class="btn-grid" style="margin-top:10px">
                  <button class="btn warn sm" data-fact='${b.type_id}|casse'>Facturer (casse)</button>
                  <button class="btn danger sm" data-fact='${b.type_id}|perte'>Facturer (perte)</button>
                </div>
              </div>`).join("")
        }

        ${missingUnitIds.length ? `<div class="section-title">Caisses/unités précises non revenues</div>
          <div class="card"><div class="sub">${missingUnitIds.length} unité(s) tracée(s) toujours dehors.</div></div>` : ""}

        ${facts.length ? `<div class="section-title">Facturations enregistrées — total ${eur(totalFact)}</div>` +
          facts.map((f) => `<div class="card"><div class="row between">
              <div class="grow"><b>${f.quantite}× ${esc(typeName(f.type_id))}</b><div class="sub">${f.motif} · ${eur(f.montant)}</div></div>
              <span class="badge ${f.statut==="facture"?"green":f.statut==="annule"?"gray":"amber"}">${f.statut.replace("_"," ")}</span>
            </div></div>`).join("") : ""}
      </main>`;

    $$("[data-fact]").forEach((btn) => {
      btn.onclick = async () => {
        const [tid, motif] = btn.dataset.fact.split("|");
        const b = bilan.find((x) => x.type_id === tid);
        if (!b) return;
        btn.disabled = true;
        const { error } = await sb.from("facturations").insert({
          prestation_id: id, type_id: tid, motif,
          quantite: b.q_manquant, prix_unitaire: b.prix_unitaire, statut: "a_facturer",
        });
        if (error) { btn.disabled = false; return toast(error.message, "err"); }
        toast("Ajouté à facturer ✔", "ok");
        render();
      };
    });
  }

  // =========================================================================
  //  VUE : Matériel (catalogue)
  // =========================================================================
  async function viewMateriel() {
    const types = await db.types();
    const byCat = {};
    types.forEach((t) => ((byCat[t.categorie || "Autres"] ||= []).push(t)));
    const body = Object.keys(byCat).sort().map((cat) => `
      <div class="section-title">${esc(cat)}</div>
      ${byCat[cat].map((t) => `
        <div class="card tap" onclick="location.hash='#/type/${t.id}'">
          <div class="grow"><h3>${esc(t.nom)}</h3>
            <div class="sub">${t.suivi==="unite"?"🏷️ Suivi à l'unité (QR)":"🔢 Suivi par quantité"} · ${eur(t.prix_unitaire)}/u</div></div>
          <div style="font-size:22px;color:#cbd5c9">›</div>
        </div>`).join("")}
    `).join("");

    app.innerHTML =
      topbar("Matériel") +
      `<main>${types.length ? body : '<div class="empty"><div class="big">📦</div>Aucun matériel.</div>'}</main>
       <button class="fab" onclick="location.hash='#/type/new'">＋</button>`;
  }

  async function viewTypeDetail(tid) {
    const isNew = tid === "new";
    let t = { nom: "", categorie: "", suivi: "quantite", unite: "pièce", prix_unitaire: 0 };
    let units = [];
    if (!isNew) {
      const { data } = await sb.from("materiel_types").select("*").eq("id", tid).single();
      t = data;
      if (t.suivi === "unite") units = await db.unitsByType(tid);
    }
    app.innerHTML =
      topbar(isNew ? "Nouveau matériel" : t.nom, { back: "materiel" }) +
      `<main>
        <div class="card">
          <label>Nom</label><input id="t-nom" value="${esc(t.nom)}" placeholder="Ex : Assiette plate" />
          <label>Catégorie</label><input id="t-cat" value="${esc(t.categorie||"")}" placeholder="Vaisselle, Caisses…" />
          <div class="field-row">
            <div><label>Type de suivi</label>
              <select id="t-suivi">
                <option value="quantite" ${t.suivi==="quantite"?"selected":""}>Par quantité</option>
                <option value="unite" ${t.suivi==="unite"?"selected":""}>À l'unité (QR)</option>
              </select></div>
            <div><label>Prix remplacement (€)</label><input id="t-prix" type="number" step="0.01" value="${t.prix_unitaire}" /></div>
          </div>
          <button class="btn block" id="save">${isNew?"Créer":"Enregistrer"}</button>
        </div>

        ${!isNew && t.suivi==="unite" ? `
          <div class="section-title">Unités (${units.length}) — QR</div>
          <div class="card">
            <div class="field-row">
              <input id="nb-units" type="number" value="5" min="1" placeholder="Nombre" />
              <button class="btn sm sec" id="gen-units" style="flex:0 0 auto">Générer des unités</button>
            </div>
            ${units.length ? `<button class="btn ghost block" onclick="location.hash='#/etiquettes/${tid}'">🖨️ Imprimer les étiquettes QR</button>` : ""}
            <div style="margin-top:8px">
              ${units.map((u)=>`<div class="mat-line"><div class="name"><b>${esc(u.code)}</b><small>${esc(u.libelle||"")} · ${u.statut}</small></div></div>`).join("")}
            </div>
          </div>` : ""}
      </main>`;

    $("#save").onclick = async () => {
      const payload = {
        nom: $("#t-nom").value.trim(),
        categorie: $("#t-cat").value.trim() || null,
        suivi: $("#t-suivi").value,
        prix_unitaire: parseFloat($("#t-prix").value) || 0,
      };
      if (!payload.nom) return toast("Ajoute un nom", "err");
      if (isNew) {
        const { data, error } = await sb.from("materiel_types").insert(payload).select().single();
        if (error) return toast(error.message, "err");
        go("type/" + data.id);
      } else {
        const { error } = await sb.from("materiel_types").update(payload).eq("id", tid);
        toast(error ? error.message : "Enregistré ✔", error ? "err" : "ok");
        if (!error) render();
      }
    };

    const gen = $("#gen-units");
    if (gen) gen.onclick = async () => {
      const n = Math.max(1, parseInt($("#nb-units").value) || 1);
      const start = units.length;
      const prefix = "GL-" + (t.nom.slice(0, 6).toUpperCase().replace(/[^A-Z]/g, "") || "MAT") + "-";
      const rows = [];
      for (let i = 1; i <= n; i++) {
        const num = start + i;
        rows.push({ type_id: tid, code: prefix + String(num).padStart(5, "0"), libelle: t.nom + " n°" + num });
      }
      const { error } = await sb.from("materiel_units").insert(rows);
      toast(error ? error.message : n + " unité(s) créée(s) ✔", error ? "err" : "ok");
      if (!error) render();
    };
  }

  // =========================================================================
  //  VUE : Étiquettes QR imprimables
  // =========================================================================
  async function viewEtiquettes(tid) {
    const { data: t } = await sb.from("materiel_types").select("*").eq("id", tid).single();
    const units = await db.unitsByType(tid);
    app.innerHTML =
      topbar("Étiquettes · " + t.nom, { back: "type/" + tid, action: "🖨️ Imprimer" }) +
      `<main>
        <div class="sub no-print">Imprime cette page, découpe et colle une étiquette sur chaque ${esc(t.unite||"pièce")}.</div>
        <div class="labels" id="labels"></div>
      </main>`;
    $("#tb-action").onclick = () => window.print();
    const box = $("#labels");
    units.forEach((u) => {
      const div = document.createElement("div");
      div.className = "label";
      const qr = document.createElement("div");
      div.appendChild(qr);
      div.insertAdjacentHTML("beforeend", `<div class="lib">${esc(u.libelle || t.nom)}</div><div class="code">${esc(u.code)}</div>`);
      box.appendChild(div);
      new QRCode(qr, { text: u.code, width: 120, height: 120, correctLevel: QRCode.CorrectLevel.M });
    });
  }

  // =========================================================================
  //  VUE : Clients
  // =========================================================================
  async function viewClients() {
    const clients = await db.clients();
    app.innerHTML =
      topbar("Clients") +
      `<main>
        ${clients.map((c) => `<div class="card"><h3>${esc(c.nom)}</h3><div class="sub">${esc(c.adresse||"")}${c.contact?" · "+esc(c.contact):""}</div></div>`).join("")
          || '<div class="empty"><div class="big">🏢</div>Aucun client.</div>'}
        <div class="section-title">Ajouter un client</div>
        <div class="card">
          <label>Nom</label><input id="c-nom" placeholder="Nom du client" />
          <label>Adresse</label><input id="c-adr" placeholder="Adresse de livraison" />
          <label>Contact</label><input id="c-contact" placeholder="Personne / service" />
          <button class="btn block" id="c-save">Ajouter</button>
        </div>
      </main>`;
    $("#c-save").onclick = async () => {
      const nom = $("#c-nom").value.trim();
      if (!nom) return toast("Ajoute un nom", "err");
      const { error } = await sb.from("clients").insert({
        nom, adresse: $("#c-adr").value.trim() || null, contact: $("#c-contact").value.trim() || null,
      });
      if (error) return toast(error.message, "err");
      toast("Client ajouté ✔", "ok"); render();
    };
  }

  // =========================================================================
  //  VUE : Compte
  // =========================================================================
  async function viewCompte() {
    app.innerHTML =
      topbar("Mon compte") +
      `<main>
        <div class="card">
          <h3>${esc(state.profile?.nom || state.user.email)}</h3>
          <div class="sub">${esc(state.user.email)} · ${esc(state.profile?.role || "livreur")}</div>
        </div>
        <button class="btn ghost block" id="logout">Se déconnecter</button>
        <div class="sub" style="text-align:center;margin-top:24px">GreenLoop · v1.0</div>
      </main>`;
    $("#logout").onclick = async () => { await sb.auth.signOut(); location.reload(); };
  }

  // =========================================================================
  //  AUTHENTIFICATION
  // =========================================================================
  function renderAuth(mode = "login") {
    nav.classList.add("hidden");
    const isSignup = mode === "signup";
    app.innerHTML = `
      <div class="login-wrap">
        <div class="login-logo"><span class="leaf">🌿</span> GreenLoop</div>
        <div class="login-sub">Traçabilité du matériel · BRIFFE</div>
        <div class="card">
          ${isSignup ? `<label>Nom</label><input id="a-nom" placeholder="Ton nom" />` : ""}
          <label>Email</label><input id="a-email" type="email" autocomplete="email" placeholder="livreur@briffe.me" />
          <label>Mot de passe</label><input id="a-pass" type="password" autocomplete="current-password" placeholder="••••••••" />
          <button class="btn block" id="a-go">${isSignup ? "Créer le compte" : "Se connecter"}</button>
          <button class="btn ghost block" id="a-switch">${isSignup ? "J'ai déjà un compte" : "Créer un compte"}</button>
        </div>
      </div>`;
    $("#a-switch").onclick = () => renderAuth(isSignup ? "login" : "signup");
    $("#a-go").onclick = async () => {
      const email = $("#a-email").value.trim();
      const pass = $("#a-pass").value;
      if (!email || !pass) return toast("Email et mot de passe requis", "err");
      $("#a-go").disabled = true;
      if (isSignup) {
        const { error } = await sb.auth.signUp({
          email, password: pass, options: { data: { nom: $("#a-nom")?.value.trim() || email } },
        });
        $("#a-go").disabled = false;
        if (error) return toast(error.message, "err");
        toast("Compte créé ! Connecte-toi.", "ok");
        renderAuth("login");
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password: pass });
        $("#a-go").disabled = false;
        if (error) return toast(error.message, "err");
        boot();
      }
    };
  }

  // =========================================================================
  //  DÉMARRAGE
  // =========================================================================
  async function boot() {
    if (!CONFIGURED) {
      app.innerHTML = `<div class="login-wrap">
        <div class="login-logo"><span class="leaf">🌿</span> GreenLoop</div>
        <div class="card">
          <h3>Configuration requise</h3>
          <p class="sub">Ouvre le fichier <b>config.js</b> et renseigne l'URL et la clé anon de ton projet Supabase, puis recharge. Le guide d'installation détaille chaque étape.</p>
        </div></div>`;
      return;
    }
    const { data } = await sb.auth.getUser();
    if (!data.user) return renderAuth("login");
    state.user = data.user;
    const { data: prof } = await sb.from("profiles").select("*").eq("id", data.user.id).maybeSingle();
    state.profile = prof;
    if (!location.hash) location.hash = "#/prestations";
    render();
  }

  // Service worker (PWA installable / hors-ligne léger)
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  boot();
})();
