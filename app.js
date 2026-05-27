/* ==========================================================================
   AURA MENTOR - APPLICATION-STATE & INTERAKTIVE STEUERUNG
   ========================================================================== */

// --- Cloudflare Worker Konfiguration ---
// Ersetze diesen Platzhalter mit der URL deines bereitgestellten Cloudflare Workers!
const CLOUDFLARE_WORKER_URL = "https://aura-mentor-api.f-klavun.workers.dev"; 

// --- Globale P2P-Variablen (PeerJS) ---
let peerInstance = null;
let activeP2PConnection = null;

// --- Globaler Anwendungsstatus ---
const state = {
    activeView: 'landing',
    activePlan: 'Growth Horizon',
    activePrice: 279,
    currentUser: null, // Wird nach Login/Registrierung befüllt
    authMode: 'signup', // 'signup' | 'login'
    authRole: 'teen',   // 'teen' | 'parent'
    appointments: [12, 19], // Standardmäßig gebuchte Tage (Mai 2026)
    chatHistory: [
        {
            sender: 'mentor',
            text: "Hey Leo! Wie lief deine Woche? Unser nächster Videocall ist zwar für morgen geplant, aber du kannst mir gerne schon hier schreiben, worüber du sprechen möchtest oder was dich heute beschäftigt. 😊",
            time: "10:14 Uhr",
            hiddenFromParent: false
        }
    ],
    videoCallTimer: null,
    videoCallSeconds: 0
};

// --- Echte / Lokale Datenbank-Schnittstelle (Cloudflare Worker Hybrid-Modus) ---
const db = {
    get isCloud() {
        return CLOUDFLARE_WORKER_URL !== "DEINE_CLOUDFLARE_WORKER_URL" && CLOUDFLARE_WORKER_URL.trim() !== "";
    },

    // Registrierung eines neuen Benutzers
    async signUp(email, password, role, parentCode) {
        if (this.isCloud) {
            const response = await fetch(`${CLOUDFLARE_WORKER_URL}/api/signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, role, parentCode })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Fehler bei der Registrierung.");
            return result.user;
        } else {
            // Echte lokale Datenbank über HTML5 LocalStorage
            let users = JSON.parse(localStorage.getItem('aura_users') || '[]');
            if (users.find(u => u.email === email)) {
                throw new Error("Ein Konto mit dieser E-Mail-Adresse existiert bereits.");
            }

            const userId = 'usr_' + Math.random().toString(36).substr(2, 9);
            const newUser = { id: userId, email, password, role, parentCode };
            users.push(newUser);
            localStorage.setItem('aura_users', JSON.stringify(users));
            return newUser;
        }
    },

    // Anmeldung eines bestehenden Benutzers
    async signIn(email, password) {
        if (this.isCloud) {
            const response = await fetch(`${CLOUDFLARE_WORKER_URL}/api/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Ungültige Anmeldedaten.");
            return result;
        } else {
            let users = JSON.parse(localStorage.getItem('aura_users') || '[]');
            const user = users.find(u => u.email === email && u.password === password);
            if (!user) {
                throw new Error("Ungültige E-Mail-Adresse oder Passwort.");
            }
            return {
                user: {
                    id: user.id,
                    email: user.email,
                    role: user.role,
                    parentCode: user.parentCode
                }
            };
        }
    },

    // Sichert eine Chatnachricht in der Datenbank
    async saveMessage(sender, text, hiddenFromParent) {
        const timeStr = getGermanTimeStr();
        const newMessage = { sender, text, time: timeStr, hiddenFromParent };

        if (this.isCloud) {
            const response = await fetch(`${CLOUDFLARE_WORKER_URL}/api/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: state.currentUser.id,
                    senderRole: sender,
                    text,
                    isHiddenFromParent: hiddenFromParent
                })
            });
            if (!response.ok) console.error("Cloudflare Chat-Speicherfehler.");
        } else {
            // Lokale Daten persistieren
            const sessionKey = `aura_chats_${state.currentUser.id}`;
            let chats = JSON.parse(localStorage.getItem(sessionKey) || '[]');
            chats.push(newMessage);
            localStorage.setItem(sessionKey, JSON.stringify(chats));
        }

        state.chatHistory.push(newMessage);
    },

    // Lädt den authentifizierten Chatverlauf
    async getChatHistory() {
        if (this.isCloud) {
            const url = `${CLOUDFLARE_WORKER_URL}/api/messages?userId=${state.currentUser.id}&role=${state.currentUser.role}&parentCode=${state.currentUser.parentCode || ''}`;
            const response = await fetch(url);
            if (!response.ok) {
                console.error("Cloudflare Chat-Ladefehler.");
                return state.chatHistory;
            }
            const data = await response.json();
            if (data.length === 0) return state.chatHistory;
            return data;
        } else {
            const sessionKey = `aura_chats_${state.currentUser.id}`;
            return JSON.parse(localStorage.getItem(sessionKey) || JSON.stringify(state.chatHistory));
        }
    },

    // Sichert eine gebuchte Sitzung im Kalender
    async saveAppointment(day) {
        if (this.isCloud) {
            const response = await fetch(`${CLOUDFLARE_WORKER_URL}/api/appointments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: state.currentUser.id,
                    dayNum: day
                })
            });
            if (!response.ok) console.error("Cloudflare Kalender-Buchungsfehler.");
        } else {
            const sessionKey = `aura_appointments_${state.currentUser.id}`;
            let appts = JSON.parse(localStorage.getItem(sessionKey) || JSON.stringify(state.appointments));
            if (!appts.includes(day)) {
                appts.push(day);
            }
            localStorage.setItem(sessionKey, JSON.stringify(appts));
        }
    },

    // Lädt die gebuchten Termine des Benutzers
    async getAppointments() {
        if (this.isCloud) {
            const url = `${CLOUDFLARE_WORKER_URL}/api/appointments?userId=${state.currentUser.id}&role=${state.currentUser.role}&parentCode=${state.currentUser.parentCode || ''}`;
            const response = await fetch(url);
            if (!response.ok) {
                console.error("Cloudflare Kalender-Ladefehler.");
                return state.appointments;
            }
            const data = await response.json();
            if (data.length === 0) return state.appointments;
            return data;
        } else {
            const sessionKey = `aura_appointments_${state.currentUser.id}`;
            return JSON.parse(localStorage.getItem(sessionKey) || JSON.stringify(state.appointments));
        }
    }
};

// --- Zeitstempel-Hilfsfunktion im deutschen Format ---
function getGermanTimeStr() {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes} Uhr`;
}

// --- Empathische Mentor-Antworten basierend auf den Themen der Jugendlichen ---
const mentorDialogues = {
    stress: [
        "Prüfungsangst ist absolut verständlich und sehr real, Leo. Aber denk bitte immer daran: Deine Noten definieren nicht deinen Wert als Mensch. 🌟",
        "Lass uns deine Vorbereitung in kleine, überschaubare 25-Minuten-Blöcke unterteilen. Das macht die Aufgaben viel leichter. Welches Fach bereitet dir gerade am meisten Sorgen?",
        "Versuche heute Abend, gut zu schlafen. Schlaf ist wie ein Akku-Boost für ein gestresstes Gehirn. Morgen in unserem gemeinsamen Call besprechen wir das ganz in Ruhe!"
    ],
    parent: [
        "Es kann unglaublich frustrierend und verletzend sein, wenn man das Gefühl hat, dass die eigenen Eltern einen überhaupt nicht verstehen. Es ist völlig normal, dass du dich so fühlst.",
        "Meistens handeln Eltern aus Sorge und Liebe, auch wenn die Art und Weise, wie sie es zeigen, sich manchmal falsch, nervig oder einengend anfühlt. Lass uns mal besprechen, wie wir das am besten ruhig ansprechen können.",
        "Du hast hier einen absolut sicheren Raum, Leo. Erzähl mir gerne, worum genau der Streit ging, und wir gehen das Schritt für Schritt gemeinsam durch."
    ],
    fitting: [
        "Sich ausgeschlossen zu fühlen ist ein verdammt schweres Gefühl, Leo. Ich kenne das selbst aus meiner eigenen Jugend, und man fängt sofort an, sich selbst infrage zu stellen.",
        "Aber ich möchte dir eins sagen: Du bist genau richtig, wie du bist. Du wirst die Menschen finden, die dich schätzen und dich so akzeptieren, wie du bist.",
        "Lass uns darauf konzentrieren, dein Selbstvertrauen in den Dingen zu stärken, die dir wirklich Spaß machen. Was sind Hobbys oder Aktivitäten, bei denen du dich am wohlsten fühlst?"
    ],
    plan: [
        "Das sind absolut großartige Neuigkeiten, Leo! 🚀 Ich bin mega stolz auf deine Disziplin. Einen Plan so konsequent durchzuziehen ist ein riesiger Erfolg.",
        "Lass uns schauen, was diese Woche besonders gut lief, damit wir das für nächste Woche genau so wiederholen können. Du baust dir gerade tolle Gewohnheiten auf!",
        "Morgen in unserem Video-Call optimieren wir die Routine noch ein bisschen und feiern deinen Erfolg!"
    ],
    fallback: [
        "Ich höre dir zu, Leo. Danke, dass du das so offen mit mir teilst. Genau dafür bin ich da.",
        "Lass uns einmal tief durchatmen. Du musst diese Dinge nicht alle alleine lösen. Wir gehen das gemeinsam an.",
        "Lass uns dieses Thema direkt für unsere Sitzung morgen notieren, damit wir ganz in Ruhe eine gute Strategie besprechen können. Wie klingt das für dich?"
    ]
};

// Index zum Durchlaufen der Antworten, falls der Benutzer mehrere Nachrichten zum selben Thema sendet
let responseIndices = { stress: 0, parent: 0, fitting: 0, plan: 0, fallback: 0 };

// --- View Router Logik ---
function switchView(viewName) {
    state.activeView = viewName;

    // View DOM-Elemente umschalten
    const views = ['landing', 'auth', 'teen', 'parent'];
    views.forEach(v => {
        const viewEl = document.getElementById(`view-${v}`);
        const btnEl = document.getElementById(`btn-switch-${v}`);
        
        if (v === viewName) {
            if (viewEl) viewEl.classList.add('active-view');
            if (btnEl) btnEl.classList.add('active');
        } else {
            if (viewEl) viewEl.classList.remove('active-view');
            if (btnEl) btnEl.classList.remove('active');
        }
    });

    // Synchronisiere Chatlogs & Kalender über beide Dashboards
    renderTeenChat();
    renderParentChat();
    renderCalendar();

    // Bei Seitenwechsel nach oben scrollen
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Kauf- / Abo-Auswahl Flow ---
function purchasePlan(planName, price) {
    state.activePlan = planName;
    state.activePrice = price;

    // Dashboards synchronisieren
    const labelPlan = document.getElementById('parent-plan-name');
    const labelDisplay = document.getElementById('parent-plan-display');
    if (labelPlan) labelPlan.textContent = planName;
    if (labelDisplay) labelDisplay.textContent = `${planName} (€${price})`;

    // Interaktives Popup
    alert(`✨ Tarif ausgewählt: Du hast den Tarif "${planName}" (€${price}/Monat) gewählt.\n\nWir haben deine Dashboards freigeschaltet! Registriere dich jetzt kostenlos, um auf dein persönliches Dashboard zuzugreifen.`);
    
    // Weiterleitung zum Anmeldebildschirm
    openAuthGate('parent');
}

// --- Authentifizierungs-Gate Steuerung ---
function openAuthGate(role) {
    if (state.currentUser) {
        // Bereits angemeldet -> Leite direkt zum passenden Dashboard weiter
        switchView(state.currentUser.role);
    } else {
        // Nicht angemeldet -> Leite zum Auth-Bildschirm
        state.authRole = role;
        state.authMode = 'signup'; // Registrierungs-Modus standardmäßig
        updateAuthFormUI();
        switchView('auth');
    }
}

// Setzt die ausgewählte Rolle im Auth-Formular
function setAuthRole(role) {
    state.authRole = role;
    updateAuthFormUI();
}

// Wechselt zwischen Registrierung und Login
function toggleAuthMode(event) {
    if (event) event.preventDefault();
    state.authMode = state.authMode === 'signup' ? 'login' : 'signup';
    updateAuthFormUI();
}

// Aktualisiert das Anmeldeformular dynamisch
function updateAuthFormUI() {
    const title = document.getElementById('auth-title');
    const subtitle = document.getElementById('auth-subtitle');
    const btnSubmit = document.getElementById('btn-auth-submit');
    const toggleMsg = document.getElementById('auth-toggle-msg');
    const toggleLink = document.getElementById('auth-toggle-link');
    const parentGroup = document.getElementById('parent-link-group');
    
    const tabTeen = document.getElementById('auth-role-teen');
    const tabParent = document.getElementById('auth-role-parent');
    
    if (state.authRole === 'teen') {
        if (tabTeen) tabTeen.classList.add('active');
        if (tabParent) tabParent.classList.remove('active');
        if (parentGroup) parentGroup.style.display = 'none';
    } else {
        if (tabTeen) tabTeen.classList.remove('active');
        if (tabParent) tabParent.classList.add('active');
        if (parentGroup) {
            parentGroup.style.display = state.authMode === 'signup' ? 'block' : 'none';
        }
    }
    
    if (state.authMode === 'signup') {
        if (title) title.textContent = "Konto erstellen";
        if (subtitle) subtitle.textContent = "Erstelle dein kostenloses Konto bei Aura Safe.";
        if (btnSubmit) btnSubmit.textContent = "Konto erstellen";
        if (toggleMsg) toggleMsg.textContent = "Bereits registriert?";
        if (toggleLink) toggleLink.textContent = "Jetzt einloggen";
    } else {
        if (title) title.textContent = "Willkommen zurück";
        if (subtitle) subtitle.textContent = "Melde dich an, um auf deine Sitzungen zuzugreifen.";
        if (btnSubmit) btnSubmit.textContent = "Einloggen";
        if (toggleMsg) toggleMsg.textContent = "Noch kein Konto?";
        if (toggleLink) toggleLink.textContent = "Jetzt registrieren";
        if (parentGroup) parentGroup.style.display = 'none';
    }
}

// Sendet das Anmelde-/Registrierungsformular ab
async function submitAuthForm() {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value.trim();
    const parentCode = document.getElementById('auth-parent-link-id').value.trim();
    
    if (!email || !password) {
        alert("⚠️ Bitte fülle E-Mail-Adresse und Passwort aus.");
        return;
    }
    
    if (password.length < 6) {
        alert("⚠️ Das Passwort muss mindestens 6 Zeichen lang sein.");
        return;
    }
    
    try {
        if (state.authMode === 'signup') {
            const newUser = await db.signUp(email, password, state.authRole, parentCode);
            alert("🎉 Konto erfolgreich erstellt! Du wirst jetzt eingeloggt.");
            state.currentUser = newUser;
        } else {
            const result = await db.signIn(email, password);
            state.currentUser = result.user;
        }
        
        // Nach erfolgreichem Login: Daten laden
        state.chatHistory = await db.getChatHistory();
        state.appointments = await db.getAppointments();
        
        // UI Profile-Widgets dynamisch anpassen
        updateProfileUI();

        // P2P-Verbindung starten
        initTeenPeer();

        // Zum Dashboard leiten
        switchView(state.currentUser.role);
        
    } catch (error) {
        alert(`❌ Fehler: ${error.message}`);
    }
}

// Aktualisiert das Benutzerprofil im Dashboard
function updateProfileUI() {
    const avatars = document.querySelectorAll('.profile-avatar');
    avatars.forEach(av => {
        av.textContent = state.currentUser.email.charAt(0).toUpperCase();
    });

    const teenLabel = document.querySelector('.user-profile-widget h4');
    if (teenLabel) {
        teenLabel.innerHTML = `${state.currentUser.email.split('@')[0]} <span style="font-size:0.7rem; color:var(--text-muted);">(${state.currentUser.role === 'teen' ? 'Teenager' : 'Elternteil'})</span>`;
    }

    // Abmelde-Link dynamisch einfügen
    const widgets = document.querySelectorAll('.user-profile-widget');
    widgets.forEach(w => {
        if (!w.querySelector('.btn-logout')) {
            const logoutBtn = document.createElement('button');
            logoutBtn.className = 'btn-logout';
            logoutBtn.style.cssText = "background:transparent; border:none; color:#f87171; font-size:0.7rem; font-weight:bold; cursor:pointer; padding:0; margin-top:4px; display:block; text-align:left; text-decoration:underline;";
            logoutBtn.textContent = "Abmelden";
            logoutBtn.onclick = handleLogout;
            w.querySelector('.profile-info').appendChild(logoutBtn);
        }
    });
}

// Abmelde-Vorgang
function handleLogout() {
    if (confirm("Möchtest du dich wirklich abmelden?")) {
        state.currentUser = null;
        state.chatHistory = [
            {
                sender: 'mentor',
                text: "Hey Leo! Wie lief deine Woche? Unser nächster Videocall ist zwar für morgen geplant, aber du kannst mir gerne schon hier schreiben, worüber du sprechen möchtest oder was dich heute beschäftigt. 😊",
                time: "10:14 Uhr",
                hiddenFromParent: false
            }
        ];
        state.appointments = [12, 19];

        // Abmelde-Buttons entfernen
        const logoutBtns = document.querySelectorAll('.btn-logout');
        logoutBtns.forEach(btn => btn.remove());

        // Peer Verbindung trennen
        if (peerInstance) {
            peerInstance.destroy();
            peerInstance = null;
            activeP2PConnection = null;
        }

        switchView('landing');
        alert("🔒 Du hast dich erfolgreich abgemeldet.");
    }
}

// --- Teen Chat Input Handler ---
function handleChatKey(event) {
    if (event.key === 'Enter') {
        sendTeenMessage();
    }
}

// --- Click Prompt Chip Event ---
function clickPrompt(text) {
    const input = document.getElementById('teen-chat-input');
    if (input) {
        input.value = text;
        sendTeenMessage();
    }
}

// --- Teen Nachricht absenden ---
async function sendTeenMessage() {
    const input = document.getElementById('teen-chat-input');
    const msgText = input.value.trim();
    if (!msgText) return;

    const timeStr = getGermanTimeStr();

    // Nachricht in DB speichern (lokal/cloud)
    await db.saveMessage('child', msgText, true);

    // Input leeren
    input.value = '';

    // Dashboards neu rendern
    renderTeenChat();
    renderParentChat();

    // Nach unten scrollen
    scrollChatToBottom();

    // P2P-Daten übertragen, falls gekoppelt
    broadcastP2PUpdate();

    // Mentor-Antwort verzögert triggern
    triggerMentorResponse(msgText, timeStr);
}

// --- Mentor-Antworten simulieren ---
function triggerMentorResponse(childMessage, timeStr) {
    const typingBubble = document.getElementById('typing-bubble');
    if (typingBubble) typingBubble.style.display = 'flex';
    scrollChatToBottom();

    // Keywords im Text des Kindes erkennen
    let topic = 'fallback';
    const lowerMsg = childMessage.toLowerCase();
    
    if (lowerMsg.includes('stress') || lowerMsg.includes('prüfungs') || lowerMsg.includes('schlaf') || lowerMsg.includes('note') || lowerMsg.includes('exam')) {
        topic = 'stress';
    } else if (lowerMsg.includes('eltern') || lowerMsg.includes('streit') || lowerMsg.includes('verstehen') || lowerMsg.includes('disput') || lowerMsg.includes('parent')) {
        topic = 'parent';
    } else if (lowerMsg.includes('ausgeschlossen') || lowerMsg.includes('dazugehören') || lowerMsg.includes('freunde') || lowerMsg.includes('schule') || lowerMsg.includes('fit in')) {
        topic = 'fitting';
    } else if (lowerMsg.includes('plan') || lowerMsg.includes('lernplan') || lowerMsg.includes('schedule') || lowerMsg.includes('routine') || lowerMsg.includes('gewohnheit')) {
        topic = 'plan';
    }

    // Passenden Dialog laden und Index rotieren
    const responseArray = mentorDialogues[topic];
    const currentIndex = responseIndices[topic];
    const mentorReplyText = responseArray[currentIndex];
    
    // Index erhöhen, damit bei der nächsten Frage ein neuer Satz kommt
    responseIndices[topic] = (currentIndex + 1) % responseArray.length;

    // Simuliere Schreibverzögerung (1,5 Sekunden) für ein realistischeres Gefühl
    setTimeout(async () => {
        if (typingBubble) typingBubble.style.display = 'none';

        // Mentor-Antwort in DB speichern (lokal/cloud)
        await db.saveMessage('mentor', mentorReplyText, false);

        // Neu rendern
        renderTeenChat();
        renderParentChat();
        scrollChatToBottom();

        // P2P-Daten übertragen, falls gekoppelt
        broadcastP2PUpdate();
    }, 1500);
}

// --- Scroll-Hilfsfunktion ---
function scrollChatToBottom() {
    const teenContainer = document.getElementById('teen-chat-log');
    const parentContainer = document.getElementById('parent-chat-log');
    
    if (teenContainer) teenContainer.scrollTop = teenContainer.scrollHeight;
    if (parentContainer) parentContainer.scrollTop = parentContainer.scrollHeight;
}

// --- Teenager-Chat Sanctuary rendern ---
function renderTeenChat() {
    const container = document.getElementById('teen-chat-log');
    if (!container) return;

    container.innerHTML = state.chatHistory.map(msg => {
        const bubbleClass = msg.sender === 'child' ? 'chat-bubble-child' : 'chat-bubble-mentor';
        const senderName = msg.sender === 'child' ? 'Du' : 'Alex';
        
        return `
            <div class="chat-bubble ${bubbleClass}">
                ${msg.text}
                <span class="chat-time">${senderName} • ${msg.time}</span>
            </div>
        `;
    }).join('');
}

// --- Eltern-Chat-Protokoll rendern (Zensiert/Verschlüsselt) ---
function renderParentChat() {
    const container = document.getElementById('parent-chat-log');
    if (!container) return;

    container.innerHTML = state.chatHistory.map(msg => {
        if (msg.sender === 'child') {
            // RENDERE GEBLURRTE NACHRICHT MIT ZUGRIFFSSPERRE
            return `
                <div class="chat-bubble chat-bubble-child parent-shielded-container">
                    <span class="parent-shielded-msg">${msg.text}</span>
                    <div class="parent-shield-lock-overlay">
                        <span class="lock-badge">🔒 Privatsphäre des Kindes geschützt</span>
                    </div>
                </div>
            `;
        } else {
            // Mentor-Antworten bleiben lesbar
            return `
                <div class="chat-bubble chat-bubble-mentor">
                    ${msg.text}
                    <span class="chat-time">Alex (Mentor) • ${msg.time}</span>
                </div>
            `;
        }
    }).join('');
}

// ==========================================================================
// ASYMMETRISCHER VIDEOCALL-STEUERUNG
// ==========================================================================

function openVideoRoom() {
    const overlay = document.getElementById('video-room');
    if (overlay) overlay.style.display = 'flex';

    // Stoppuhr für die Session starten
    state.videoCallSeconds = 0;
    const timerDisplay = document.getElementById('call-time-elapsed');
    
    state.videoCallTimer = setInterval(() => {
        state.videoCallSeconds++;
        const minutes = Math.floor(state.videoCallSeconds / 60).toString().padStart(2, '0');
        const seconds = (state.videoCallSeconds % 60).toString().padStart(2, '0');
        if (timerDisplay) timerDisplay.textContent = `${minutes}:${seconds}`;
    }, 1000);
}

function closeVideoRoom() {
    const overlay = document.getElementById('video-room');
    if (overlay) overlay.style.display = 'none';

    // Timer stoppen
    clearInterval(state.videoCallTimer);
    state.videoCallTimer = null;
}

// ==========================================================================
// INTERAKTIVER TERMINPLANER / BUCHUNGSKALENDER
// ==========================================================================

let selectedDayForBooking = null;

function renderCalendar() {
    const grid = document.getElementById('calendar-grid');
    if (!grid) return;

    grid.innerHTML = '';

    // Wochentage-Kopfzeile rendern
    const daysHeader = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    daysHeader.forEach(d => {
        const headerCell = document.createElement('div');
        headerCell.className = 'calendar-day-label';
        headerCell.textContent = d;
        grid.appendChild(headerCell);
    });

    // Mai 2026 startet an einem Freitag (Tag-Index 4 in der Header-Zeile: Mo=0, Di=1, Mi=2, Do=3, Fr=4)
    // Leere Offsets für den Freitagsstart
    for (let i = 0; i < 4; i++) {
        const offsetCell = document.createElement('div');
        offsetCell.className = 'calendar-cell empty';
        grid.appendChild(offsetCell);
    }

    // 31 Kalendertage rendern
    for (let day = 1; day <= 31; day++) {
        const cell = document.createElement('div');
        cell.className = 'calendar-cell';
        cell.textContent = day;

        // Im Status prüfen, ob bereits gebucht
        if (state.appointments.includes(day)) {
            cell.classList.add('booked-session');
            cell.title = "Support-Sitzung mit Alex gebucht";
        }

        cell.onclick = () => openBookingPopup(day);
        grid.appendChild(cell);
    }
}

// --- Buchungs-Popup öffnen ---
function openBookingPopup(dayNum) {
    // Falls das Datum bereits gebucht ist, Feedback geben
    if (state.appointments.includes(dayNum)) {
        alert(`📅 Sitzung gebucht: Du hast bereits eine Sitzung mit Alex am ${dayNum}. Mai 2026 um 15:30 Uhr gebucht.\n\nKlicke zum Teilnehmen einfach oben in der Navigation auf "Sitzung beitreten"!`);
        return;
    }

    selectedDayForBooking = dayNum;
    const dateLabel = document.getElementById('booking-popup-date');
    if (dateLabel) dateLabel.textContent = `Wähle eine Uhrzeit für den ${dayNum}. Mai 2026:`;

    const popup = document.getElementById('booking-popup');
    if (popup) popup.style.display = 'flex';
}

function closeBookingPopup(event) {
    const popup = document.getElementById('booking-popup');
    if (popup) popup.style.display = 'none';
    selectedDayForBooking = null;
}

// --- Buchung bestätigen ---
async function confirmAppointment(timeStr) {
    if (selectedDayForBooking) {
        // Termin in DB speichern (lokal/cloud)
        await db.saveAppointment(selectedDayForBooking);
        
        state.appointments = await db.getAppointments();
        renderCalendar();
        closeBookingPopup(null);
        alert(`🎉 Erfolg! Dein 45-minütiger asymmetrischer Call am ${selectedDayForBooking}. Mai 2026 um ${timeStr} Uhr mit Mentor Alex ist gebucht.\n\nDas Kontrollzentrum deiner Eltern wurde aktualisiert, um diese Coaching-Stunde zu protokollieren.`);
        
        // P2P-Daten übertragen, falls gekoppelt
        broadcastP2PUpdate();
    }
}

// ==========================================================================
// PEER-TO-PEER (P2P) INTERAKTIVE KOPPLUNGS-STEUERUNG
// ==========================================================================

// --- Teenager-Peer initialisieren ---
function initTeenPeer() {
    if (!state.currentUser || state.currentUser.role !== 'teen') return;

    const emailPrefix = state.currentUser.email.split('@')[0].toUpperCase();
    const teenPeerId = `AURA-${emailPrefix}`;

    const label = document.getElementById('teen-peer-id');
    if (label) label.textContent = teenPeerId;

    const input = document.getElementById('parent-connect-id');
    if (input) input.value = teenPeerId;

    peerInstance = new Peer(teenPeerId);

    peerInstance.on('open', (id) => {
        console.log('Teen Peer initialisiert mit ID:', id);
        updateTeenP2PStatus('offline', 'P2P Echtzeit-Kopplung: Inaktiv (Warte auf Eltern-Verbindung...)');
    });

    peerInstance.on('connection', (conn) => {
        activeP2PConnection = conn;
        setupP2PConnectionHandlers(conn);
        updateTeenP2PStatus('online', 'P2P Echtzeit-Kopplung: 🟢 Gekoppelt mit Eltern-Hub');
        broadcastP2PUpdate();
    });

    peerInstance.on('error', (err) => {
        console.error('PeerJS Fehler (Teen):', err);
        updateTeenP2PStatus('offline', 'Kopplungs-Fehler. Versuche es gleich erneut.');
    });
}

// --- Eltern-Peer verbinden ---
function connectToTeen() {
    const connectId = document.getElementById('parent-connect-id').value.trim();
    if (!connectId) return;

    updateParentP2PStatus('offline', 'Verbindung wird aufgebaut...');

    if (!peerInstance) {
        peerInstance = new Peer();
    }

    peerInstance.on('open', (id) => {
        console.log('Eltern Peer geöffnet mit ID:', id);
        
        const conn = peerInstance.connect(connectId);
        activeP2PConnection = conn;
        setupP2PConnectionHandlers(conn);

        conn.on('open', () => {
            updateParentP2PStatus('online', 'P2P Echtzeit-Kopplung: 🟢 Gekoppelt mit Teen-Portal');
            conn.send({ type: 'request-initial-sync' });
        });
    });

    peerInstance.on('error', (err) => {
        console.error('PeerJS Fehler (Eltern):', err);
        updateParentP2PStatus('offline', 'Verbindung fehlgeschlagen.');
    });
}

// --- Gemeinsame P2P-Daten-Handler ---
function setupP2PConnectionHandlers(conn) {
    conn.on('data', (data) => {
        console.log('Empfangene P2P-Daten:', data);
        
        if (data.type === 'chat-history-sync') {
            state.chatHistory = data.history;
            renderTeenChat();
            renderParentChat();
            scrollChatToBottom();
        } else if (data.type === 'appointment-booking-sync') {
            state.appointments = data.appointments;
            renderCalendar();
        } else if (data.type === 'request-initial-sync') {
            broadcastP2PUpdate();
        }
    });

    conn.on('close', () => {
        updateTeenP2PStatus('offline', 'Verbindung getrennt. Warte auf erneuten Aufbau...');
        updateParentP2PStatus('offline', 'Verbindung getrennt.');
        activeP2PConnection = null;
    });
}

// --- Synchronisations-Broadcast an den gekoppelten Peer senden ---
function broadcastP2PUpdate() {
    if (activeP2PConnection && activeP2PConnection.open) {
        activeP2PConnection.send({
            type: 'chat-history-sync',
            history: state.chatHistory
        });
        activeP2PConnection.send({
            type: 'appointment-booking-sync',
            appointments: state.appointments
        });
    }
}

// --- Verbindungs-Badge Status-Update Hilfsfunktionen ---
function updateTeenP2PStatus(status, text) {
    const dot = document.getElementById('teen-p2p-dot');
    const statusText = document.getElementById('teen-p2p-status');
    if (dot && statusText) {
        statusText.textContent = text;
        if (status === 'online') {
            dot.className = 'p2p-status-dot online';
        } else {
            dot.className = 'p2p-status-dot offline';
        }
    }
}

// --- Verbindungs-Badge Status-Update Hilfsfunktionen ---
function updateParentP2PStatus(status, text) {
    const dot = document.getElementById('parent-p2p-dot');
    const statusText = document.getElementById('parent-p2p-status');
    if (dot && statusText) {
        statusText.textContent = text;
        if (status === 'online') {
            dot.className = 'p2p-status-dot online';
        } else {
            dot.className = 'p2p-status-dot offline';
        }
    }
}

// ==========================================================================
// SCROLL- & NAVIGATION-HILFSFUNKTIONEN
// ==========================================================================

function scrollToElement(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
}

function scrollToPricing() {
    switchView('landing');
    setTimeout(() => {
        scrollToElement('pricing');
    }, 300);
}

function cancelSubscription() {
    const confirmCancel = confirm("⚠️ Bist du sicher, dass du Leos Aura Mentoring-Tarif kündigen möchtest?\n\nDadurch werden alle aktiven Chat-Kanäle und Buchungen sofort gesperrt.");
    if (confirmCancel) {
        state.activePlan = 'Kein aktiver Tarif';
        state.activePrice = 0;
        const nameLabel = document.getElementById('parent-plan-name');
        const displayLabel = document.getElementById('parent-plan-display');
        if (nameLabel) nameLabel.textContent = 'Gekündigt';
        if (displayLabel) displayLabel.textContent = 'Kein aktiver Tarif (Inaktiv)';
        alert("Der Mentoring-Tarif wurde erfolgreich gekündigt. Der Zugriff wurde eingeschränkt.");
    }
}

// --- Beim Laden der Seite ausführen ---
window.onload = () => {
    // Show role switcher only on localhost or if explicitly enabled via query parameter
    const urlParams = new URLSearchParams(window.location.search);
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || urlParams.has('demo') || urlParams.has('debug')) {
        const switcher = document.querySelector('.role-switcher-container');
        if (switcher) switcher.style.display = 'flex';
    }

    // Initiales Rendern
    renderTeenChat();
    renderParentChat();
    renderCalendar();
};
