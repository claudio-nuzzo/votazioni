-- Migration number: 0003
-- Elenco dei presenti per sessione (partecipanti rilevati dal Meet).
-- Con il login Google attivo, solo chi è in questo elenco può votare.

CREATE TABLE IF NOT EXISTS presenti_sessione (
    sessione_id TEXT REFERENCES sessioni_collegio(id),
    email TEXT NOT NULL,
    PRIMARY KEY (sessione_id, email)
);
