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
  const isAdmin = () => state.profile && state.profile.role === "admin";

  const MOTIF_LABEL = {
    initial: "Parc initial", rachat: "Rachat", perte: "Perte (non retrouvé)",
    casse_salarie: "Casse salarié", inventaire: "Correction d'inventaire", autre: "Autre",
  };

  // Recalcule le parc = somme des deltas du journal, et le met à jour sur le type
  async function recomputeStock(typeId) {
    const rows = await db.parcJournal(typeId);
    const total = rows.reduce((a, r) => a + (r.delta || 0), 0);
    await sb.from("materiel_types").update({ stock_total: total }).eq("id", typeId);
    return total;
  }
  // Date+heure courtes
  const dfrt = (iso) => {
    try { return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return iso; }
  };

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
    soldeAll: () => db.q("v_solde_client"),
    categories: () => db.q("materiel_categories", (q) => q.order("nom")),
    prestationsByClient: (cid) =>
      db.q("prestations", (q) => q.eq("client_id", cid).order("date_presta", { ascending: false })),
    param: async (cle) => {
      const { data } = await sb.from("parametres").select("valeur").eq("cle", cle).maybeSingle();
      return data ? data.valeur : "";
    },
    setParam: (cle, valeur) => sb.from("parametres").upsert({ cle, valeur }),
    types: () => db.q("materiel_types", (q) => q.eq("actif", true).order("categorie").order("nom")),
    typesArchived: () => db.q("materiel_types", (q) => q.eq("actif", false).order("nom")),
    parcJournal: (tid) => db.q("parc_journal", (q) => q.eq("type_id", tid).order("created_at", { ascending: false })),
    movementsByType: async (tid) => {
      const { data, error } = await sb.from("mouvements")
        .select("*, prestations(libelle, date_presta, clients(nom))")
        .eq("type_id", tid).order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
    usersList: () => db.q("profiles", (q) => q.order("nom")),
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
        if (sub === "recuperation") return viewRecuperation(id);
        if (sub === "manquants") return viewManquants(id);
        return viewPrestationDetail(id);
      }
      if (head === "nouvelle-presta") return viewPrestaForm();
      if (head === "materiel" && parts.length === 1) return viewMateriel();
      if (head === "archives") return viewArchives();
      if (head === "categories") return viewCategories();
      if (head === "journal") return viewParcJournal(parts[1]);
      if (head === "admin") return viewAdmin();
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
  const STATUT_LABEL = {
    en_cours: "En préparation",
    en_livraison: "En cours de livraison",
    a_recuperer: "Livré – à récupérer",
    recupere: "Récupéré",
    livre: "Livré",
    clos: "Clos",
  };
  const prestaBadge = (s) => {
    const cls = { en_cours: "gray", en_livraison: "blue", a_recuperer: "amber", recupere: "green", livre: "green", clos: "gray" }[s] || "gray";
    return `<span class="badge ${cls}">${esc(STATUT_LABEL[s] || s)}</span>`;
  };

  // =========================================================================
  //  VUE : Liste des prestations
  // =========================================================================
  async function viewPrestations() {
    const list = await db.prestations();
    const cli = {};
    (await db.clients()).forEach((c) => (cli[c.id] = c));

    const isAO = (p) => (cli[p.client_id] && cli[p.client_id].categorie || "").toLowerCase().includes("appel");
    const typeOf = (p) => cli[p.client_id] ? cli[p.client_id].type_client : null;
    const counts = {
      tout: list.length,
      fixe: list.filter((p) => typeOf(p) === "fixe").length,
      ponctuel: list.filter((p) => typeOf(p) === "ponctuel").length,
      ao: list.filter(isAO).length,
    };

    const card = (p) => `
      <div class="card tap" onclick="location.hash='#/prestation/${p.id}'">
        <div class="grow">
          <div class="row between">
            <h3 class="truncate">${esc(p.libelle || p.reference || "Prestation")}</h3>
            ${prestaBadge(p.statut)}
          </div>
          <div class="sub">${esc(cli[p.client_id] ? cli[p.client_id].nom : "Client ?")} · ${dfr(p.date_presta)}</div>
        </div>
        <div style="font-size:22px;color:#cbd5c9">›</div>
      </div>`;

    app.innerHTML =
      topbar("Prestations") +
      `<main>
        <div class="seg" id="pfilter">
          <button data-f="tout" class="active">Tout (${counts.tout})</button>
          <button data-f="fixe">Fixes (${counts.fixe})</button>
          <button data-f="ponctuel">Ponctuels (${counts.ponctuel})</button>
          <button data-f="ao">Appels d'offre (${counts.ao})</button>
        </div>
        <div id="plist"></div>
      </main>
      <button class="fab" onclick="location.hash='#/nouvelle-presta'">＋</button>`;

    let f = "tout";
    const draw = () => {
      let l = list;
      if (f === "fixe") l = list.filter((p) => typeOf(p) === "fixe");
      else if (f === "ponctuel") l = list.filter((p) => typeOf(p) === "ponctuel");
      else if (f === "ao") l = list.filter(isAO);
      $("#plist").innerHTML = l.length
        ? l.map(card).join("")
        : `<div class="empty"><div class="big">📋</div>Aucune prestation.</div>`;
    };
    $("#pfilter").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      f = b.dataset.f;
      $$("#pfilter button").forEach((x) => x.classList.toggle("active", x === b));
      draw();
    });
    draw();
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
            <div><label>Date de livraison</label><input id="f-date" type="date" value="${new Date().toISOString().slice(0,10)}" /></div>
            <div><label>Numéro</label><input id="f-ref" placeholder="N° dossier" /></div>
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
        </div>

        <div class="section-title">Étape en cours</div>
        <div id="workflow"></div>
      </main>`;

    // ---- Workflow guidé selon le statut et le type de client ----
    const fixe = p.clients && p.clients.type_client === "fixe";
    const wf = $("#workflow");
    const bigBtn = (label, sub, cls, onclick) =>
      `<button class="btn ${cls} block" style="padding:18px" onclick="${onclick}">${label}<br><small style="font-weight:500">${sub}</small></button>`;

    if (p.statut === "en_cours") {
      wf.innerHTML = bigBtn("📤 Valider la sortie (quai)", "Enregistre le matériel chargé au départ", "",
        `location.hash='#/prestation/${id}/sortie'`);
    } else if (p.statut === "en_livraison") {
      if (fixe) {
        wf.innerHTML = bigBtn("✅ Valider livraison + récupération", "Ce qui est repris est enregistré en même temps", "",
          `location.hash='#/prestation/${id}/retour'`);
      } else {
        wf.innerHTML =
          `<div class="card"><div class="sub">Matériel chargé, en route vers le client.</div></div>` +
          `<button class="btn block" id="wf-livre" style="padding:18px">✅ Confirmer la livraison<br><small style="font-weight:500">Le matériel est déposé chez le client</small></button>`;
        $("#wf-livre").onclick = async () => {
          const { error } = await sb.from("prestations").update({ statut: "a_recuperer" }).eq("id", id);
          if (error) return toast(error.message, "err");
          toast("Livraison confirmée ✔", "ok"); render();
        };
      }
    } else if (p.statut === "a_recuperer") {
      wf.innerHTML = bigBtn("📥 Récupérer le matériel", "Pointe le matériel repris chez le client", "",
        `location.hash='#/prestation/${id}/recuperation'`);
    } else if (p.statut === "recupere" || p.statut === "livre") {
      wf.innerHTML =
        `<div class="card" style="text-align:center"><div style="font-size:30px">✅</div><b>Prestation ${STATUT_LABEL[p.statut].toLowerCase()}.</b>
          ${totalManq ? `<div class="sub" style="margin-top:6px">${totalManq} pièce(s) non restituée(s) — voir la fiche client pour la facturation.</div>` : `<div class="sub" style="margin-top:6px">Tout est réglé.</div>`}</div>`;
    }

    // Accès discret pour corriger une étape si besoin (insertAdjacentHTML pour ne pas
    // détruire les gestionnaires d'événements déjà attachés ci-dessus)
    wf.insertAdjacentHTML("beforeend", `<div class="sub" style="text-align:center;margin-top:14px">
      <a href="#/prestation/${id}/sortie" style="color:var(--muted)">Revoir la sortie</a>
      ${!fixe ? ` · <a href="#/prestation/${id}/recuperation" style="color:var(--muted)">Récupération</a>` : ` · <a href="#/prestation/${id}/retour" style="color:var(--muted)">Récupération</a>`}
    </div>`);
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

    const typeById = {};
    types.forEach((t) => (typeById[t.id] = t));
    const typeOptions = '<option value="">— matériel —</option>' +
      types.map((t) => `<option value="${t.id}">${esc(t.nom)}</option>`).join("");

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

        ${sens === "retour" ? `
        <div class="section-title">⚠️ Casses & pertes constatées</div>
        <div class="card">
          <div class="sub" style="margin-bottom:6px">Vérifie l'intégrité du matériel. Déclare ici ce qui revient cassé ou ce qui manque — ce sera directement ajouté à facturer.</div>
          <div id="cp-list"></div>
          <button class="btn sec block" id="cp-add">＋ Déclarer une casse / perte</button>
        </div>` : ""}

        <div class="card" style="position:sticky;bottom:calc(84px + var(--safe-b))">
          <div class="row between" style="margin-bottom:8px">
            <b id="recap">0 pièce(s) ${verb}</b>
          </div>
          <button class="btn ${sens==="sortie"?"":"sec"} block" id="valider">Valider ${label.toLowerCase()}</button>
        </div>
      </main>`;

    // --- déclaration des casses/pertes (retour uniquement) ---
    const cpAdd = $("#cp-add");
    if (cpAdd) {
      const addRow = () => {
        const row = document.createElement("div");
        row.className = "cp-row";
        row.style.cssText = "border-top:1px solid var(--line);padding:10px 0";
        row.innerHTML = `
          <select class="cp-type" style="margin-bottom:6px">${typeOptions}</select>
          <div class="row" style="gap:8px">
            <select class="cp-motif" style="flex:1">
              <option value="casse">🔨 Cassé</option>
              <option value="perte">❓ Perdu / manquant</option>
            </select>
            <input type="number" class="cp-qty" inputmode="numeric" value="1" min="1" style="width:72px;text-align:center" />
            <button class="btn sm ghost cp-rm" style="flex:0 0 auto;color:var(--danger)">✕</button>
          </div>`;
        $("#cp-list").appendChild(row);
        row.querySelector(".cp-rm").onclick = () => row.remove();
      };
      cpAdd.onclick = addRow;
    }

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

      // casses & pertes déclarées (retour) -> facturations + règlement du solde
      const facts = [];
      $$(".cp-row").forEach((row) => {
        const tid = row.querySelector(".cp-type").value;
        const motif = row.querySelector(".cp-motif").value;
        const qte = Math.max(0, parseInt(row.querySelector(".cp-qty").value) || 0);
        if (!tid || qte <= 0) return;
        const t = typeById[tid];
        facts.push({
          prestation_id: id, client_id: p.client_id || null, type_id: tid,
          motif, quantite: qte, prix_unitaire: t ? t.prix_unitaire : 0, statut: "a_facturer",
        });
        // un cassé/perdu est "sorti du parc" chez le client : on le compte en retour
        // pour qu'il n'apparaisse plus comme manquant (il est désormais facturé)
        rows.push({ prestation_id: id, sens: "retour", type_id: tid, unit_id: null, quantite: qte, par_user: state.user.id });
      });

      if (!rows.length && !facts.length) return toast("Rien à valider", "err");
      $("#valider").disabled = true;
      if (rows.length) {
        const { error } = await sb.from("mouvements").insert(rows);
        if (error) { $("#valider").disabled = false; return toast(error.message, "err"); }
      }
      if (facts.length) {
        const { error } = await sb.from("facturations").insert(facts);
        if (error) { $("#valider").disabled = false; return toast("Retour ok mais facturation : " + error.message, "err"); }
      }
      // avancement du statut de la prestation
      const nextStatut = sens === "sortie" ? "en_livraison" : "livre"; // retour = livraison+récup d'un client fixe
      await sb.from("prestations").update({ statut: nextStatut }).eq("id", id);
      stopScanner();
      toast(facts.length ? `${label} + ${facts.length} à facturer ✔` : label + " enregistrée ✔", "ok");
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
  //  VUE : Récupération (client ponctuel) — pointage de ce qui revient
  // =========================================================================
  async function viewRecuperation(id) {
    const p = await db.prestation(id);
    const bilan = await db.bilan(id);
    const lignes = bilan.filter((b) => b.q_manquant > 0); // reste à récupérer

    const line = (b) => `
      <div class="card" data-rec="${b.type_id}" data-exp="${b.q_manquant}" data-prix="${b.prix_unitaire}" data-nom="${esc(b.type_nom)}">
        <div class="row between"><b>${esc(b.type_nom)}</b><span class="badge gray">Attendu ${b.q_manquant}</span></div>
        <div class="field-row" style="margin-top:8px">
          <div><label style="margin-top:0">Récupéré</label><input class="rec-in" type="number" inputmode="numeric" value="${b.q_manquant}" min="0" max="${b.q_manquant}" /></div>
          <div><label style="margin-top:0">Non récupéré</label><input class="nonrec-in" type="number" inputmode="numeric" value="0" min="0" max="${b.q_manquant}" /></div>
        </div>
        <div class="sub perte-lbl" style="margin-top:6px"></div>
      </div>`;

    app.innerHTML =
      topbar("Récupération · " + (p.libelle || ""), { back: "prestation/" + id }) +
      `<main>
        ${lignes.length === 0
          ? `<div class="card" style="text-align:center"><div style="font-size:30px">✅</div>Rien à récupérer sur cette prestation.</div>`
          : `<div class="sub" style="margin-bottom:8px">Pointe chaque ligne : par défaut tout est récupéré. Indique le nombre « Non récupéré » le cas échéant — il sera facturé au client.</div>
             <button class="btn sec block" id="tout" style="margin-bottom:10px">✅ Tout récupéré, rien à signaler</button>
             ${lignes.map(line).join("")}`}

        <div class="card" style="position:sticky;bottom:calc(84px + var(--safe-b))">
          <div class="row between" style="margin-bottom:8px"><b id="recap-rec">À facturer : 0,00 €</b></div>
          <button class="btn block" id="valider">Valider la récupération</button>
        </div>
      </main>`;

    const cards = () => $$("[data-rec]");
    const readCard = (el) => {
      const exp = parseInt(el.dataset.exp);
      const nonrec = Math.max(0, Math.min(exp, parseInt(el.querySelector(".nonrec-in").value) || 0));
      const rec = exp - nonrec;
      return { tid: el.dataset.rec, nom: el.dataset.nom, prix: Number(el.dataset.prix), exp, rec, nonrec };
    };
    const refresh = () => {
      let total = 0;
      cards().forEach((el) => {
        const d = readCard(el);
        total += d.nonrec * d.prix;
        const lbl = el.querySelector(".perte-lbl");
        if (d.nonrec === 0) { lbl.innerHTML = "✔ complet"; lbl.style.color = "var(--ok)"; }
        else { lbl.innerHTML = `${d.nonrec} non récupéré(s) → ${eur(d.nonrec * d.prix)}`; lbl.style.color = "var(--danger)"; }
      });
      const r = $("#recap-rec"); if (r) r.textContent = "À facturer : " + eur(total) + " HT";
    };
    // Récupéré et Non récupéré sont complémentaires : éditer l'un ajuste l'autre
    app.querySelector("main").addEventListener("input", (e) => {
      const el = e.target.closest("[data-rec]");
      if (!el) return;
      const exp = parseInt(el.dataset.exp);
      const recIn = el.querySelector(".rec-in"), nonIn = el.querySelector(".nonrec-in");
      if (e.target === recIn) {
        const rec = Math.max(0, Math.min(exp, parseInt(recIn.value) || 0));
        recIn.value = rec; nonIn.value = exp - rec;
      } else if (e.target === nonIn) {
        const non = Math.max(0, Math.min(exp, parseInt(nonIn.value) || 0));
        nonIn.value = non; recIn.value = exp - non;
      }
      refresh();
    });
    const tout = $("#tout");
    if (tout) tout.onclick = () => {
      cards().forEach((el) => { el.querySelector(".rec-in").value = el.dataset.exp; el.querySelector(".nonrec-in").value = 0; });
      refresh();
    };
    refresh();

    $("#valider").onclick = async () => {
      const mvts = [], facts = [], manquantsTxt = [];
      cards().forEach((el) => {
        const d = readCard(el);
        // tout l'attendu est soldé (récupéré ou non récupéré / facturé)
        mvts.push({ prestation_id: id, sens: "retour", type_id: d.tid, unit_id: null, quantite: d.exp, par_user: state.user.id });
        if (d.nonrec > 0) {
          facts.push({ prestation_id: id, client_id: p.client_id || null, type_id: d.tid, motif: "perte", quantite: d.nonrec, prix_unitaire: d.prix, statut: "a_facturer" });
          manquantsTxt.push(`- ${d.nom} : ${d.nonrec} non récupéré(s) (${eur(d.nonrec * d.prix)})`);
        }
      });
      $("#valider").disabled = true;
      if (mvts.length) {
        const { error } = await sb.from("mouvements").insert(mvts);
        if (error) { $("#valider").disabled = false; return toast(error.message, "err"); }
      }
      if (facts.length) {
        const { error } = await sb.from("facturations").insert(facts);
        if (error) { $("#valider").disabled = false; return toast("Récup ok mais facturation : " + error.message, "err"); }
      }
      await sb.from("prestations").update({ statut: "recupere" }).eq("id", id);

      // Email au service compta si des manquants
      if (manquantsTxt.length) {
        const compta = await db.param("email_compta");
        const cli = p.clients ? p.clients.nom : "Client ?";
        const total = facts.reduce((s, f) => s + f.quantite * f.prix_unitaire, 0);
        const body =
`Prestation : ${p.libelle || ""}
Client : ${cli}
Date : ${dfr(p.date_presta)}

Matériel non récupéré à facturer :
${manquantsTxt.join("\n")}

Total : ${eur(total)} HT`;
        if (compta) openMail(compta, `Matériel à facturer — ${cli} (${p.libelle || ""})`, body);
        else toast("Récup enregistrée. Renseigne l'email compta dans Paramètres pour l'envoi auto.", "ok");
      } else {
        toast("Récupération complète ✔", "ok");
      }
      go("prestation/" + id);
    };
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
                <div class="sub" style="margin-top:6px">Remplacement estimé : ${eur(b.q_manquant * b.prix_unitaire)} HT (${eur(b.prix_unitaire)} HT/u)</div>
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

Total : ${eur(total)} HT`;
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
    const [types, soldes, archived] = await Promise.all([db.types(), db.soldeAll(), db.typesArchived()]);
    const dehorsByType = {};
    soldes.forEach((s) => (dehorsByType[s.type_id] = (dehorsByType[s.type_id] || 0) + s.solde));

    const byCat = {};
    types.forEach((t) => ((byCat[t.categorie || "Autres"] ||= []).push(t)));
    const card = (t) => {
      const dehors = dehorsByType[t.id] || 0;
      const labo = (t.stock_total || 0) - dehors;
      return `
        <div class="card tap" onclick="location.hash='#/type/${t.id}'">
          <div class="grow"><h3>${esc(t.nom)}</h3>
            <div class="sub">${t.code_qr ? "🏷️ " + esc(t.code_qr) : "sans QR"} · ${eur(t.prix_unitaire)} HT</div>
            <div class="sub">Parc <b>${t.stock_total || 0}</b> · 🏭 Labo <b>${labo}</b> · 🚚 Dehors <b>${dehors}</b></div>
          </div>
          <div style="font-size:22px;color:#cbd5c9">›</div>
        </div>`;
    };
    const body = Object.keys(byCat).sort().map((cat) =>
      `<div class="section-title">${esc(cat)}</div>${byCat[cat].map(card).join("")}`).join("");

    app.innerHTML =
      topbar("Matériel") +
      `<main>
        <div class="btn-grid" style="margin-bottom:12px">
          <button class="btn sec" onclick="location.hash='#/categories'">🏷️ Catégories</button>
          <button class="btn sec" id="csv">⬇︎ Export CSV</button>
        </div>
        ${types.length ? body : '<div class="empty"><div class="big">📦</div>Aucun matériel.</div>'}
        ${archived.length ? `<button class="btn ghost block" style="margin-top:16px" onclick="location.hash='#/archives'">🗄 Matériel archivé (${archived.length})</button>` : ""}
      </main>
       <button class="fab" onclick="location.hash='#/type/new'">＋</button>`;
    $("#csv").onclick = () => exportTypesCSV(types);
  }

  // =========================================================================
  //  VUE : Matériel archivé (réactivation / suppression définitive)
  // =========================================================================
  async function viewArchives() {
    const archived = await db.typesArchived();
    app.innerHTML =
      topbar("Matériel archivé", { back: "materiel" }) +
      `<main>
        ${archived.length ? `<div class="sub" style="margin-bottom:8px">Ces matériels sont masqués mais leur historique est conservé. Tu peux les réactiver.</div>` +
          archived.map((t) => `
            <div class="card">
              <div class="row between" style="margin-bottom:8px">
                <div class="grow"><b>${esc(t.nom)}</b><div class="sub">${esc(t.categorie || "")}${t.code_qr ? " · " + esc(t.code_qr) : ""}</div></div>
              </div>
              <div class="btn-grid">
                <button class="btn sec" data-reactiver="${t.id}">↩︎ Réactiver</button>
                <button class="btn ghost" data-suppr="${t.id}" style="color:var(--danger)">🗑 Supprimer définitivement</button>
              </div>
            </div>`).join("")
          : `<div class="empty"><div class="big">🗄</div>Aucun matériel archivé.</div>`}
      </main>`;

    $$("[data-reactiver]").forEach((b) => b.onclick = async () => {
      const { error } = await sb.from("materiel_types").update({ actif: true }).eq("id", b.dataset.reactiver);
      toast(error ? error.message : "Matériel réactivé ✔", error ? "err" : "ok");
      if (!error) render();
    });
    $$("[data-suppr]").forEach((b) => {
      let armed = false;
      b.onclick = async () => {
        if (!armed) { armed = true; b.textContent = "Confirmer ?"; setTimeout(() => { armed = false; b.textContent = "🗑 Supprimer définitivement"; }, 3000); return; }
        const { error } = await sb.from("materiel_types").delete().eq("id", b.dataset.suppr);
        if (error) return toast("Impossible : ce matériel a un historique. Il reste archivé.", "err");
        toast("Supprimé définitivement ✔", "ok"); render();
      };
    });
  }

  // =========================================================================
  //  VUE : Gestion des catégories de matériel
  // =========================================================================
  async function viewCategories() {
    const cats = await db.categories();
    app.innerHTML =
      topbar("Catégories", { back: "materiel" }) +
      `<main>
        <div class="card">
          <label>Nouvelle catégorie</label>
          <div class="field-row">
            <input id="c-new" placeholder="Ex : Contenants" />
            <button class="btn sm" id="c-add" style="flex:0 0 auto">Ajouter</button>
          </div>
        </div>
        <div class="section-title">Catégories existantes</div>
        ${cats.length ? cats.map((c) => `
          <div class="card"><div class="row" style="gap:8px">
            <input class="cat-nom" data-id="${c.id}" data-old="${esc(c.nom)}" value="${esc(c.nom)}" style="flex:1" />
            <button class="btn sm sec cat-save" data-id="${c.id}" style="flex:0 0 auto">✓</button>
            <button class="btn sm ghost cat-del" data-id="${c.id}" data-nom="${esc(c.nom)}" style="flex:0 0 auto;color:var(--danger)">🗑</button>
          </div></div>`).join("") : '<div class="sub">Aucune catégorie pour l\'instant.</div>'}
      </main>`;

    $("#c-add").onclick = async () => {
      const nom = $("#c-new").value.trim();
      if (!nom) return;
      const { error } = await sb.from("materiel_categories").insert({ nom });
      if (error) return toast(error.message.includes("duplicate") ? "Cette catégorie existe déjà" : error.message, "err");
      toast("Catégorie ajoutée ✔", "ok"); render();
    };
    $$(".cat-save").forEach((b) => b.onclick = async () => {
      const inp = $(`.cat-nom[data-id="${b.dataset.id}"]`);
      const nouveau = inp.value.trim(), ancien = inp.dataset.old;
      if (!nouveau || nouveau === ancien) return;
      const e1 = (await sb.from("materiel_categories").update({ nom: nouveau }).eq("id", b.dataset.id)).error;
      if (e1) return toast(e1.message, "err");
      await sb.from("materiel_types").update({ categorie: nouveau }).eq("categorie", ancien);
      toast("Catégorie renommée ✔", "ok"); render();
    });
    $$(".cat-del").forEach((b) => {
      let armed = false;
      b.onclick = async () => {
        if (!armed) { armed = true; b.textContent = "Confirmer ?"; setTimeout(() => { armed = false; b.textContent = "🗑"; }, 3000); return; }
        await sb.from("materiel_types").update({ categorie: null }).eq("categorie", b.dataset.nom);
        const { error } = await sb.from("materiel_categories").delete().eq("id", b.dataset.id);
        if (error) return toast(error.message, "err");
        toast("Catégorie supprimée ✔", "ok"); render();
      };
    });
  }

  // =========================================================================
  //  VUE : Journal du parc d'un matériel
  // =========================================================================
  async function viewParcJournal(tid) {
    const t = await db.type(tid);
    const [journal, mvts] = await Promise.all([db.parcJournal(tid), db.movementsByType(tid)]);
    const admin = isAdmin();
    const items = [
      ...journal.map((j) => ({ at: j.created_at, kind: "parc", j })),
      ...mvts.map((m) => ({ at: m.created_at, kind: "mvt", m })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1));

    const parcLine = (j) => {
      const sign = j.delta > 0 ? "+" : "";
      return `<div class="mat-line" data-pj="${j.id}">
        <div class="name" style="flex:1"><b>🧮 ${esc(MOTIF_LABEL[j.motif] || j.motif)} : ${sign}${j.delta}</b>
          <small>${dfrt(j.created_at)}${j.commentaire ? " · " + esc(j.commentaire) : ""}</small></div>
        ${admin ? `<button class="btn sm ghost pj-edit" data-id="${j.id}" style="flex:0 0 auto">✏️</button>` : ""}
      </div>`;
    };
    const mvtLine = (m) => {
      const cli = m.prestations && m.prestations.clients ? m.prestations.clients.nom : "";
      const pres = m.prestations ? m.prestations.libelle : "";
      return `<div class="mat-line"><div class="name" style="flex:1">
        <b>${m.sens === "sortie" ? "📤 Sortie" : "📥 Retour"} ${m.quantite}</b>
        <small>${dfrt(m.created_at)}${cli ? " · " + esc(cli) : ""}${pres ? " · " + esc(pres) : ""}</small></div></div>`;
    };

    app.innerHTML =
      topbar("Journal · " + t.nom, { back: "type/" + tid }) +
      `<main>
        <div class="card"><div class="row between"><b>Parc actuel</b><b style="font-size:20px">${t.stock_total || 0}</b></div></div>
        ${admin ? `
          <div class="card">
            <div class="sub" style="font-weight:700;margin-bottom:6px">Ajuster le parc</div>
            <div class="field-row">
              <div><label style="margin-top:0">Variation</label><input id="adj-delta" type="number" placeholder="+10 / −3" /></div>
              <div><label style="margin-top:0">Motif</label>
                <select id="adj-motif">
                  <option value="rachat">Rachat</option>
                  <option value="perte">Perte (non retrouvé)</option>
                  <option value="casse_salarie">Casse salarié</option>
                  <option value="inventaire">Correction d'inventaire</option>
                  <option value="autre">Autre</option>
                </select></div>
            </div>
            <input id="adj-com" placeholder="Commentaire (optionnel)" style="margin-top:6px" />
            <button class="btn block" id="adj-save" style="margin-top:8px">Enregistrer l'ajustement</button>
          </div>` : `<div class="sub" style="margin:4px">🔒 Seul un administrateur peut ajuster le parc.</div>`}
        <div class="section-title">Historique</div>
        <div class="card" id="tl">${items.length ? items.map((it) => it.kind === "parc" ? parcLine(it.j) : mvtLine(it.m)).join("") : '<div class="sub">Aucun mouvement.</div>'}</div>
      </main>`;

    if (admin) {
      $("#adj-save").onclick = async () => {
        const delta = parseInt($("#adj-delta").value);
        if (!delta) return toast("Indique une variation (ex : 10 ou -3)", "err");
        const { error } = await sb.from("parc_journal").insert({
          type_id: tid, delta, motif: $("#adj-motif").value,
          commentaire: $("#adj-com").value.trim() || null, par_user: state.user.id,
        });
        if (error) return toast(error.message, "err");
        await recomputeStock(tid);
        toast("Parc ajusté ✔", "ok"); render();
      };
      $$(".pj-edit").forEach((b) => b.onclick = () => editParcEntry(b.dataset.id, journal, tid));
    }
  }

  function editParcEntry(id, journal, tid) {
    const j = journal.find((x) => x.id === id);
    const line = $(`[data-pj="${id}"]`);
    if (!j || !line) return;
    line.innerHTML = `<div style="flex:1">
      <div class="field-row">
        <input class="pe-delta" type="number" value="${j.delta}" />
        <select class="pe-motif">${Object.keys(MOTIF_LABEL).map((m) => `<option value="${m}" ${j.motif === m ? "selected" : ""}>${esc(MOTIF_LABEL[m])}</option>`).join("")}</select>
      </div>
      <input class="pe-com" value="${esc(j.commentaire || "")}" placeholder="Commentaire" style="margin-top:6px" />
      <div class="btn-grid" style="margin-top:6px">
        <button class="btn sec pe-save">Enregistrer</button>
        <button class="btn ghost pe-del" style="color:var(--danger)">Supprimer</button>
      </div></div>`;
    line.querySelector(".pe-save").onclick = async () => {
      const delta = parseInt(line.querySelector(".pe-delta").value) || 0;
      const { error } = await sb.from("parc_journal").update({
        delta, motif: line.querySelector(".pe-motif").value,
        commentaire: line.querySelector(".pe-com").value.trim() || null,
      }).eq("id", id);
      if (error) return toast(error.message, "err");
      await recomputeStock(tid); toast("Modifié ✔", "ok"); render();
    };
    line.querySelector(".pe-del").onclick = async () => {
      const { error } = await sb.from("parc_journal").delete().eq("id", id);
      if (error) return toast(error.message, "err");
      await recomputeStock(tid); toast("Entrée supprimée ✔", "ok"); render();
    };
  }

  // =========================================================================
  //  VUE : Espace admin (équipe + réglages)
  // =========================================================================
  async function viewAdmin() {
    if (!isAdmin()) {
      app.innerHTML = topbar("Admin") + `<main><div class="card">🔒 Réservé aux administrateurs.</div></main>`;
      return;
    }
    const [users, compta] = await Promise.all([db.usersList(), db.param("email_compta")]);
    app.innerHTML =
      topbar("Espace admin") +
      `<main>
        <div class="section-title">Équipe</div>
        ${users.map((u) => `
          <div class="card"><div class="row between">
            <div class="grow"><b>${esc(u.nom || "—")}</b><div class="sub">${u.role === "admin" ? "👑 Administrateur" : "Livreur"}</div></div>
            <button class="btn sm ${u.role === "admin" ? "ghost" : "sec"} role-toggle" data-id="${u.id}" data-role="${u.role}" style="flex:0 0 auto">${u.role === "admin" ? "Rétrograder" : "Passer admin"}</button>
          </div></div>`).join("")}
        <div class="section-title">Facturation</div>
        <div class="card">
          <label>Email du service comptabilité</label>
          <input id="a-compta" type="email" value="${esc(compta)}" placeholder="compta@briffe.me" />
          <button class="btn block" id="a-compta-save" style="margin-top:8px">Enregistrer</button>
        </div>
      </main>`;
    $$(".role-toggle").forEach((b) => b.onclick = async () => {
      const newRole = b.dataset.role === "admin" ? "livreur" : "admin";
      if (b.dataset.id === state.user.id && newRole !== "admin")
        return toast("Tu ne peux pas te retirer ton propre rôle admin.", "err");
      const { error } = await sb.from("profiles").update({ role: newRole }).eq("id", b.dataset.id);
      if (error) return toast(error.message, "err");
      toast("Rôle mis à jour ✔", "ok"); render();
    });
    $("#a-compta-save").onclick = async () => {
      const { error } = await db.setParam("email_compta", $("#a-compta").value.trim());
      toast(error ? error.message : "Enregistré ✔", error ? "err" : "ok");
    };
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
    let t = { nom: "", categorie: "", unite: "pièce", prix_unitaire: 0, code_qr: "", stock_total: 0 };
    const cats = await db.categories();
    let soldes = [], clientsMap = {}, journal = [];
    if (!isNew) {
      t = await db.type(tid);
      const [allSoldes, clients, j] = await Promise.all([db.soldeAll(), db.clients(), db.parcJournal(tid)]);
      soldes = allSoldes.filter((s) => s.type_id === tid && s.solde !== 0);
      clients.forEach((c) => (clientsMap[c.id] = c.nom));
      journal = j;
    }
    const dehors = soldes.reduce((a, s) => a + s.solde, 0);
    const labo = (t.stock_total || 0) - dehors;
    // Le parc est "verrouillé" dès qu'il a été initialisé (journal non vide)
    const parkLocked = !isNew && journal.length > 0;

    app.innerHTML =
      topbar(isNew ? "Nouveau matériel" : t.nom, { back: "materiel" }) +
      `<main>
        <div class="card">
          <label>Nom</label><input id="t-nom" value="${esc(t.nom)}" placeholder="Ex : Caisse Araven 20L" />
          <label>Catégorie</label>
          <select id="t-cat">
            <option value="">— Choisir —</option>
            ${cats.map((c) => `<option value="${esc(c.nom)}" ${t.categorie === c.nom ? "selected" : ""}>${esc(c.nom)}</option>`).join("")}
            <option value="__new__">＋ Nouvelle catégorie…</option>
          </select>
          <input id="t-cat-new" placeholder="Nom de la nouvelle catégorie" style="display:none;margin-top:6px" />
          <div class="field-row">
            <div><label>Prix de remplacement HT (€)</label><input id="t-prix" type="number" step="0.01" value="${t.prix_unitaire}" /></div>
            <div><label>Quantité totale (parc)${parkLocked ? " 🔒" : ""}</label>
              <input id="t-stock" type="number" step="1" value="${t.stock_total || 0}" ${parkLocked ? "readonly style=\"background:#f1f3f0\"" : ""} /></div>
          </div>
          ${parkLocked ? `<div class="sub" style="margin-top:-4px">Le parc est verrouillé après la 1ʳᵉ saisie. Toute modification passe par le <b>journal du parc</b> (admin) avec justification.</div>` : `<div class="sub" style="margin-top:-4px">Première saisie du parc : indique la quantité possédée. Ensuite, elle ne sera modifiable que par un admin avec justification.</div>`}
          <label>Code QR (identique sur tous les exemplaires de ce type)</label>
          <div class="field-row">
            <input id="t-code" value="${esc(t.code_qr||"")}" placeholder="GL-…" style="font-family:monospace" />
            <button class="btn sm sec" id="gen-code" style="flex:0 0 auto">Auto</button>
          </div>
          <button class="btn block" id="save">${isNew?"Créer":"Enregistrer"}</button>
        </div>

        ${!isNew ? `
          <div class="section-title">Stock à l'instant T</div>
          <div class="stat">
            <div class="box"><div class="n">${t.stock_total || 0}</div><div class="l">Parc</div></div>
            <div class="box"><div class="n green">${labo}</div><div class="l">🏭 Labo</div></div>
            <div class="box"><div class="n ${dehors ? "amber" : ""}">${dehors}</div><div class="l">🚚 Dehors</div></div>
          </div>
          ${soldes.length ? `<div class="card" style="margin-top:10px">
            <div class="sub" style="font-weight:700;margin-bottom:4px">Détenu par client</div>
            ${soldes.sort((a, b) => b.solde - a.solde).map((s) => `<div class="mat-line" onclick="location.hash='#/client/${s.client_id}'" style="cursor:pointer">
              <div class="name" style="flex:1">${esc(clientsMap[s.client_id] || "Client ?")}</div>
              <span class="badge amber">${s.solde}</span></div>`).join("")}
          </div>` : `<div class="sub" style="margin-top:8px">Aucun exemplaire chez un client actuellement.</div>`}
          ${labo < 0 ? `<div class="sub" style="color:var(--danger);margin-top:8px">⚠️ « Dehors » dépasse le parc — ajuste le parc via le journal.</div>` : ""}
          <button class="btn sec block" style="margin-top:12px" onclick="location.hash='#/journal/${tid}'">📜 Journal du parc</button>
        ` : ""}

        ${!isNew && t.code_qr ? `
          <div class="card" style="text-align:center;margin-top:12px">
            <div id="qr-preview" style="display:flex;justify-content:center;margin:6px 0"></div>
            <div class="code">${esc(t.code_qr)}</div>
            <button class="btn ghost block" onclick="location.hash='#/etiquettes/${tid}'">🖨️ Imprimer les étiquettes (choisir le nombre)</button>
          </div>` : ""}

        ${!isNew ? `<button class="btn ghost block" id="del-type" style="color:var(--danger);margin-top:16px">🗑 Supprimer ce matériel</button>` : ""}
      </main>`;

    // catégorie : afficher le champ "nouvelle" si choisi
    $("#t-cat").onchange = (e) => {
      $("#t-cat-new").style.display = e.target.value === "__new__" ? "block" : "none";
    };

    // aperçu du QR
    const prev = $("#qr-preview");
    if (prev && t.code_qr) new QRCode(prev, { text: t.code_qr, width: 130, height: 130, correctLevel: QRCode.CorrectLevel.M });

    $("#gen-code").onclick = () => { $("#t-code").value = slugCode($("#t-nom").value); };

    $("#save").onclick = async () => {
      const nom = $("#t-nom").value.trim();
      if (!nom) return toast("Ajoute un nom", "err");
      let code = $("#t-code").value.trim();
      if (!code) code = slugCode(nom);            // auto si vide
      // catégorie : valeur choisie, ou nouvelle saisie
      let categorie = $("#t-cat").value;
      if (categorie === "__new__") {
        categorie = $("#t-cat-new").value.trim();
        if (categorie) await sb.from("materiel_categories").insert({ nom: categorie }).then(() => {}, () => {});
      }
      const parcInitial = parkLocked ? (t.stock_total || 0) : (parseInt($("#t-stock").value) || 0);
      const payload = {
        nom,
        categorie: categorie || null,
        prix_unitaire: parseFloat($("#t-prix").value) || 0,
        stock_total: parcInitial,
        code_qr: code || null,
      };
      $("#save").disabled = true;
      let error, newId = tid;
      if (isNew) {
        const res = await sb.from("materiel_types").insert(payload).select().single();
        error = res.error;
        if (!error) newId = res.data.id;
      } else {
        error = (await sb.from("materiel_types").update(payload).eq("id", tid)).error;
      }
      if (error) {
        $("#save").disabled = false;
        return toast(error.message.includes("duplicate") || error.code === "23505"
          ? "Ce code QR est déjà utilisé par un autre type" : error.message, "err");
      }
      // Première saisie du parc -> on l'inscrit au journal (motif "initial")
      if (!parkLocked && parcInitial > 0) {
        await sb.from("parc_journal").insert({
          type_id: newId, delta: parcInitial, motif: "initial",
          commentaire: "Saisie initiale du parc", par_user: state.user.id,
        });
      }
      toast("Enregistré ✔", "ok");
      if (isNew) return go("type/" + newId);
      render();
    };

    // suppression (ou archivage si un historique existe)
    const delBtn = $("#del-type");
    if (delBtn) {
      let armed = false;
      delBtn.onclick = async () => {
        if (!armed) {
          armed = true;
          delBtn.textContent = "Confirmer la suppression ?";
          delBtn.classList.remove("ghost"); delBtn.classList.add("danger");
          setTimeout(() => {
            if (!armed) return;
            armed = false;
            delBtn.textContent = "🗑 Supprimer ce matériel";
            delBtn.classList.add("ghost"); delBtn.classList.remove("danger");
          }, 4000);
          return;
        }
        delBtn.disabled = true;
        const { error } = await sb.from("materiel_types").delete().eq("id", tid);
        if (error) {
          // référencé par des mouvements/facturations -> on archive au lieu de casser l'historique
          const { error: e2 } = await sb.from("materiel_types").update({ actif: false }).eq("id", tid);
          if (e2) { delBtn.disabled = false; return toast(e2.message, "err"); }
          toast("Matériel archivé (un historique existe, données conservées)", "ok");
        } else {
          toast("Matériel supprimé ✔", "ok");
        }
        go("materiel");
      };
    }
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
          <div class="sub" style="margin-top:8px">💡 Étiquette <b>carrée 62 × 62 mm</b>. À l'impression, choisis l'imprimante Brother et le papier <b>« 62mm x 1m »</b> (rouleau continu), échelle <b>100 %</b> / « ajuster à la page » désactivé. Alternative : le CSV (écran Matériel) dans P-touch Editor pour un format sur mesure.</div>
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
        new QRCode(qr, { text: t.code_qr, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.M });
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
    const cats = [...new Set(clients.map((c) => c.categorie).filter(Boolean))].sort();
    const card = (c) => `
      <div class="card tap" onclick="location.hash='#/client/${c.id}'">
        <div class="grow">
          <div class="row between"><h3 class="truncate">${esc(c.nom)}</h3>${clientBadge(c.type_client)}</div>
          <div class="sub">${esc(c.adresse_livraison || c.adresse || "")}${c.contact ? " · " + esc(c.contact) : ""}</div>
          ${c.categorie ? `<div class="sub">🏷️ ${esc(c.categorie)}${c.groupe ? " · " + esc(c.groupe) : ""}</div>` : ""}
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
        ${cats.length ? `<select id="catfilter" style="margin-bottom:10px">
          <option value="">Toutes les catégories</option>
          ${cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
        </select>` : ""}
        <input id="search" placeholder="🔍 Rechercher (nom, catégorie, groupe…)" style="margin-bottom:10px" />
        <div id="clist"></div>
      </main>
      <button class="fab" onclick="location.hash='#/client/new'">＋</button>`;

    let f = "tous", q = "", cat = "";
    const draw = () => {
      let list = clients;
      if (f !== "tous") list = list.filter((c) => c.type_client === f);
      if (cat) list = list.filter((c) => c.categorie === cat);
      if (q) list = list.filter((c) =>
        [c.nom, c.categorie, c.groupe, c.contact].some((v) => (v || "").toLowerCase().includes(q)));
      // regroupe par "groupe" quand une catégorie est sélectionnée
      let html;
      if (cat) {
        const byG = {};
        list.forEach((c) => ((byG[c.groupe || "—"] ||= []).push(c)));
        html = Object.keys(byG).sort().map((g) =>
          `<div class="section-title">${esc(g)}</div>${byG[g].map(card).join("")}`).join("");
      } else {
        html = list.map(card).join("");
      }
      $("#clist").innerHTML = list.length ? html
        : '<div class="empty"><div class="big">🏢</div>Aucun client.</div>';
    };
    $("#filter").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      f = b.dataset.f;
      $$("#filter button").forEach((x) => x.classList.toggle("active", x === b));
      draw();
    });
    const cf = $("#catfilter");
    if (cf) cf.addEventListener("change", (e) => { cat = e.target.value; draw(); });
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
              ${c.categorie ? `<div class="sub">🏷️ ${esc(c.categorie)}${c.groupe ? " · " + esc(c.groupe) : ""}</div>` : ""}
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
                  <div class="name"><b>${esc(x.type_nom)}</b><small>${esc(x.categorie || "")} · ${eur(x.prix_unitaire)} HT/u</small></div>
                  <span class="badge ${x.solde > 0 ? "amber" : "green"}">${x.solde}</span>
                </div>`).join("")}
              <div class="divider"></div>
              <div class="row between"><b>${totalPieces} pièce(s)</b><b>${eur(totalValeur)} HT</b></div>
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
      ? prestas.map((p) => `<div class="mat-line">
          <div class="name" onclick="location.hash='#/prestation/${p.id}'" style="cursor:pointer;flex:1"><b>${esc(p.libelle || "Prestation")}</b><small>${dfr(p.date_presta)} · ${esc(STATUT_LABEL[p.statut] || "")}</small></div>
          <button class="btn sm ghost" onclick="location.hash='#/prestation/${p.id}/manquants'" style="padding:6px 10px;flex:0 0 auto">📊 Manquants</button>
        </div>`).join("")
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

Total : ${totalPieces} pièce(s), valeur de remplacement ${eur(totalValeur)} HT.

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

Total : ${totalPieces} pièce(s), soit ${eur(totalValeur)} HT à facturer.`;
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
          <div class="field-row">
            <div><label>Catégorie</label><input id="c-cat" list="cat-list" value="${esc(c.categorie || "")}" placeholder="ex. Appels d'offre" /></div>
            <div><label>Groupe</label><input id="c-groupe" value="${esc(c.groupe || "")}" placeholder="ex. UnivLille" /></div>
          </div>
          <datalist id="cat-list"></datalist>
          <label>ID Sextan (optionnel)</label><input id="c-sextan" value="${esc(c.sextan_id || "")}" />
          <button class="btn block" id="save">${isNew ? "Créer" : "Enregistrer"}</button>
        </div>
      </main>`;

    // suggestions de catégories déjà utilisées
    db.clients().then((all) => {
      const cats = [...new Set(all.map((x) => x.categorie).filter(Boolean))].sort();
      const dl = $("#cat-list");
      if (dl) dl.innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join("");
    }).catch(() => {});

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
        categorie: $("#c-cat").value.trim() || null,
        groupe: $("#c-groupe").value.trim() || null,
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
    // Onglet Admin (uniquement pour les admins)
    if (isAdmin() && !$("#nav-admin")) {
      const b = document.createElement("button");
      b.id = "nav-admin";
      b.dataset.route = "admin";
      b.innerHTML = '<span class="ico">🔐</span>Admin';
      nav.appendChild(b);
    }
    if (!location.hash) location.hash = "#/prestations";
    render();
  }

  // Service worker (PWA installable / hors-ligne léger)
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  boot();
})();
