/**
 * ICBOT - Lógica del Frontend para Bandeja Omnicanal (Meta)
 * Maneja WebSockets, renderizado de chats y atajos de teclado.
 */

// 1. Inicialización y Estado Global
const socket = io();
let currentChat = null;
let currentPlatform = 'all'; // all, messenger, instagram
let omniChats = []; // Almacenará solo chats de IG y Messenger

// Elementos del DOM
const chatItemsList = document.getElementById('chat-items-list');
const messagesContainer = document.getElementById('messages-container');
const msgInput = document.getElementById('msg-input');
const btnSend = document.getElementById('btn-send');
const searchInput = document.getElementById('chat-search');

// 2. Eventos al cargar la página
document.addEventListener('DOMContentLoaded', () => {
    // Inicializar tema
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.body.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);

    // Cargar chats iniciales
    loadOmniChats();

    // Configurar Atajos de Teclado en el input
    msgInput.addEventListener('keydown', handleKeyboardShortcuts);
    
    // Configurar Filtros
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            currentPlatform = e.currentTarget.dataset.filter;
            renderChatList();
        });
    });

    // Búsqueda en vivo
    searchInput.addEventListener('input', (e) => {
        renderChatList(e.target.value.toLowerCase());
    });
});

// 3. WebSockets: Escuchando mensajes en tiempo real
socket.on('update_chats_list', () => {
    loadOmniChats(); // Refrescar la lista de la izquierda
});

socket.on('new_message', (msg) => {
    // Si el mensaje es del chat que tenemos abierto actualmente, lo pintamos
    if (currentChat === msg.phone) {
        appendMessage(msg);
        scrollToBottom();
    }
});

// 4. Lógica de Datos (Llamadas al Backend)
async function loadOmniChats() {
    try {
        // Usamos tu mismo endpoint, pero filtraremos en el Front los que son de Meta (Redes)
        const res = await fetch('/api/chats-full?view=active');
        const allChats = await res.json();
        
        // Filtramos: Solo queremos mostrar los que entraron por Instagram o Messenger
        // Asumimos que guardamos el 'source' en la BD cuando llegan por el nuevo Webhook
        omniChats = allChats.filter(chat => {
            // Revisa en tu historial si hay un mensaje que empiece con [Instagram] o [Messenger]
            return chat.lastMessage && (chat.lastMessage.text.includes('[Instagram]') || chat.lastMessage.text.includes('[Messenger]'));
        });

        renderChatList();
    } catch (error) {
        console.error('Error cargando chats omnicanal:', error);
        chatItemsList.innerHTML = '<div class="empty-state">Error al cargar los mensajes.</div>';
    }
}

async function loadChatHistory(phone, name, platform) {
    currentChat = phone;
    
    // Cambiar vistas
    document.getElementById('conversation-empty').style.display = 'none';
    document.getElementById('conversation-active').style.display = 'flex';
    
    // Actualizar Cabecera
    document.getElementById('active-name').innerText = name;
    
    const sourceIcon = platform.includes('Instagram') ? '<i class="fab fa-instagram"></i> Instagram Direct' : '<i class="fab fa-facebook-messenger"></i> Messenger';
    document.getElementById('active-source').innerHTML = sourceIcon;

    // Resaltar chat en la lista
    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
    const clickedItem = document.getElementById(`chat-${phone}`);
    if (clickedItem) clickedItem.classList.add('active');

    // Cargar historial del backend
    try {
        messagesContainer.innerHTML = '<div class="loading-state"><i class="fas fa-circle-notch fa-spin"></i></div>';
        
        const res = await fetch(`/api/chat-history/${phone}`);
        const history = await res.json();
        
        messagesContainer.innerHTML = '';
        history.forEach(msg => appendMessage(msg));
        
        scrollToBottom();
        msgInput.focus();
        loadLeadDataToCRM(phone); // Carga datos en el panel derecho
        
    } catch (error) {
        console.error('Error cargando historial:', error);
        showToast("No se pudo cargar el historial de este chat.");
    }
}

// 5. Renderizado de Interfaz
function renderChatList(searchTerm = '') {
    if (omniChats.length === 0) {
        chatItemsList.innerHTML = '<div class="empty-state">No hay mensajes nuevos en redes sociales.</div>';
        return;
    }

    let filteredChats = omniChats.filter(chat => {
        const textToSearch = (chat.name + chat.id).toLowerCase();
        const matchesSearch = textToSearch.includes(searchTerm);
        
        let matchesPlatform = true;
        if (currentPlatform === 'instagram') {
            matchesPlatform = chat.lastMessage.text.includes('[Instagram]');
        } else if (currentPlatform === 'messenger') {
            matchesPlatform = chat.lastMessage.text.includes('[Messenger]');
        }
        
        return matchesSearch && matchesPlatform;
    });

    chatItemsList.innerHTML = filteredChats.map(c => {
        // Detectamos la plataforma basándonos en la marca que dejó el Webhook backend
        const isIg = c.lastMessage.text.includes('[Instagram]');
        const platformIcon = isIg ? '<i class="fab fa-instagram" style="color: #E1306C;"></i>' : '<i class="fab fa-facebook-messenger" style="color: #0084FF;"></i>';
        const platformText = isIg ? 'Instagram' : 'Messenger';
        
        // Limpiamos la marca [Plataforma] para que no se vea fea en el preview
        const cleanMsg = c.lastMessage.text.replace(/\[Instagram\] |\[Messenger\] /g, '');

        return `
            <div class="chat-item ${currentChat === c.id ? 'active' : ''}" id="chat-${c.id}" onclick="loadChatHistory('${c.id}', '${c.name.replace(/'/g, "\\'")}', '${platformText}')">
                <div class="chat-avatar">
                    ${c.photoUrl ? `<img src="${c.photoUrl}">` : '<i class="fas fa-user"></i>'}
                    <div class="platform-badge">${platformIcon}</div>
                </div>
                <div class="chat-info">
                    <div class="chat-name">
                        <h4>${c.name}</h4>
                        <span class="time">${formatTime(c.lastMessage.time)}</span>
                    </div>
                    <div class="chat-preview">
                        <p>${cleanMsg}</p>
                        ${c.unreadCount > 0 ? `<span class="unread-badge">${c.unreadCount}</span>` : ''}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function appendMessage(msg) {
    // Limpiamos las etiquetas internas del texto antes de mostrarlo
    let text = msg.text.replace(/\[Instagram\] |\[Messenger\] /g, '');
    
    // Determinar de qué lado va la burbuja
    // Si es 'user' va a la izquierda. Si es 'bot' o 'manual' (Lorena), a la derecha.
    const bubbleClass = msg.role === 'user' ? 'msg-incoming' : 'msg-outgoing';
    
    const msgHTML = `
        <div class="message-bubble ${bubbleClass}">
            <div class="message-text">${text.replace(/\n/g, '<br>')}</div>
            <div class="message-time">${formatTime(msg.time)}</div>
        </div>
    `;
    
    messagesContainer.insertAdjacentHTML('beforeend', msgHTML);
}

// 6. Acciones del Usuario (Envío y Atajos)
async function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || !currentChat) return;

    // Limpiamos el input y devolvemos el foco
    msgInput.value = '';
    msgInput.focus();

    // Enviamos al backend (usamos el mismo endpoint de envío manual que ya tienes)
    try {
        await fetch('/api/chat/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: currentChat, message: text })
        });
    } catch (error) {
        showToast("Error al enviar el mensaje. Revisa tu conexión.");
    }
}

btnSend.addEventListener('click', sendMessage);

// --- ATAJOS DE TECLADO (Requerimiento de Lore) ---
function handleKeyboardShortcuts(e) {
    // 1. Enviar con Ctrl + Enter (o Cmd + Enter en Mac)
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault(); // Evita que haga un salto de línea
        sendMessage();
        return;
    }
    
    // 2. Abrir/Cerrar panel CRM con Alt + 1
    if (e.altKey && e.key === '1') {
        e.preventDefault();
        toggleCRM();
    }
}

// 7. Utilidades (Formateo de fechas, CRM, Temas)
function formatTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function toggleCRM() {
    const panel = document.getElementById('crm-panel');
    panel.classList.toggle('open');
}

function showToast(message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast show';
    toast.innerText = message;
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Tema Oscuro/Claro
document.getElementById('theme-toggle').addEventListener('click', () => {
    const currentTheme = document.body.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.body.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeIcon(newTheme);
});

function updateThemeIcon(theme) {
    const icon = document.querySelector('#theme-toggle i');
    if (theme === 'dark') {
        icon.className = 'fas fa-sun';
    } else {
        icon.className = 'fas fa-moon';
    }
}

// Función stub para cargar datos en el CRM lateral
async function loadLeadDataToCRM(phone) {
    try {
        const res = await fetch('/api/data/leads');
        const leads = await res.json();
        const lead = leads.find(l => l.phone === phone);
        
        document.getElementById('crm-id').value = phone;
        if (lead) {
            document.getElementById('crm-name').value = lead.nombre || '';
            document.getElementById('crm-tag').value = lead.status_tag || 'nuevo';
        } else {
            document.getElementById('crm-name').value = '';
        }
    } catch(e) {
        console.error("Error cargando CRM:", e);
    }
}
