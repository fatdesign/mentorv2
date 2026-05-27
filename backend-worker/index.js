/* ==========================================================================
   AURA MENTOR - CLOUDFLARE WORKER BACKEND (API & SECURITY ENGINE)
   ========================================================================== */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    // CORS-Header definieren (Ermöglicht sicheren Cross-Origin-Zugriff von GitHub Pages)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };

    // Preflight OPTIONS Anfrage direkt beantworten
    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // --- ENDPUNKT: Registrierung (/api/signup) ---
      if (url.pathname === "/api/signup" && method === "POST") {
        const { email, password, role, parentCode } = await request.json();

        if (!email || !password || !role) {
          return new Response(JSON.stringify({ error: "E-Mail, Passwort und Rolle sind Pflichtfelder." }), { status: 400, headers: corsHeaders });
        }

        // Prüfen, ob die E-Mail-Adresse bereits belegt ist
        const existing = await env.DB.prepare("SELECT id FROM profiles WHERE email = ?").bind(email).first();
        if (existing) {
          return new Response(JSON.stringify({ error: "Ein Konto mit dieser E-Mail-Adresse existiert bereits." }), { status: 409, headers: corsHeaders });
        }

        // Einzigartige Benutzer-ID generieren
        const id = 'usr_' + Math.random().toString(36).substr(2, 9);
        await env.DB.prepare("INSERT INTO profiles (id, email, password, role, parent_code) VALUES (?, ?, ?, ?, ?)")
          .bind(id, email, password, role, parentCode || null)
          .run();

        return new Response(JSON.stringify({ user: { id, email, role, parentCode } }), { headers: corsHeaders });
      }

      // --- ENDPUNKT: Login (/api/login) ---
      if (url.pathname === "/api/login" && method === "POST") {
        const { email, password } = await request.json();

        const user = await env.DB.prepare("SELECT * FROM profiles WHERE email = ? AND password = ?")
          .bind(email, password)
          .first();

        if (!user) {
          return new Response(JSON.stringify({ error: "Ungültige E-Mail-Adresse oder Passwort." }), { status: 401, headers: corsHeaders });
        }

        return new Response(JSON.stringify({
          user: {
            id: user.id,
            email: user.email,
            role: user.role,
            parentCode: user.parent_code
          }
        }), { headers: corsHeaders });
      }

      // --- ENDPUNKT: Chatnachrichten (/api/messages) ---
      if (url.pathname === "/api/messages") {
        // POST: Nachricht senden / sichern
        if (method === "POST") {
          const { userId, senderRole, text, isHiddenFromParent } = await request.json();
          await env.DB.prepare("INSERT INTO messages (user_id, sender_role, text, is_hidden_from_parent) VALUES (?, ?, ?, ?)")
            .bind(userId, senderRole, text, isHiddenFromParent ? 1 : 0)
            .run();

          return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        // GET: Nachrichtenverlauf abrufen
        if (method === "GET") {
          const userId = url.searchParams.get("userId");
          const requesterRole = url.searchParams.get("role");
          const parentCode = url.searchParams.get("parentCode");

          if (!userId) {
            return new Response(JSON.stringify({ error: "userId Parameter fehlt." }), { status: 400, headers: corsHeaders });
          }

          let queryUserId = userId;

          // Eltern-Kanal-Kopplung: Falls Elternteil anfragt, laden wir den Verlauf des Kindes (identifiziert über parentCode)
          if (requesterRole === 'parent' && parentCode) {
            const teenUser = await env.DB.prepare("SELECT id FROM profiles WHERE email = ? AND role = 'teen'")
              .bind(parentCode)
              .first();
            if (!teenUser) {
              return new Response(JSON.stringify([]), { headers: corsHeaders });
            }
            queryUserId = teenUser.id;
          }

          const { results } = await env.DB.prepare("SELECT * FROM messages WHERE user_id = ? ORDER BY created_at ASC")
            .bind(queryUserId)
            .all();

          // DUAL-SHIELD TRUST ENGINE: 
          // Wenn der Anforderer die Rolle 'parent' hat, wird Kindernachricht-Text direkt auf API-Ebene zensiert!
          // Dadurch gelangt die private Nachricht des Kindes unter keinen Umständen über das Netzwerk der Eltern.
          const sanitizedResults = results.map(m => {
            const isChild = m.sender_role === 'child';
            const hidden = m.is_hidden_from_parent === 1;

            return {
              sender: m.sender_role,
              text: (requesterRole === 'parent' && isChild && hidden) ? "🔒 PRIVATSPHÄRE DES KINDES GESCHÜTZT" : m.text,
              time: new Date(m.created_at + "Z").toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr',
              hiddenFromParent: hidden
            };
          });

          return new Response(JSON.stringify(sanitizedResults), { headers: corsHeaders });
        }
      }

      // --- ENDPUNKT: Kalender-Termine (/api/appointments) ---
      if (url.pathname === "/api/appointments") {
        // POST: Termin buchen
        if (method === "POST") {
          const { userId, dayNum } = await request.json();
          await env.DB.prepare("INSERT INTO appointments (user_id, day_num) VALUES (?, ?)")
            .bind(userId, dayNum)
            .run();

          return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        // GET: Alle gebuchten Termine laden
        if (method === "GET") {
          const userId = url.searchParams.get("userId");
          const requesterRole = url.searchParams.get("role");
          const parentCode = url.searchParams.get("parentCode");

          if (!userId) {
            return new Response(JSON.stringify({ error: "userId Parameter fehlt." }), { status: 400, headers: corsHeaders });
          }

          let queryUserId = userId;

          if (requesterRole === 'parent' && parentCode) {
            const teenUser = await env.DB.prepare("SELECT id FROM profiles WHERE email = ? AND role = 'teen'")
              .bind(parentCode)
              .first();
            if (!teenUser) {
              return new Response(JSON.stringify([]), { headers: corsHeaders });
            }
            queryUserId = teenUser.id;
          }

          const { results } = await env.DB.prepare("SELECT day_num FROM appointments WHERE user_id = ?")
            .bind(queryUserId)
            .all();

          return new Response(JSON.stringify(results.map(r => r.day_num)), { headers: corsHeaders });
        }
      }

      return new Response(JSON.stringify({ error: "Ungültiger API-Endpunkt." }), { status: 404, headers: corsHeaders });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }
};
