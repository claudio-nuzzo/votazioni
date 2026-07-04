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

/** Verifica se l'utente è un amministratore (presidente/segretario). */
function isAdmin(email: string, env: Env): boolean {
	if (!env.ADMIN_EMAILS) return true; // in modalità test tutti possono amministrare
	return env.ADMIN_EMAILS.toLowerCase()
		.split(",")
		.map((e) => e.trim())
		.includes(email.toLowerCase());
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

			// ── 1. CREA SESSIONE DEL COLLEGIO (solo admin) ──────────────────────
			if (path === "/api/sessione/crea" && request.method === "POST") {
				const corpo = (await request.json()) as any;
				const utente = await identificaUtente(request, env, corpo.userEmail);
				if ("errore" in utente) return rispostaJson({ error: utente.errore }, 401, cors);
				if (!isAdmin(utente.email, env))
					return rispostaJson({ error: "Operazione riservata agli amministratori" }, 403, cors);

				const sessionId = crypto.randomUUID();
				await env.DB.prepare(
					"INSERT INTO sessioni_collegio (id, scuola_dominio, titolo, meet_link) VALUES (?, ?, ?, ?)"
				)
					.bind(sessionId, corpo.scuolaDominio ?? "", corpo.titolo, corpo.meetLink ?? null)
					.run();
				return rispostaJson({ success: true, sessionId }, 200, cors);
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

				const statements = punti.map((p) =>
					env.DB.prepare(
						"INSERT INTO ordine_del_giorno (id, sessione_id, numero_punto, titolo, tipo_voto) VALUES (?, ?, ?, ?, ?)"
					).bind(crypto.randomUUID(), corpo.sessionId, Number(p.numero), p.titolo, p.tipo)
				);
				await env.DB.batch(statements);
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

				await env.DB.prepare("UPDATE ordine_del_giorno SET stato = ? WHERE id = ?")
					.bind(corpo.nuovoStato, corpo.puntoId)
					.run();
				return rispostaJson({ success: true }, 200, cors);
			}

			// ── 5. REGISTRA IL NUMERO DEI PRESENTI (solo admin) ─────────────────
			if (path === "/api/sessione/presenti" && request.method === "POST") {
				const corpo = (await request.json()) as any;
				const utente = await identificaUtente(request, env, corpo.userEmail);
				if ("errore" in utente) return rispostaJson({ error: utente.errore }, 401, cors);
				if (!isAdmin(utente.email, env))
					return rispostaJson({ error: "Operazione riservata agli amministratori" }, 403, cors);

				await env.DB.prepare(
					"UPDATE sessioni_collegio SET totale_presenti_rilevati = ? WHERE id = ?"
				)
					.bind(Number(corpo.conteggioPresenti), corpo.sessionId)
					.run();
				return rispostaJson({ success: true }, 200, cors);
			}

			// ── 6. VOTA ─────────────────────────────────────────────────────────
			if (path === "/api/vota" && request.method === "POST") {
				const corpo = (await request.json()) as any;
				const utente = await identificaUtente(request, env, corpo.userEmail);
				if ("errore" in utente) return rispostaJson({ error: utente.errore }, 401, cors);

				if (!["FAVOREVOLE", "CONTRARIO", "ASTENUTO"].includes(corpo.scelta))
					return rispostaJson({ error: "Scelta non valida" }, 400, cors);

				// Il tipo di voto e lo stato si leggono dal DATABASE (non dal client!)
				const punto = (await env.DB.prepare(
					"SELECT tipo_voto, stato FROM ordine_del_giorno WHERE id = ?"
				)
					.bind(corpo.puntoId)
					.first()) as { tipo_voto: string; stato: string } | null;

				if (!punto) return rispostaJson({ error: "Punto non trovato" }, 404, cors);
				if (punto.stato !== "ATTIVO")
					return rispostaJson({ error: "La votazione su questo punto non è aperta" }, 409, cors);

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
					"SELECT odg.tipo_voto, odg.stato, s.totale_presenti_rilevati FROM ordine_del_giorno odg JOIN sessioni_collegio s ON odg.sessione_id = s.id WHERE odg.id = ?"
				)
					.bind(puntoId)
					.first()) as
					| { tipo_voto: string; stato: string; totale_presenti_rilevati: number }
					| null;

				if (!infoPunto) return rispostaJson({ error: "Punto non trovato" }, 404, cors);

				const { results: voti } = await env.DB.prepare(
					"SELECT scelta, user_email FROM urna_voti WHERE punto_id = ?"
				)
					.bind(puntoId)
					.all();

				const presenti = infoPunto.totale_presenti_rilevati || 0;
				// Quorum deliberativo: metà dei presenti + 1 (corretto anche per numeri pari)
				const quorumRichiesto = presenti > 0 ? Math.floor(presenti / 2) + 1 : null;
				const votiTotali = voti.length;
				const isValid = quorumRichiesto !== null && votiTotali >= quorumRichiesto;

				const conteggio: Record<string, number> = {
					FAVOREVOLE: 0,
					CONTRARIO: 0,
					ASTENUTO: 0,
				};
				const elencoNominale: { email: string; scelta: string }[] = [];
				for (const v of voti as unknown as { scelta: string; user_email: string }[]) {
					conteggio[v.scelta]++;
					if (infoPunto.tipo_voto === "PALESE")
						elencoNominale.push({ email: v.user_email, scelta: v.scelta });
				}

				return rispostaJson(
					{
						valida: isValid,
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
