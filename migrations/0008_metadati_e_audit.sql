-- Migration number: 0008
-- Conformità Allegato tecnico ministeriale:
-- 1) Gestione dei metadati (cap. 4.3): le tabelle del voto vengono ricreate
--    "WITHOUT ROWID", così l'ordine fisico di archiviazione non riflette
--    l'ordine di inserimento e non consente alcuna correlazione, neanche
--    indiretta, tra sequenza dei votanti e sequenza dei voti segreti.
-- 2) Tracciabilità delle operazioni (cap. 3.3 e 5): registro delle
--    operazioni degli amministratori (mai dei voti).

CREATE TABLE urna_voti_v2 (
    id TEXT PRIMARY KEY,
    punto_id TEXT REFERENCES ordine_del_giorno(id),
    user_email TEXT,
    scelta TEXT NOT NULL
) WITHOUT ROWID;
INSERT INTO urna_voti_v2 SELECT id, punto_id, user_email, scelta FROM urna_voti;
DROP TABLE urna_voti;
ALTER TABLE urna_voti_v2 RENAME TO urna_voti;

CREATE TABLE registro_votanti_v2 (
    punto_id TEXT REFERENCES ordine_del_giorno(id),
    user_email TEXT NOT NULL,
    PRIMARY KEY (punto_id, user_email)
) WITHOUT ROWID;
INSERT INTO registro_votanti_v2 SELECT punto_id, user_email FROM registro_votanti;
DROP TABLE registro_votanti;
ALTER TABLE registro_votanti_v2 RENAME TO registro_votanti;

CREATE TABLE IF NOT EXISTS registro_operazioni (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eseguita_il TEXT DEFAULT CURRENT_TIMESTAMP,
    utente TEXT NOT NULL,
    azione TEXT NOT NULL,
    dettaglio TEXT
);
