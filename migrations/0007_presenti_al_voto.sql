-- Migration number: 0007
-- Congela il numero dei presenti nel momento in cui si apre la votazione:
-- il quorum di ogni punto resta quello valido all'apertura dell'urna,
-- anche se le presenze vengono aggiornate dopo (es. ritardatari).
ALTER TABLE ordine_del_giorno ADD COLUMN presenti_al_voto INTEGER;
