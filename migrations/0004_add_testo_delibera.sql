-- Migration number: 0004
-- Testo integrale della delibera per ogni punto all'ordine del giorno
ALTER TABLE ordine_del_giorno ADD COLUMN testo TEXT;
