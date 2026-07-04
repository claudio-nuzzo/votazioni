-- Migration number: 0005
-- Gestione sedute: organo collegiale, data programmata e stato della seduta
ALTER TABLE sessioni_collegio ADD COLUMN organo TEXT DEFAULT 'COLLEGIO_DOCENTI';
ALTER TABLE sessioni_collegio ADD COLUMN data_programmata TEXT;
ALTER TABLE sessioni_collegio ADD COLUMN stato TEXT DEFAULT 'PREPARAZIONE';
