-- Migration number: 0002
-- Tabelle del sistema Votazioni Scuola (idempotente: non tocca tabelle già esistenti)

CREATE TABLE IF NOT EXISTS sessioni_collegio (
    id TEXT PRIMARY KEY,
    scuola_dominio TEXT NOT NULL,
    titolo TEXT NOT NULL,
    data_ora TEXT DEFAULT CURRENT_TIMESTAMP,
    meet_link TEXT,
    totale_presenti_rilevati INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ordine_del_giorno (
    id TEXT PRIMARY KEY,
    sessione_id TEXT REFERENCES sessioni_collegio(id),
    numero_punto INTEGER NOT NULL,
    titolo TEXT NOT NULL,
    tipo_voto TEXT CHECK(tipo_voto IN ('PALESE', 'SEGRETO')),
    stato TEXT CHECK(stato IN ('IN_ATTESA', 'ATTIVO', 'CHIUSO')) DEFAULT 'IN_ATTESA'
);

CREATE TABLE IF NOT EXISTS registro_votanti (
    punto_id TEXT REFERENCES ordine_del_giorno(id),
    user_email TEXT NOT NULL,
    PRIMARY KEY (punto_id, user_email)
);

CREATE TABLE IF NOT EXISTS urna_voti (
    id TEXT PRIMARY KEY,
    punto_id TEXT REFERENCES ordine_del_giorno(id),
    user_email TEXT,
    scelta TEXT CHECK(scelta IN ('FAVOREVOLE', 'CONTRARIO', 'ASTENUTO')) NOT NULL
);
