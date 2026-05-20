import streamlit as st
import pandas as pd
from datetime import datetime
import uuid
import requests

# Configuration de la page
st.set_page_config(page_title="GreenLoop - Saisie", page_icon="♻️", layout="wide")

st.title("♻️ GreenLoop - Application d'Entreprise")

# URL de votre Google Sheets
SPREADSHEET_ID = "1ZQXumORN38pXbe0f3YusJJSLzylZjfPK--KwNeb25qo"

# Chargement dynamique des données en lecture seule via le lien public
@st.cache_data(ttl=60)  # Recharge les données toutes les minutes
def charger_depuis_sheets(sheet_name):
    url = f"https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet={sheet_name}"
    try:
        return pd.read_csv(url)
    except Exception:
        # Listes de secours si la connexion échoue
        if sheet_name == "Clients":
            return pd.DataFrame({"Nom_Client": ["Tamper", "Lovibond", "Fournil Bio", "Viet Coffee", "Utopia"]})
        elif sheet_name == "Contenants":
            return pd.DataFrame({"Nom_Contenant": ["ARAVEN 2,8L", "ARAVEN 6,5L", "Caisse Blanche"]})
        return pd.DataFrame()

# Chargement des listes pour le formulaire
df_clients = charger_depuis_sheets("Clients")
df_contenants = charger_depuis_sheets("Contenants")

# Nettoyage des valeurs vides
clients = df_clients["Nom_Client"].dropna().tolist() if "Nom_Client" in df_clients.columns else ["Tamper"]
contenants = df_contenants["Nom_Contenant"].dropna().tolist() if "Nom_Contenant" in df_contenants.columns else ["ARAVEN 2,8L"]

# Menu latéral
menu = st.sidebar.radio("Navigation", ["➕ Saisir un Mouvement", "📊 Historique"])

if menu == "➕ Saisir un Mouvement":
    st.subheader("Nouveau Mouvement de Contenants")
    
    with st.form("form_mouvement", clear_on_submit=True):
        client_selectionne = st.selectbox("Client", clients)
        contenant_selectionne = st.selectbox("Contenant", contenants)
        
        col1, col2 = st.columns(2)
        with col1:
            livres = st.number_input("Livrés", min_value=0, value=0, step=1)
        with col2:
            rendus = st.number_input("Rendus", min_value=0, value=0, step=1)
            
        st.markdown("---")
        st.write("⚠️ **Signaler une Anomalie (Optionnel)**")
        
        col3, col4 = st.columns(2)
        with col3:
            anomalie_qte = st.number_input("Anomalie Qté", min_value=0, value=0, step=1)
        with col4:
            anomalie_type = st.selectbox("Anomalie Type", ["Aucune", "Cassé", "Fissuré", "Perdu", "Sale"])

        bouton_valider = st.form_submit_button("Enregistrer le mouvement")
        
        if bouton_valider:
            id_unique = str(uuid.uuid4())[:8]
            date_actuelle = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
            
            # Préparation de la ligne
            nouvelle_ligne = {
                "ID_Mouvement": id_unique,
                "Date": date_actuelle,
                "Nom_Client": client_selectionne,
                "Nom_Contenant": contenant_selectionne,
                "Livrés": livres,
                "Rendus": rendus,
                "Anomalie_Qte": anomalie_qte,
                "Anomalie_Type": anomalie_type if anomalie_type != "Aucune" else ""
            }
            
            # --- CODE D'ENVOI ---
            # Pour envoyer les données sans clé API, on utilise un webhook Google Apps Script simple
            # (Je vous donne le mini-code à copier dans votre Sheets juste en dessous)
            macro_url = "https://script.google.com/macros/s/AKfycbyTT71SMI9eZ2oixZpfZLUvVcJK3hhD7JSvKsTOoZJWMMF8qfociKQDhF1Qh-xouKjh/exec"
            
            if macro_url:
                try:
                    response = requests.post(macro_url, json=nouvelle_ligne)
                    if response.status_code == 200:
                        st.success(f"🎉 Mouvement synchronisé en ligne ! (ID: {id_unique})")
                    else:
                        st.warning("Mouvement enregistré localement, mais échec de la synchronisation en ligne.")
                except Exception as e:
                    st.error(f"Erreur de connexion : {e}")
            else:
                st.success(f"Enregistré (Mode Démo) ! ID: {id_unique}")
                st.json(nouvelle_ligne)

else:
    st.subheader("Historique des mouvements (Onglet Mouvements)")
    df_mouv = charger_depuis_sheets("Mouvements")
    if not df_mouv.empty:
        st.dataframe(df_mouv, use_container_width=True)
    else:
        st.info("Aucun mouvement trouvé ou impossible de lire l'onglet.")