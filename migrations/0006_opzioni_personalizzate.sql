-- Migration number: 0006
-- Opzioni di voto personalizzate (es. elezione tra più candidati).
-- La colonna "opzioni" contiene un elenco JSON di scelte; se vuota si usano
-- le tre opzioni standard. L'urna viene ricreata senza il vincolo fisso.

ALTER TABLE ordine_del_giorno ADD COLUMN opzioni TEXT;

CREATE TABLE urna_voti_nuova (
    id TEXT PRIMARY KEY,
    punto_id TEXT REFERENCES ordine_del_giorno(id),
    user_email TEXT,
    scelta TEXT NOT NULL
);
INSERT INTO urna_voti_nuova SELECT id, punto_id, user_email, scelta FROM urna_voti;
DROP TABLE urna_voti;
ALTER TABLE urna_voti_nuova RENAME TO urna_voti;
