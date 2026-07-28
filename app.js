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
    client: async (id) => {
      const { data, error } = await sb.from("clients").select("*").eq("id", id).single();
      if (error) throw error;
      return data;
    },
    soldeClient: (cid) => db.q("v_solde_client", (q) => q.eq("client_id", cid)),
    prestationsByClient: (cid) =>
      db.q("prestations", (q) => q.eq("client_id", cid).order("date_presta", { ascending: false })),
    param: async (cle) => {
      const { data } = await sb.from("parametres").select("valeur").eq("cle", cle).maybeSingle();
      return data ? data.valeur : "";
    },
    setParam: (cle, valeur) => sb.from("parametres").upsert({ cle, valeur }),
    types: () => db.q("materiel_types", (q) => q.eq("actif", true).order("categorie").order("nom")),
    type: async (id) => {
      const { data, error } = await sb.from("materiel_types").select("*").eq("id", id).single();
      if (error) throw error;
      return data;
    },
    typeByCode: async (code) => {
      const { data, error } = await sb
        .from("materiel_types")
        .select("*")
        .eq("code_qr", code.trim())
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
      if (head === "client") {
        if (parts[1] === "new") return viewClientForm("new");
        if (parts[2] === "edit") return viewClientForm(parts[1]);
        return viewClientDetail(parts[1]);
      }
      if (head === "parametres") return viewParametres();
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
              <h3 style="cursor:pointer" ${p.client_id ? `onclick="location.hash='#/client/${p.client_id}'"` : ""}>${esc(p.clients ? p.clients.nom : "Client ?")}</h3>
              <div class="sub">${p.clients ? (p.clients.type_client === "fixe" ? "Client fixe · " : "Client ponctuel · ") : ""}${dfr(p.date_presta)}${p.reference ? " · Réf " + esc(p.reference) : ""}</div>
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
    const label = sens === "sortie" ? "Sortie" : "Retour";
    const verb = sens === "sortie" ? "livrés" : "récupérés";

    // Modèle « un QR par type » : chaque scan incrémente la quantité du type.
    const counts = {};
    types.forEach((t) => (counts[t.id] = 0));
    const byCode = {};
    types.forEach((t) => { if (t.code_qr) byCode[t.code_qr.trim()] = t; });

    // Regroupement par catégorie pour l'affichage
    const byCat = {};
    types.forEach((t) => ((byCat[t.categorie || "Autres"] ||= []).push(t)));

    const lineHtml = (t) => `
      <div class="mat-line" data-line="${t.id}">
        <div class="name"><b>${esc(t.nom)}</b><small>${t.code_qr ? "🏷️ " + esc(t.code_qr) : "sans QR — saisie manuelle"}</small></div>
        <div class="qty" data-type="${t.id}">
          <button data-d="-1">−</button>
          <input type="number" inputmode="numeric" value="0" min="0" data-qtyinput="${t.id}" />
          <button data-d="1">＋</button>
        </div>
      </div>`;

    app.innerHTML =
      topbar(label + " · " + (p.libelle || ""), { back: "prestation/" + id }) +
      `<main>
        <div class="card">
          <div id="scanner-box"></div>
          <div class="scan-hint" id="scan-hint">Scanne le QR d'une caisse… chaque scan = +1</div>
          <div class="field-row" style="margin-top:6px">
            <input id="manual-code" placeholder="ou saisir un code (GL-…)" />
            <button class="btn sm sec" id="manual-add" style="flex:0 0 auto">+1</button>
          </div>
        </div>

        <div class="section-title">Matériel ${verb}</div>
        <div class="list" id="qty-card">
          ${Object.keys(byCat).sort().map((cat) => `
            <div class="card">
              <div class="sub" style="font-weight:700;margin-bottom:4px">${esc(cat)}</div>
              ${byCat[cat].map(lineHtml).join("")}
            </div>`).join("")}
        </div>

        <div class="card" style="position:sticky;bottom:calc(84px + var(--safe-b))">
          <div class="row between" style="margin-bottom:8px">
            <b id="recap">0 pièce(s) ${verb}</b>
          </div>
          <button class="btn ${sens==="sortie"?"":"sec"} block" id="valider">Valider ${label.toLowerCase()}</button>
        </div>
      </main>`;

    const updateRecap = () => {
      const n = Object.values(counts).reduce((a, b) => a + b, 0);
      $("#recap").textContent = `${n} pièce(s) ${verb}`;
    };
    const setCount = (tid, v) => {
      counts[tid] = Math.max(0, v);
      const input = $(`[data-qtyinput="${tid}"]`);
      if (input) input.value = counts[tid];
      updateRecap();
    };
    const flashLine = (tid) => {
      const line = $(`[data-line="${tid}"]`);
      if (!line) return;
      line.style.transition = "background .1s";
      line.style.background = "#dcfce7";
      setTimeout(() => (line.style.background = ""), 350);
    };

    // steppers + saisie directe
    $("#qty-card").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-d]");
      if (!b) return;
      const tid = b.closest(".qty").dataset.type;
      setCount(tid, (counts[tid] || 0) + parseInt(b.dataset.d));
    });
    $("#qty-card").addEventListener("input", (e) => {
      const inp = e.target.closest("[data-qtyinput]");
      if (!inp) return;
      counts[inp.dataset.qtyinput] = Math.max(0, parseInt(inp.value) || 0);
      updateRecap();
    });

    // scan / saisie d'un code -> +1 sur le type correspondant
    function addCode(code) {
      code = (code || "").trim();
      if (!code) return;
      const t = byCode[code];
      const hint = $("#scan-hint");
      if (!t) {
        beep(160);
        if (hint) hint.textContent = "❌ Code inconnu : " + code;
        return;
      }
      setCount(t.id, (counts[t.id] || 0) + 1);
      flashLine(t.id);
      beep(660);
      if (hint) hint.textContent = `✅ ${t.nom} : ${counts[t.id]}`;
      // amène la ligne à l'écran
      const line = $(`[data-line="${t.id}"]`);
      if (line) line.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    $("#manual-add").onclick = () => { addCode($("#manual-code").value); $("#manual-code").value = ""; };
    $("#manual-code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#manual-add").click(); });

    startScanner(addCode);

    $("#valider").onclick = async () => {
      const rows = [];
      types.forEach((t) => {
        if (counts[t.id] > 0)
          rows.push({ prestation_id: id, sens, type_id: t.id, unit_id: null, quantite: counts[t.id], par_user: state.user.id });
      });
      if (!rows.length) return toast("Rien à valider", "err");
      $("#valider").disabled = true;
      const { error } = await sb.from("mouvements").insert(rows);
      if (error) { $("#valider").disabled = false; return toast(error.message, "err"); }
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
    const facts = await db.facturations(id);

    // cache des noms de types (défini AVANT de construire le HTML)
    const typeMap = {};
    (await db.types()).forEach((t) => (typeMap[t.id] = t));
    const typeName = (tid) => (typeMap[tid] ? typeMap[tid].nom : "Matériel");

    const manquants = bilan.filter((b) => b.q_manquant > 0);
    const totalFact = facts.filter((f) => f.statut !== "annule").reduce((s, f) => s + Number(f.montant), 0);

    app.innerHTML =
      topbar("Manquants · " + (p.libelle || ""), { back: "prestation/" + id }) +
      `<main>
        ${manquants.length === 0
          ? `<div class="card" style="text-align:center"><div style="font-size:34px">✅</div><b>Tout est revenu !</b><div class="sub">Aucun matériel manquant sur cette prestation.</div></div>`
          : `<button class="btn block" id="mail-compta">✉️ Envoyer les manquants à la compta</button>
             <div class="section-title">À réclamer / facturer</div>` +
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

        ${facts.length ? `<div class="section-title">Facturations enregistrées — total ${eur(totalFact)}</div>` +
          facts.map((f) => `<div class="card"><div class="row between">
              <div class="grow"><b>${f.quantite}× ${esc(typeName(f.type_id))}</b><div class="sub">${f.motif} · ${eur(f.montant)}</div></div>
              <span class="badge ${f.statut==="facture"?"green":f.statut==="annule"?"gray":"amber"}">${f.statut.replace("_"," ")}</span>
            </div></div>`).join("") : ""}
      </main>`;

    const mailBtn = $("#mail-compta");
    if (mailBtn) mailBtn.onclick = async () => {
      const compta = await db.param("email_compta");
      if (!compta) return toast("Renseigne l'email de la compta dans Paramètres", "err");
      const cli = p.clients ? p.clients.nom : "Client ?";
      const lignes = manquants.map((b) => `- ${b.type_nom} : ${b.q_manquant} manquant(s) (${eur(b.q_manquant * b.prix_unitaire)})`).join("\n");
      const total = manquants.reduce((s, b) => s + b.q_manquant * b.prix_unitaire, 0);
      const body =
`Prestation : ${p.libelle || ""}
Client : ${cli}
Date : ${dfr(p.date_presta)}

Matériel manquant à facturer :
${lignes}

Total : ${eur(total)}`;
      openMail(compta, `Manquants à facturer — ${cli} (${p.libelle || ""})`, body);
    };

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
            <div class="sub">${t.code_qr ? "🏷️ " + esc(t.code_qr) : "sans QR"} · ${eur(t.prix_unitaire)}/u</div></div>
          <div style="font-size:22px;color:#cbd5c9">›</div>
        </div>`).join("")}
    `).join("");

    app.innerHTML =
      topbar("Matériel", { action: "⬇︎ CSV" }) +
      `<main>
        ${types.length ? body : '<div class="empty"><div class="big">📦</div>Aucun matériel.</div>'}
        <div class="sub no-print" style="margin-top:16px">Le bouton « CSV » exporte tous les types + leur code QR, pour générer/réimprimer les étiquettes en lot dans Brother P-touch Editor.</div>
      </main>
       <button class="fab" onclick="location.hash='#/type/new'">＋</button>`;
    const csvBtn = $("#tb-action");
    if (csvBtn) csvBtn.onclick = () => exportTypesCSV(types);
  }

  // Export CSV (nom;categorie;code_qr;prix) pour fusion Brother P-touch Editor
  function exportTypesCSV(types) {
    const head = "nom;categorie;code_qr;prix_remplacement";
    const lines = types.map((t) =>
      [t.nom, t.categorie || "", t.code_qr || "", String(t.prix_unitaire).replace(".", ",")]
        .map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(";")
    );
    const csv = "﻿" + [head, ...lines].join("\r\n"); // BOM pour Excel/Brother
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "greenloop-materiel.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // Génère un code lisible à partir d'un nom (ex "Caisse Araven 20L" -> "GL-CAISSEARAVEN20L")
  function slugCode(nom) {
    const base = (nom || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")   // enlève les accents
      .toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 18);
    return "GL-" + (base || "MAT");
  }

  async function viewTypeDetail(tid) {
    const isNew = tid === "new";
    let t = { nom: "", categorie: "", unite: "pièce", prix_unitaire: 0, code_qr: "" };
    if (!isNew) t = await db.type(tid);

    app.innerHTML =
      topbar(isNew ? "Nouveau matériel" : t.nom, { back: "materiel" }) +
      `<main>
        <div class="card">
          <label>Nom</label><input id="t-nom" value="${esc(t.nom)}" placeholder="Ex : Caisse Araven 20L" />
          <label>Catégorie</label><input id="t-cat" value="${esc(t.categorie||"")}" placeholder="Caisses, Vaisselle…" />
          <label>Prix de remplacement (€) — sert à la facturation casse/perte</label>
          <input id="t-prix" type="number" step="0.01" value="${t.prix_unitaire}" />
          <label>Code QR (identique sur tous les exemplaires de ce type)</label>
          <div class="field-row">
            <input id="t-code" value="${esc(t.code_qr||"")}" placeholder="GL-…" style="font-family:monospace" />
            <button class="btn sm sec" id="gen-code" style="flex:0 0 auto">Auto</button>
          </div>
          <button class="btn block" id="save">${isNew?"Créer":"Enregistrer"}</button>
        </div>

        ${!isNew && t.code_qr ? `
          <div class="card" style="text-align:center">
            <div id="qr-preview" style="display:flex;justify-content:center;margin:6px 0"></div>
            <div class="code">${esc(t.code_qr)}</div>
            <button class="btn ghost block" onclick="location.hash='#/etiquettes/${tid}'">🖨️ Imprimer les étiquettes (choisir le nombre)</button>
          </div>` : ""}
      </main>`;

    // aperçu du QR
    const prev = $("#qr-preview");
    if (prev && t.code_qr) new QRCode(prev, { text: t.code_qr, width: 130, height: 130, correctLevel: QRCode.CorrectLevel.M });

    $("#gen-code").onclick = () => { $("#t-code").value = slugCode($("#t-nom").value); };

    $("#save").onclick = async () => {
      const nom = $("#t-nom").value.trim();
      if (!nom) return toast("Ajoute un nom", "err");
      let code = $("#t-code").value.trim();
      if (!code) code = slugCode(nom);            // auto si vide
      const payload = {
        nom,
        categorie: $("#t-cat").value.trim() || null,
        prix_unitaire: parseFloat($("#t-prix").value) || 0,
        code_qr: code || null,
      };
      $("#save").disabled = true;
      let error;
      if (isNew) {
        const res = await sb.from("materiel_types").insert(payload).select().single();
        error = res.error;
        if (!error) return go("type/" + res.data.id);
      } else {
        error = (await sb.from("materiel_types").update(payload).eq("id", tid)).error;
      }
      $("#save").disabled = false;
      if (error) {
        return toast(error.message.includes("duplicate") || error.code === "23505"
          ? "Ce code QR est déjà utilisé par un autre type" : error.message, "err");
      }
      toast("Enregistré ✔", "ok");
      render();
    };
  }

  // =========================================================================
  //  VUE : Étiquettes QR imprimables
  // =========================================================================
  async function viewEtiquettes(tid) {
    const t = await db.type(tid);
    if (!t.code_qr) {
      app.innerHTML = topbar("Étiquettes", { back: "type/" + tid }) +
        `<main><div class="card">Ce type n'a pas encore de code QR. Reviens en arrière et clique « Auto » pour en générer un.</div></main>`;
      return;
    }
    app.innerHTML =
      topbar("Étiquettes · " + t.nom, { back: "type/" + tid, action: "🖨️ Imprimer" }) +
      `<main>
        <div class="card no-print">
          <div class="sub">Toutes les étiquettes de « ${esc(t.nom)} » portent le même QR (<b>${esc(t.code_qr)}</b>).
          Choisis combien d'exemplaires imprimer, puis colles-en une sur chaque caisse.</div>
          <label>Nombre d'étiquettes</label>
          <div class="field-row">
            <input id="nb" type="number" value="10" min="1" max="200" />
            <button class="btn sm" id="apply" style="flex:0 0 auto">Générer</button>
          </div>
          <div class="sub" style="margin-top:8px">💡 Pour ton imprimante Brother (rouleaux DK) : soit tu imprimes cette page directement en choisissant l'imprimante Brother, soit tu utilises le CSV (écran Matériel) dans P-touch Editor pour régler le nombre de copies.</div>
        </div>
        <div class="labels" id="labels"></div>
      </main>`;
    $("#tb-action").onclick = () => window.print();

    const render = () => {
      const n = Math.min(200, Math.max(1, parseInt($("#nb").value) || 1));
      const box = $("#labels");
      box.innerHTML = "";
      for (let i = 0; i < n; i++) {
        const div = document.createElement("div");
        div.className = "label";
        const qr = document.createElement("div");
        div.appendChild(qr);
        div.insertAdjacentHTML("beforeend", `<div class="lib">${esc(t.nom)}</div><div class="code">${esc(t.code_qr)}</div>`);
        box.appendChild(div);
        new QRCode(qr, { text: t.code_qr, width: 120, height: 120, correctLevel: QRCode.CorrectLevel.M });
      }
    };
    $("#apply").onclick = render;
    render();
  }

  // =========================================================================
  //  Emails (récap) — via le client mail (mailto)
  // =========================================================================
  function openMail(to, subject, body) {
    const url = "mailto:" + encodeURIComponent(to || "") +
      "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(body);
    window.location.href = url;
  }
  const clientBadge = (t) =>
    t === "fixe" ? '<span class="badge blue">Fixe</span>' : '<span class="badge gray">Ponctuel</span>';

  // =========================================================================
  //  VUE : Clients (annuaire)
  // =========================================================================
  async function viewClients() {
    const clients = await db.clients();
    const nFixe = clients.filter((c) => c.type_client === "fixe").length;
    const nPonc = clients.filter((c) => c.type_client === "ponctuel").length;
    const card = (c) => `
      <div class="card tap" onclick="location.hash='#/client/${c.id}'">
        <div class="grow">
          <div class="row between"><h3 class="truncate">${esc(c.nom)}</h3>${clientBadge(c.type_client)}</div>
          <div class="sub">${esc(c.adresse_livraison || c.adresse || "")}${c.contact ? " · " + esc(c.contact) : ""}</div>
        </div>
        <div style="font-size:22px;color:#cbd5c9">›</div>
      </div>`;

    app.innerHTML =
      topbar("Clients") +
      `<main>
        <div class="seg" id="filter">
          <button data-f="tous" class="active">Tous (${clients.length})</button>
          <button data-f="fixe">Fixes (${nFixe})</button>
          <button data-f="ponctuel">Ponctuels (${nPonc})</button>
        </div>
        <input id="search" placeholder="🔍 Rechercher un client…" style="margin-bottom:10px" />
        <div id="clist"></div>
      </main>
      <button class="fab" onclick="location.hash='#/client/new'">＋</button>`;

    let f = "tous", q = "";
    const draw = () => {
      let list = clients;
      if (f !== "tous") list = list.filter((c) => c.type_client === f);
      if (q) list = list.filter((c) => (c.nom || "").toLowerCase().includes(q));
      $("#clist").innerHTML = list.length
        ? list.map(card).join("")
        : '<div class="empty"><div class="big">🏢</div>Aucun client.</div>';
    };
    $("#filter").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      f = b.dataset.f;
      $$("#filter button").forEach((x) => x.classList.toggle("active", x === b));
      draw();
    });
    $("#search").addEventListener("input", (e) => { q = e.target.value.trim().toLowerCase(); draw(); });
    draw();
  }

  // =========================================================================
  //  VUE : Fiche client (solde détenu + récap + facturation)
  // =========================================================================
  async function viewClientDetail(id) {
    const c = await db.client(id);
    const solde = await db.soldeClient(id);
    const totalPieces = solde.reduce((s, x) => s + x.solde, 0);
    const totalValeur = solde.reduce((s, x) => s + x.solde * Number(x.prix_unitaire), 0);
    const fixe = c.type_client === "fixe";

    app.innerHTML =
      topbar(c.nom, { back: "clients", action: "Modifier" }) +
      `<main>
        <div class="card">
          <div class="row between">
            <div class="grow">
              ${c.adresse ? `<div class="sub">📍 ${esc(c.adresse)}</div>` : ""}
              ${c.adresse_livraison ? `<div class="sub">🚚 Livraison : ${esc(c.adresse_livraison)}</div>` : ""}
              <div class="sub">${c.contact ? esc(c.contact) : ""}${c.email ? " · " + esc(c.email) : ""}${c.telephone ? " · " + esc(c.telephone) : ""}</div>
            </div>
            ${clientBadge(c.type_client)}
          </div>
        </div>

        <div class="section-title">Matériel détenu à l'instant T</div>
        ${solde.length === 0
          ? `<div class="card" style="text-align:center"><div style="font-size:30px">✅</div>Ce client ne détient aucun matériel.</div>`
          : `<div class="card">
              ${solde.map((x) => `
                <div class="mat-line">
                  <div class="name"><b>${esc(x.type_nom)}</b><small>${esc(x.categorie || "")} · ${eur(x.prix_unitaire)}/u</small></div>
                  <span class="badge ${x.solde > 0 ? "amber" : "green"}">${x.solde}</span>
                </div>`).join("")}
              <div class="divider"></div>
              <div class="row between"><b>${totalPieces} pièce(s)</b><b>${eur(totalValeur)}</b></div>
            </div>`}

        ${solde.length ? `
          <button class="btn block" id="recap">✉️ ${fixe ? "Envoyer le récap au client" : "Envoyer les manquants à la compta"}</button>
          <button class="btn warn block" id="facturer">💶 Facturer ce matériel (perte/casse)</button>
        ` : ""}

        <div class="section-title">Prestations</div>
        <div class="card" id="prestas"><div class="sub">Chargement…</div></div>

        <div class="btn-grid" style="margin-top:16px">
          <button class="btn sec" id="edit">✏️ Modifier</button>
          <button class="btn ghost" id="del" style="color:var(--danger)">🗑 Supprimer</button>
        </div>
      </main>`;

    $("#tb-action").onclick = () => go("client/" + id + "/edit");
    $("#edit").onclick = () => go("client/" + id + "/edit");

    // suppression en deux temps (pas de pop-up bloquant)
    let armed = false;
    const delBtn = $("#del");
    delBtn.onclick = async () => {
      if (!armed) {
        armed = true;
        delBtn.textContent = "Confirmer la suppression ?";
        delBtn.classList.remove("ghost");
        delBtn.classList.add("danger");
        setTimeout(() => {
          if (!armed) return;
          armed = false;
          delBtn.textContent = "🗑 Supprimer";
          delBtn.classList.add("ghost");
          delBtn.classList.remove("danger");
        }, 4000);
        return;
      }
      delBtn.disabled = true;
      const { error } = await sb.from("clients").delete().eq("id", id);
      if (error) { delBtn.disabled = false; return toast(error.message, "err"); }
      toast("Client supprimé ✔", "ok");
      go("clients");
    };

    // liste des prestations du client
    const prestas = await db.prestationsByClient(id);
    $("#prestas").innerHTML = prestas.length
      ? prestas.map((p) => `<div class="mat-line" onclick="location.hash='#/prestation/${p.id}'" style="cursor:pointer">
          <div class="name"><b>${esc(p.libelle || "Prestation")}</b><small>${dfr(p.date_presta)}</small></div>
          <div style="color:#cbd5c9">›</div></div>`).join("")
      : '<div class="sub">Aucune prestation.</div>';

    // récap par email
    const recapBtn = $("#recap");
    if (recapBtn) recapBtn.onclick = async () => {
      const lignes = solde.map((x) => `- ${x.type_nom} : ${x.solde}`).join("\n");
      if (fixe) {
        if (!c.email) return toast("Ce client n'a pas d'email — ajoute-le via Modifier", "err");
        const body =
`Bonjour,

Voici le récapitulatif du matériel BRIFFE actuellement en votre possession :

${lignes}

Total : ${totalPieces} pièce(s), valeur de remplacement ${eur(totalValeur)}.

Merci de nous signaler tout élément manquant, cassé ou perdu afin de régulariser.

Bien cordialement,
L'équipe BRIFFE`;
        openMail(c.email, `Récapitulatif matériel BRIFFE — ${c.nom}`, body);
      } else {
        const compta = await db.param("email_compta");
        if (!compta) return toast("Renseigne l'email de la compta dans Paramètres", "err");
        const body =
`Matériel non restitué par le client ${c.nom} :

${lignes}

Total : ${totalPieces} pièce(s), soit ${eur(totalValeur)} à facturer.`;
        openMail(compta, `Matériel à facturer — ${c.nom}`, body);
      }
    };

    // facturation (niveau client)
    const factBtn = $("#facturer");
    if (factBtn) factBtn.onclick = async () => {
      factBtn.disabled = true;
      const rows = solde.filter((x) => x.solde > 0).map((x) => ({
        client_id: id, prestation_id: null, type_id: x.type_id,
        motif: "perte", quantite: x.solde, prix_unitaire: x.prix_unitaire, statut: "a_facturer",
      }));
      if (!rows.length) { factBtn.disabled = false; return toast("Rien à facturer", "err"); }
      const { error } = await sb.from("facturations").insert(rows);
      factBtn.disabled = false;
      toast(error ? error.message : `${rows.length} ligne(s) ajoutée(s) à facturer ✔`, error ? "err" : "ok");
    };
  }

  // =========================================================================
  //  VUE : Créer / modifier un client
  // =========================================================================
  async function viewClientForm(id) {
    const isNew = id === "new";
    let c = { nom: "", type_client: "ponctuel", adresse: "", contact: "", email: "", telephone: "", sextan_id: "" };
    if (!isNew) c = await db.client(id);
    app.innerHTML =
      topbar(isNew ? "Nouveau client" : "Modifier — " + c.nom, { back: isNew ? "clients" : "client/" + id }) +
      `<main>
        <div class="card">
          <label>Nom</label><input id="c-nom" value="${esc(c.nom)}" placeholder="Nom du client" />
          <label>Type de client</label>
          <select id="c-type">
            <option value="ponctuel" ${c.type_client === "ponctuel" ? "selected" : ""}>Ponctuel (tout revient au débarrassage)</option>
            <option value="fixe" ${c.type_client === "fixe" ? "selected" : ""}>Fixe (garde du matériel d'une fois sur l'autre)</option>
          </select>
          <label>Adresse (siège / facturation)</label><input id="c-adr" value="${esc(c.adresse || "")}" placeholder="Adresse principale" />
          <label>Adresse de livraison</label><input id="c-adrliv" value="${esc(c.adresse_livraison || "")}" placeholder="Si différente de l'adresse principale" />
          <label>Contact</label><input id="c-contact" value="${esc(c.contact || "")}" placeholder="Personne / service" />
          <div class="field-row">
            <div><label>Email</label><input id="c-email" type="email" value="${esc(c.email || "")}" placeholder="pour le récap" /></div>
            <div><label>Téléphone</label><input id="c-tel" value="${esc(c.telephone || "")}" /></div>
          </div>
          <label>ID Sextan (optionnel)</label><input id="c-sextan" value="${esc(c.sextan_id || "")}" />
          <button class="btn block" id="save">${isNew ? "Créer" : "Enregistrer"}</button>
        </div>
      </main>`;
    $("#save").onclick = async () => {
      const nom = $("#c-nom").value.trim();
      if (!nom) return toast("Ajoute un nom", "err");
      const payload = {
        nom,
        type_client: $("#c-type").value,
        adresse: $("#c-adr").value.trim() || null,
        adresse_livraison: $("#c-adrliv").value.trim() || null,
        contact: $("#c-contact").value.trim() || null,
        email: $("#c-email").value.trim() || null,
        telephone: $("#c-tel").value.trim() || null,
        sextan_id: $("#c-sextan").value.trim() || null,
      };
      $("#save").disabled = true;
      if (isNew) {
        const { data, error } = await sb.from("clients").insert(payload).select().single();
        if (error) { $("#save").disabled = false; return toast(error.message, "err"); }
        go("client/" + data.id);
      } else {
        const { error } = await sb.from("clients").update(payload).eq("id", id);
        $("#save").disabled = false;
        toast(error ? error.message : "Enregistré ✔", error ? "err" : "ok");
        if (!error) go("client/" + id);
      }
    };
  }

  // =========================================================================
  //  VUE : Paramètres
  // =========================================================================
  async function viewParametres() {
    const compta = await db.param("email_compta");
    app.innerHTML =
      topbar("Paramètres", { back: "compte" }) +
      `<main>
        <div class="card">
          <label>Email du service comptabilité</label>
          <input id="p-compta" type="email" value="${esc(compta)}" placeholder="compta@briffe.me" />
          <div class="sub" style="margin-top:6px">Destinataire des manquants à facturer pour les clients ponctuels.</div>
          <button class="btn block" id="p-save">Enregistrer</button>
        </div>
      </main>`;
    $("#p-save").onclick = async () => {
      const { error } = await db.setParam("email_compta", $("#p-compta").value.trim());
      toast(error ? error.message : "Enregistré ✔", error ? "err" : "ok");
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
        <button class="btn sec block" onclick="location.hash='#/parametres'">⚙️ Paramètres</button>
        <button class="btn ghost block" id="logout">Se déconnecter</button>
        <div class="sub" style="text-align:center;margin-top:24px">GreenLoop · v1.1</div>
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
