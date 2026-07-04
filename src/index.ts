/**
 * VOTAZIONI SCUOLA — Backend API (Cloudflare Worker + D1)
 *
 * Correzioni rispetto alla versione del manuale:
 *  1. Il tipo di voto (PALESE/SEGRETO) viene letto dal DATABASE, mai dal client
 *     → impossibile violare l'anonimato del voto segreto.
 *  2. Si può votare solo se il punto è in stato ATTIVO.
 *  3. Quorum = metà dei presenti + 1 (non il 51%, che sbaglia con i numeri pari).
 *  4. CORS ristretto al dominio del frontend.
 *  5. Doppio voto: messaggio di errore chiaro invece di errore generico.
 *
 * PREDISPOSIZIONE LOGIN GOOGLE:
 *  Quando in Cloudflare imposterai le variabili GOOGLE_CLIENT_ID (e opzionalmente
 *  DOMINIO_SCUOLA e ADMIN_EMAILS), il Worker richiederà un token Google valido
 *  su ogni chiamata e ricaverà l'email del votante dal token, non dal browser.
 *  Finché GOOGLE_CLIENT_ID non è impostata, il sistema funziona in "modalità test"
 *  (si fida dell'email inviata dal frontend, come ora).
 */

interface Env {
	DB: D1Database;
	GOOGLE_CLIENT_ID?: string; // attiva la verifica del login Google
	DOMINIO_SCUOLA?: string; // es. "scuola.edu.it" — accetta solo account di questo dominio
	ADMIN_EMAILS?: string; // es. "preside@scuola.edu.it,segretario@scuola.edu.it"
}

// Dominii autorizzati a chiamare le API (CORS)
const ORIGINI_AMMESSE = [
	"https://votazioni-scuola.stradilab.org",
	"http://localhost:8788", // per prove in locale
	"http://127.0.0.1:8788",
];

function headersCors(request: Request): Record<string, string> {
	const origine = request.headers.get("Origin") || "";
	return {
		"Access-Control-Allow-Origin": ORIGINI_AMMESSE.includes(origine)
			? origine
			: ORIGINI_AMMESSE[0],
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization",
		"Content-Type": "application/json",
	};
}

function rispostaJson(dati: unknown, stato: number, cors: Record<string, string>) {
	return new Response(JSON.stringify(dati), { status: stato, headers: cors });
}

/**
 * Identifica l'utente.
 * - Con GOOGLE_CLIENT_ID impostata: verifica il token Google (header Authorization)
 *   e ricava l'email certificata da Google.
 * - Senza: modalità test, usa l'email dichiarata dal frontend.
 */
async function identificaUtente(
	request: Request,
	env: Env,
	emailDichiarata?: string
): Promise<{ email: string } | { errore: string }> {
	if (!env.GOOGLE_CLIENT_ID) {
		// MODALITÀ TEST (nessun login configurato)
		if (!emailDichiarata) return { errore: "Email mancante" };
		return { email: emailDichiarata.toLowerCase().trim() };
	}

	const auth = request.headers.get("Authorization") || "";
	const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
	if (!token) return { errore: "Accesso non eseguito: token Google mancante" };

	// Verifica del token presso Google
	const risposta = await fetch(
		"https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token)
	);
	if (!risposta.ok) return { errore: "Token Google non valido o scaduto" };

	const info = (await risposta.json()) as {
		aud?: string;
		email?: string;
		email_verified?: string;
		hd?: string;
		exp?: string;
	};

	if (info.aud !== env.GOOGLE_CLIENT_ID)
		return { errore: "Token emesso per un'altra applicazione" };
	if (info.email_verified !== "true" || !info.email)
		return { errore: "Email non verificata da Google" };
	if (env.DOMINIO_SCUOLA && info.hd !== env.DOMINIO_SCUOLA)
		return { errore: "Devi accedere con l'account istituzionale della scuola" };

	return { email: info.email.toLowerCase() };
}

/**
 * Restituisce le scelte ammesse per un punto: quelle personalizzate
 * (es. nomi di candidati) più ASTENUTO, oppure le tre standard.
 */
function sceltePermesse(opzioniJson: string | null | undefined): string[] {
	if (opzioniJson) {
		try {
			const opzioni = JSON.parse(opzioniJson);
			if (Array.isArray(opzioni) && opzioni.length > 0) {
				return [...opzioni.map((o) => String(o)), "ASTENUTO"];
			}
		} catch {
			// JSON non valido: si torna alle opzioni standard
		}
	}
	return ["FAVOREVOLE", "CONTRARIO", "ASTENUTO"];
}

/** Verifica se l'utente è un amministratore (presidente/segretario). */
function isAdmin(email: string, env: Env): boolean {
	if (!env.ADMIN_EMAILS) return true; // in modalità test tutti possono amministrare
	return env.ADMIN_EMAILS.toLowerCase()
		.split(",")
		.map((e) => e.trim())
		.includes(email.toLowerCase());
}

/**
 * Registra un'operazione AMMINISTRATIVA nel registro operazioni
 * (tracciabilità richiesta dall'Allegato tecnico, cap. 3.3 e 5).
 * ATTENZIONE: non viene mai tracciata l'espressione dei voti,
 * a tutela dell'anonimato del voto segreto.
 */
async function tracciaOperazione(env: Env, utente: string, azione: string, dettaglio: string) {
	try {
		await env.DB.prepare(
			"INSERT INTO registro_operazioni (utente, azione, dettaglio) VALUES (?, ?, ?)"
		)
			.bind(utente, azione, dettaglio)
			.run();
	} catch {
		// la tracciatura non deve mai bloccare l'operazione principale
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const cors = headersCors(request);
		if (request.method === "OPTIONS") return new Response(null, { headers: cors });

		const url = new URL(request.url);
		const path = url.pathname;

		try {
			// Pagina di controllo (per verificare che il deploy sia andato a buon fine)
			if (path === "/" && request.method === "GET") {
				return rispostaJson(
					{
						servizio: "API Votazioni Scuola",
						stato: "attivo",
						loginGoogle: env.GOOGLE_CLIENT_ID ? "attivo" : "non configurato (modalità test)",
					},
					200,
					cors
				);
			}

			// ── 1. CREA SEDUTA (solo admin) ─────────────────────────────────────
			// Le sedute si preparano in anticipo: titolo, organo collegiale,
			// data programmata e link Meet. Nascono in stato PREPARAZIONE.
			if (path === "/api/sessione/crea" && request.method === "POST") {
				const corpo = (await request.json()) as any;
				const utente = await identificaUtente(request, env, corpo.userEmail);
				if ("errore" in utente) return rispostaJson({ error: utente.errore }, 401, cors);
				if (!isAdmin(utente.email, env))
					return rispostaJson({ error: "Operazione riservata agli amministratori" }, 403, cors);

				if (!corpo.titolo) return rispostaJson({ error: "Titolo mancante" }, 400, cors);
				const organo = ["COLLEGIO_DOCENTI", "CONSIGLIO_ISTITUTO", "ALTRO"].includes(corpo.organo)
					? corpo.organo
					: "COLLEGIO_DOCENTI";

				const sessionId = crypto.randomUUID();
				await env.DB.prepare(
					"INSERT INTO sessioni_collegio (id, scuola_dominio, titolo, meet_link, organo, data_programmata, stato) VALUES (?, ?, ?, ?, ?, ?, 'PREPARAZIONE')"
				)
					.bind(
						sessionId,
						corpo.scuolaDominio ?? "istitutostradivari.it",
						corpo.titolo,
						corpo.meetLink ?? null,
						organo,
						corpo.dataProgrammata ?? null
					)
					.run();
				await tracciaOperazione(env, utente.email, "CREAZIONE_SEDUTA", `"${corpo.titolo}" (${organo}) id=${sessionId}`);
				return rispostaJson({ success: true, sessionId }, 200, cors);
			}

			// ── 1b. ELENCO SEDUTE (solo admin) ──────────────────────────────────
			if (path === "/api/sessioni/lista" && request.method === "GET") {
				const utente = await identificaUtente(
					request,
					env,
					url.searchParams.get("email") ?? undefined
				);
				if ("errore" in utente) return rispostaJson({ error: utente.errore }, 401, cors);
				if (!isAdmin(utente.email, env))
					return rispostaJson({ error: "Operazione riservata agli amministratori" }, 403, cors);

				const { results } = await env.DB.prepare(
					"SELECT s.id, s.titolo, s.organo, s.data_programmata, s.stato, s.meet_link, s.totale_presenti_rilevati, (SELECT COUNT(*) FROM ordine_del_giorno o WHERE o.sessione_id = s.id) AS num_punti FROM sessioni_collegio s ORDER BY COALESCE(s.data_programmata, s.data_ora) DESC"
				).all();
				return rispostaJson(results, 200, cors);
			}

			// ── 1c. AVVIA / CHIUDI SEDUTA (solo admin) ──────────────────────────
			// Una sola seduta può essere IN_CORSO: è quella che vedono i docenti.
			if (path === "/api/sessione/stato" && request.method === "POST") {
				const corpo = (await request.json()) as any;
				const utente = await identificaUtente(request, env, corpo.userEmail);
				if ("errore" in utente) return rispostaJson({ error: utente.errore }, 401, cors);
				if (!isAdmin(utente.email, env))
					return rispostaJson({ error: "Operazione riservata agli amministratori" }, 403, cors);

				if (!["PREPARAZIONE", "IN_CORSO", "CHIUSA"].includes(corpo.nuovoStato))
					return rispostaJson({ error: "Stato seduta non valido" }, 400, cors);

				if (corpo.nuovoStato === "IN_CORSO") {
					await env.DB.batch([
						env.DB.prepare("UPDATE sessioni_collegio SET stato = 'CHIUSA' WHERE stato = 'IN_CORSO'"),
						env.DB.prepare("UPDATE sessioni_collegio SET stato = 'IN_CORSO' WHERE id = ?").bind(
							corpo.sessionId
						),
					]);
				} else {
					await env.DB.prepare("UPDATE sessioni_collegio SET stato = ? WHERE id = ?")
						.bind(corpo.nuovoStato, corpo.sessionId)
						.run();
				}
				await tracciaOperazione(env, utente.email, "STATO_SEDUTA", `seduta ${corpo.sessionId} -> ${corpo.nuovoStato}`);
				return rispostaJson({ success: true }, 200, cors);
			}

			// ── 1e. ELIMINA SEDUTA (solo admin) ─────────────────────────────────
			// Cancella la seduta con tutti i suoi punti, voti e presenze.
			if (path === "/api/sessione/elimina" && request.method === "POST") {
				const corpo = (await request.json()) as any;
				const utente = await identificaUtente(request, env, corpo.userEmail);
				if ("errore" in utente) return rispostaJson({ error: utente.errore }, 401, cors);
				if (!isAdmin(utente.email, env))
					return rispostaJson({ error: "Operazione riservata agli amministratori" }, 403, cors);

				const esiste = await env.DB.prepare("SELECT 1 FROM sessioni_collegio WHERE id = ?")
					.bind(corpo.sessionId)
					.first();
				if (!esiste) return rispostaJson({ error: "Seduta non trovata" }, 404, cors);

				await env.DB.batch([
					env.DB.prepare(
						"DELETE FROM urna_voti WHERE punto_id IN (SELECT id FROM ordine_del_giorno WHERE sessione_id = ?)"
					).bind(corpo.sessionId),
					env.DB.prepare(
						"DELETE FROM registro_votanti WHERE punto_id IN (SELECT id FROM ordine_del_giorno WHERE sessione_id = ?)"
					).bind(corpo.sessionId),
					env.DB.prepare("DELETE FROM ordine_del_giorno WHERE sessione_id = ?").bind(corpo.sessionId),
					env.DB.prepare("DELETE FROM presenti_sessione WHERE sessione_id = ?").bind(corpo.sessionId),
					env.DB.prepare("DELETE FROM sessioni_collegio WHERE id = ?").bind(corpo.sessionId),
				]);
				await tracciaOperazione(env, utente.email, "ELIMINAZIONE_SEDUTA", `seduta ${corpo.sessionId}`);
				return rispostaJson({ success: true }, 200, cors);
			}

			// ── 1d. SEDUTA CORRENTE (pubblico) ──────────────────────────────────
			// I docenti vedono automaticamente la seduta IN_CORSO.
			if (path === "/api/sessione/corrente" && request.method === "GET") {
				const s = await env.DB.prepare(
					"SELECT id, titolo, organo, data_programmata, meet_link FROM sessioni_collegio WHERE stato = 'IN_CORSO' ORDER BY data_ora DESC LIMIT 1"
				).first();
				return rispostaJson(s ?? null, 200, cors);
			}

			// ── 2. CARICA I PUNTI DELL'ORDINE DEL GIORNO (solo admin) ───────────
			if (path === "/api/odg/carica" && request.method === "POST") {
				const corpo = (await request.json()) as any;
				const utente = await identificaUtente(request, env, corpo.userEmail);
				if ("errore" in utente) return rispostaJson({ error: utente.errore }, 401, cors);
				if (!isAdmin(utente.email, env))
					return rispostaJson({ error: "Operazione riservata agli amministratori" }, 403, cors);

				const punti = corpo.punti as { numero: number; titolo: string; tipo: string }[];
				if (!Array.isArray(punti) || punti.length === 0)
					return rispostaJson({ error: "Nessun punto da caricare" }, 400, cors);

				const statements = punti.map((p: any) => {
					// Opzioni personalizzate: elenco di scelte alternative
					// (es. candidati). Se assente si vota Favorevole/Contrario/Astenuto.
					let opzioni: string | null = null;
					if (Array.isArray(p.opzioni)) {
						const pulite = [
							...new Set(p.opzioni.map((o: any) => String(o).trim()).filter((o: string) => o)),
						].slice(0, 30);
						if (pulite.length >= 2) opzioni = JSON.stringify(pulite);
					}
					return env.DB.prepare(
						"INSERT INTO ordine_del_giorno (id, sessione_id, numero_punto, titolo, tipo_voto, testo, opzioni) VALUES (?, ?, ?, ?, ?, ?, ?)"
					).bind(crypto.randomUUID(), corpo.sessionId, Number(p.numero), p.titolo, p.tipo, p.testo ?? null, opzioni);
				});
				await env.DB.batch(statements);
				await tracciaOperazione(env, utente.email, "CARICAMENTO_PUNTI", `${punti.length} punti in seduta ${corpo.sessionId}`);
				return rispostaJson({ success: true }, 200, cors);
			}

			// ── 3. ELENCO PUNTI DI UNA SESSIONE ─────────────────────────────────
			if (path.startsWith("/api/odg/lista/") && request.method === "GET") {
				const sessionId = path.split("/").pop();
				const { results } = await env.DB.prepare(
					"SELECT * FROM ordine_del_giorno WHERE sessione_id = ? ORDER BY numero_punto ASC"
				)
					.bind(sessionId)
					.all();
				return rispostaJson(results, 200, cors);
			}

			// ── 4. APRI / CHIUDI UNA VOTAZIONE (solo admin) ─────────────────────
			if (path === "/api/odg/stato" && request.method === "POST") {
				const corpo = (await request.json()) as any;
				const utente = await identificaUtente(request, env, corpo.userEmail);
				if ("errore" in utente) return rispostaJson({ error: utente.errore }, 401, cors);
				if (!isAdmin(utente.email, env))
					return rispostaJson({ error: "Operazione riservata agli amministratori" }, 403, cors);

				if (!["IN_ATTESA", "ATTIVO", "CHIUSO"].includes(corpo.nuovoStato))
					return rispostaJson({ error: "Stato non valido" }, 400, cors);

				if (corpo.nuovoStato === "ATTIVO") {
					// All'apertura dell'urna si CONGELA il numero dei presenti:
					// il quorum di questo punto resta quello di questo momento,
					// anche se le presenze vengono aggiornate in seguito.
					await env.DB.prepare(
						"UPDATE ordine_del_giorno SET stato = ?, presenti_al_voto = (SELECT totale_presenti_rilevati FROM sessioni_collegio WHERE id = ordine_del_giorno.sessione_id) WHERE id = ?"
					)
						.bind(corpo.nuovoStato, corpo.puntoId)
						.run();
				} else {
					await env.DB.prepare("UPDATE ordine_del_giorno SET stato = ? WHERE id = ?")
						.bind(corpo.nuovoStato, corpo.puntoId)
						.run();
				}
				await tracciaOperazione(env, utente.email, "STATO_PUNTO", `punto ${corpo.puntoId} -> ${corpo.nuovoStato}`);
				return rispostaJson({ success: true }, 200, cors);
			}

			// ── 5. REGISTRA I PRESENTI DELLA SEDUTA (solo admin) ────────────────
			// Oltre al numero, salva l'ELENCO delle email rilevate dal Meet:
			// con il login Google attivo, solo chi è in elenco potrà votare.
			if (path === "/api/sessione/presenti" && request.method === "POST") {
				const corpo = (await request.json()) as any;
				const utente = await identificaUtente(request, env, corpo.userEmail);
				if ("errore" in utente) return rispostaJson({ error: utente.errore }, 401, cors);
				if (!isAdmin(utente.email, env))
					return rispostaJson({ error: "Operazione riservata agli amministratori" }, 403, cors);

				const emails: string[] = Array.isArray(corpo.emails)
					? [...new Set((corpo.emails as string[]).map((e) => String(e).toLowerCase().trim()))]
					: [];
				const conteggio = emails.length > 0 ? emails.length : Number(corpo.conteggioPresenti) || 0;

				const operazioni = [
					env.DB.prepare(
						"UPDATE sessioni_collegio SET totale_presenti_rilevati = ? WHERE id = ?"
					).bind(conteggio, corpo.sessionId),
					env.DB.prepare("DELETE FROM presenti_sessione WHERE sessione_id = ?").bind(
						corpo.sessionId
					),
					...emails.map((e) =>
						env.DB.prepare(
							"INSERT INTO presenti_sessione (sessione_id, email) VALUES (?, ?)"
						).bind(corpo.sessionId, e)
					),
				];
				await env.DB.batch(operazioni);
				await tracciaOperazione(env, utente.email, "RILEVAZIONE_PRESENTI", `${conteggio} presenti per seduta ${corpo.sessionId}`);
				return rispostaJson({ success: true, presenti: conteggio }, 200, cors);
			}

			// ── 6. VOTA ─────────────────────────────────────────────────────────
			if (path === "/api/vota" && request.method === "POST") {
				const corpo = (await request.json()) as any;
				const utente = await identificaUtente(request, env, corpo.userEmail);
				if ("errore" in utente) return rispostaJson({ error: utente.errore }, 401, cors);

				// Il tipo di voto, lo stato e le opzioni si leggono dal DATABASE (non dal client!)
				const punto = (await env.DB.prepare(
					"SELECT tipo_voto, stato, sessione_id, opzioni FROM ordine_del_giorno WHERE id = ?"
				)
					.bind(corpo.puntoId)
					.first()) as {
					tipo_voto: string;
					stato: string;
					sessione_id: string;
					opzioni: string | null;
				} | null;

				if (!punto) return rispostaJson({ error: "Punto non trovato" }, 404, cors);
				if (punto.stato !== "ATTIVO")
					return rispostaJson({ error: "La votazione su questo punto non è aperta" }, 409, cors);
				if (!sceltePermesse(punto.opzioni).includes(corpo.scelta))
					return rispostaJson({ error: "Scelta non valida" }, 400, cors);

				// Con il login Google attivo: può votare solo chi risulta tra i
				// presenti della seduta (elenco incollato dal Meet dal Presidente).
				if (env.GOOGLE_CLIENT_ID) {
					const inElenco = await env.DB.prepare(
						"SELECT 1 FROM presenti_sessione WHERE sessione_id = ? AND email = ?"
					)
						.bind(punto.sessione_id, utente.email)
						.first();
					if (!inElenco) {
						const conta = (await env.DB.prepare(
							"SELECT COUNT(*) as n FROM presenti_sessione WHERE sessione_id = ?"
						)
							.bind(punto.sessione_id)
							.first()) as { n: number };
						// L'elenco è stato caricato ma tu non ci sei → niente voto.
						// (Se l'elenco è vuoto, si vota col solo controllo del dominio.)
						if (conta.n > 0 && !isAdmin(utente.email, env))
							return rispostaJson(
								{ error: "Non risulti tra i presenti rilevati in questa seduta. Rivolgiti al Presidente." },
								403,
								cors
							);
					}
				}

				// Controllo doppio voto con messaggio chiaro
				const giaVotato = await env.DB.prepare(
					"SELECT 1 FROM registro_votanti WHERE punto_id = ? AND user_email = ?"
				)
					.bind(corpo.puntoId, utente.email)
					.first();
				if (giaVotato)
					return rispostaJson({ error: "Hai già votato su questo punto" }, 409, cors);

				// Transazione atomica: registro presenza al voto + urna
				// Se il voto è SEGRETO l'email NON viene mai scritta nell'urna.
				await env.DB.batch([
					env.DB.prepare(
						"INSERT INTO registro_votanti (punto_id, user_email) VALUES (?, ?)"
					).bind(corpo.puntoId, utente.email),
					env.DB.prepare(
						"INSERT INTO urna_voti (id, punto_id, user_email, scelta) VALUES (?, ?, ?, ?)"
					).bind(
						crypto.randomUUID(),
						corpo.puntoId,
						punto.tipo_voto === "SEGRETO" ? null : utente.email,
						corpo.scelta
					),
				]);
				return rispostaJson({ success: true }, 200, cors);
			}

			// ── 7. RISULTATI E VERIFICA DEL QUORUM ──────────────────────────────
			if (path.startsWith("/api/risultati/") && request.method === "GET") {
				const puntoId = path.split("/").pop();
				const infoPunto = (await env.DB.prepare(
					"SELECT odg.tipo_voto, odg.stato, odg.opzioni, odg.presenti_al_voto, s.totale_presenti_rilevati FROM ordine_del_giorno odg JOIN sessioni_collegio s ON odg.sessione_id = s.id WHERE odg.id = ?"
				)
					.bind(puntoId)
					.first()) as
					| { tipo_voto: string; stato: string; opzioni: string | null; presenti_al_voto: number | null; totale_presenti_rilevati: number }
					| null;

				if (!infoPunto) return rispostaJson({ error: "Punto non trovato" }, 404, cors);

				const { results: voti } = await env.DB.prepare(
					"SELECT scelta, user_email FROM urna_voti WHERE punto_id = ?"
				)
					.bind(puntoId)
					.all();

				// Presenti congelati all'apertura dell'urna; per i punti votati
				// prima di questo aggiornamento si usa il valore della seduta.
				const presenti = infoPunto.presenti_al_voto ?? (infoPunto.totale_presenti_rilevati || 0);
				// Quorum deliberativo: metà dei presenti + 1 (corretto anche per numeri pari)
				const quorumRichiesto = presenti > 0 ? Math.floor(presenti / 2) + 1 : null;
				const votiTotali = voti.length;
				const isValid = quorumRichiesto !== null && votiTotali >= quorumRichiesto;

				const opzioniVoto = sceltePermesse(infoPunto.opzioni);
				const conteggio: Record<string, number> = {};
				for (const o of opzioniVoto) conteggio[o] = 0;
				const elencoNominale: { email: string; scelta: string }[] = [];
				for (const v of voti as unknown as { scelta: string; user_email: string }[]) {
					conteggio[v.scelta] = (conteggio[v.scelta] ?? 0) + 1;
					if (infoPunto.tipo_voto === "PALESE")
						elencoNominale.push({ email: v.user_email, scelta: v.scelta });
				}

				return rispostaJson(
					{
						valida: isValid,
						opzioniVoto,
						votiTotali,
						presentiNecessari: quorumRichiesto,
						totalePresentiMeet: presenti,
						avviso:
							presenti === 0
								? "Attenzione: nessun presente registrato, il quorum non è calcolabile"
								: null,
						risultatiMatematici: conteggio,
						dettaglioNominale: infoPunto.tipo_voto === "PALESE" ? elencoNominale : null,
					},
					200,
					cors
				);
			}

			// ── 8. RESOCONTO COMPLETO DELLA SEDUTA (solo admin) ─────────────────
			// Restituisce tutti i punti con esiti e dettagli, per il verbale.
			if (path.startsWith("/api/resoconto/") && request.method === "GET") {
				const sessionId = path.split("/").pop();
				const utente = await identificaUtente(
					request,
					env,
					url.searchParams.get("email") ?? undefined
				);
				if ("errore" in utente) return rispostaJson({ error: utente.errore }, 401, cors);
				if (!isAdmin(utente.email, env))
					return rispostaJson({ error: "Operazione riservata agli amministratori" }, 403, cors);

				const sessione = (await env.DB.prepare(
					"SELECT * FROM sessioni_collegio WHERE id = ?"
				)
					.bind(sessionId)
					.first()) as any;
				if (!sessione) return rispostaJson({ error: "Sessione non trovata" }, 404, cors);

				const { results: punti } = await env.DB.prepare(
					"SELECT * FROM ordine_del_giorno WHERE sessione_id = ? ORDER BY numero_punto ASC"
				)
					.bind(sessionId)
					.all();

				const presenti = (sessione.totale_presenti_rilevati as number) || 0;
				const quorumRichiesto = presenti > 0 ? Math.floor(presenti / 2) + 1 : null;

				// Elenco nominale dei presenti rilevati dal Meet (per il verbale)
				const { results: elencoPresentiRighe } = await env.DB.prepare(
					"SELECT email FROM presenti_sessione WHERE sessione_id = ? ORDER BY email ASC"
				)
					.bind(sessionId)
					.all();
				const elencoPresenti = (elencoPresentiRighe as unknown as { email: string }[]).map(
					(r) => r.email
				);

				const dettagliPunti = [];
				for (const p of punti as any[]) {
					const { results: voti } = await env.DB.prepare(
						"SELECT scelta, user_email FROM urna_voti WHERE punto_id = ?"
					)
						.bind(p.id)
						.all();
					const opzioniVoto = sceltePermesse(p.opzioni);
					const conteggio: Record<string, number> = {};
					for (const o of opzioniVoto) conteggio[o] = 0;
					const elencoNominale: { email: string; scelta: string }[] = [];
					for (const v of voti as unknown as { scelta: string; user_email: string }[]) {
						conteggio[v.scelta] = (conteggio[v.scelta] ?? 0) + 1;
						if (p.tipo_voto === "PALESE")
							elencoNominale.push({ email: v.user_email, scelta: v.scelta });
					}
					// Quorum del punto: sui presenti congelati all'apertura dell'urna
					const presentiPunto = p.presenti_al_voto ?? presenti;
					const quorumPunto = presentiPunto > 0 ? Math.floor(presentiPunto / 2) + 1 : null;
					dettagliPunti.push({
						numero: p.numero_punto,
						titolo: p.titolo,
						testo: p.testo ?? null,
						tipoVoto: p.tipo_voto,
						opzioniVoto,
						stato: p.stato,
						votiTotali: voti.length,
						presentiAlVoto: presentiPunto || null,
						quorumPunto,
						risultati: conteggio,
						valida: quorumPunto !== null && voti.length >= quorumPunto,
						dettaglioNominale: p.tipo_voto === "PALESE" ? elencoNominale : null,
					});
				}

				await tracciaOperazione(env, utente.email, "ESTRAZIONE_RESOCONTO", `seduta ${sessionId}`);
				return rispostaJson(
					{
						titolo: sessione.titolo,
						organo: sessione.organo ?? "COLLEGIO_DOCENTI",
						dataOra: sessione.data_ora,
						dataProgrammata: sessione.data_programmata ?? null,
						meetLink: sessione.meet_link ?? null,
						dominio: sessione.scuola_dominio ?? null,
						presenti,
						elencoPresenti,
						quorumRichiesto,
						generatoDa: utente.email,
						punti: dettagliPunti,
					},
					200,
					cors
				);
			}

			return rispostaJson({ error: "Percorso non trovato" }, 404, cors);
		} catch (errore: any) {
			return rispostaJson(
				{ error: "Errore interno del server", dettaglio: String(errore?.message ?? errore) },
				500,
				cors
			);
		}
	},
};
