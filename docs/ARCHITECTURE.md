# Architettura (una pagina)

**Loop:** EVENTO → CONTESTO → RAGIONAMENTO → AZIONE

1. **Evento** – lo studente scrive a FARMi (o tocca un suggerimento).
2. **Contesto** – il browser allega lo stato live dell'app (colonnine e posti rosa liberi, auto parcheggiata, ristoranti aperti, eventi della settimana, checklist). Il server rilegge `knowledge/*.md` a ogni domanda e numera le sezioni `S1…Sn`.
3. **Ragionamento** – Gemma 4 riceve regole + fonti + contesto live e risponde in JSON: `answer`, `sources`, `actions`, `handoff`.
4. **Azione** – il server tiene solo le fonti esistenti e le azioni di una lista chiusa. L'app mostra la risposta, le fonti e i pulsanti; l'azione parte solo se l'utente la tocca. Su temi sensibili scatta il passaggio a una persona.

## Cosa è reale e cosa è simulato

| Componente | Stato |
|---|---|
| Chat con Gemma 4 (Google AI Studio o Ollama) | **Reale** |
| Knowledge base Markdown con citazioni verificate | **Reale** (contenuti sintetici) |
| Ricarica a caldo della knowledge base | **Reale** |
| Contesto live dall'app | **Reale** nel browser, ma i dati di occupazione sono generati |
| Webapp installabile sul telefono (PWA: icona, schermo intero, apertura offline) | **Reale** |
| Server demo pubblico con chiave nascosta e limiti anti-abuso | **Reale** (Render, piano gratuito) |
| Riconoscimento delle richieste vietate dal regolamento, con articolo e comma | **Reale** (regolamento di esempio) |
| Ticket allo Student Office, posto auto salvato | **Simulati** (salvati nel browser) |
| Palestra e Ristoranti | **Sezioni dell'app esistente**, non fanno parte di FARMi |
| Ruoli e permessi (chi vede cosa) | **Non ancora**: un solo ruolo, la matricola |
| Librarian (ingest, dedup, dati scaduti) e agenti proattivi | **Non ancora**: prossimi passi |

## Scelte

- **Zero dipendenze** – un PC nuovo parte con Node e basta; niente build.
- **Un server demo per tutti** – il team mette la chiave una volta su Render; chi clona il repo senza chiave passa da lì, quindi la chiave non è mai pubblica.
- **Chiave solo sul server** – la chiave non è mai nell'HTML né nel repo (`.env` è ignorato da git).
- **Modello sostituibile** – `LLM_PROVIDER=google|ollama`: lo stesso Gemma 4 può girare su hardware proprio, come suggerisce il brief.
- **Knowledge base intera nel prompt** – con poche decine di sezioni è più semplice e affidabile di un database vettoriale; quando cresce si aggiunge un passo di retrieval in `loadKnowledge()`.
