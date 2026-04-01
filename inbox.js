/**
 * ICBOT - Lógica del Frontend para Bandeja Omnicanal (Meta)
 * Versión v33.3 - Aislamiento por Columna 'channel'
 */

const socket = io();
let currentChat = null;
let currentPlatform = 'all'; 
let omniChats = []; 

const chatItemsList = document.getElementById('chat-items-list');
const messagesContainer = document.getElementById('messages-container');
const msgInput = document.getElementById('msg-input');
const btnSend = document.getElementById('btn-send');
const searchInput = document.getElementById('chat-search');

document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.body.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);

    loadOmniChats();

    msgInput.addEventListener('keydown', handleKeyboardShortcuts);
    
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            currentPlatform = e.currentTarget.dataset.filter;
            renderChatList();
        });
    });

    searchInput.addEventListener('input', (e) => {
        renderChatList(e.target.value.toLowerCase());
    });
});

socket.on('update_chats_list', () => {
    loadOmniChats(); 
});

socket.on('new_message', (msg) => {
    if (currentChat === msg.phone) {
        appendMessage(msg);
        scrollToBottom();
    }
});

async function loadOmniChats() {
    try {
        const res = await fetch('/api/chats-full?view=active');
        const allChats = await res.json();
        
        // --- CÁLCULO DE GLOBOS (BADGES) ---
        let waUnread = 0;
        let omniUnread = 0;
        
        allChats.forEach(c => {
            const ch = c.channel || 'whatsapp';
            if (c.unreadCount > 0) {
                if (ch === 'whatsapp') waUnread += c.unreadCount;
                else omniUnread += c.unreadCount;
            }
        });
        
        // Actualizamos los numeritos en el menú
        const badgeWa = document.getElementById('badge-wa');
        const badgeOmni = document.getElementById('badge-omni');
        
        if(badgeWa) {
            badgeWa.innerText = waUnread;
            badgeWa.style.display = waUnread > 0 ? 'block' : 'none';
        }
        if(badgeOmni) {
            badgeOmni.innerText = omniUnread;
            badgeOmni.style.display = omniUnread > 0 ? 'block' : 'none';
        }
        
        // --- FILTRO DEFINITIVO: Solo Redes Sociales ---
        // Ahora usamos la columna 'channel' enviada por el backend
        omniChats = allChats.filter(c => c.channel === 'instagram' || c.channel === 'messenger');

        renderChatList();
    } catch (error) {
        console.error('Error cargando chats omnicanal:', error);
    }
}

async function loadChatHistory(phone, name, platform) {
    currentChat = phone;
    
    document.getElementById('conversation-empty').style.display = 'none';
    document.getElementById('conversation-active').style.display = 'flex';
    document.getElementById('active-name').innerText = name;
    
    const sourceIcon = platform === 'instagram' ? '<i class="fab fa-instagram"></i> Instagram Direct' : '<i class="fab fa-facebook-messenger"></i> Messenger';
    document.getElementById('active-source').innerHTML = sourceIcon;

    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
    const clickedItem = document.getElementById(`chat-${phone}`);
    if (clickedItem) clickedItem.classList.add('active');

    try {
        messagesContainer.innerHTML = '<div class="loading-state"><i class="fas fa-circle-notch fa-spin"></i></div>';
        const res = await fetch(`/api/chat-history/${phone}`);
        const history = await res.json();
        
        messagesContainer.innerHTML = '';
        history.forEach(msg => appendMessage(msg));
        
        scrollToBottom();
        msgInput.focus();
        loadLeadDataToCRM(phone); 
    } catch (error) {
        console.error('Error cargando historial:', error);
    }
}

function renderChatList(searchTerm = '') {
    if (omniChats.length === 0) {
        chatItemsList.innerHTML = '<div class="empty-state">No hay mensajes de redes sociales.</div>';
        return;
    }

    let filteredChats = omniChats.filter(chat => {
        const textToSearch = (chat.name + chat.id).toLowerCase();
        const matchesSearch = textToSearch.includes(searchTerm);
        
        let matchesPlatform = true;
        if (currentPlatform === 'instagram') matchesPlatform = chat.channel === 'instagram';
        else if (currentPlatform === 'messenger') matchesPlatform = chat.channel === 'messenger';
        
        return matchesSearch && matchesPlatform;
    });

    chatItemsList.innerHTML = filteredChats.map(c => {
        const isIg = c.channel === 'instagram';
        const platformIcon = isIg ? '<i class="fab fa-instagram" style="color: #E1306C;"></i>' : '<i class="fab fa-facebook-messenger" style="color: #0084FF;"></i>';
        
        // Limpiamos etiquetas de texto viejas si existen
        const cleanMsg = c.lastMessage.text ? c.lastMessage.text.replace(/\[Instagram\] |\[Messenger\] /g, '') : 'Multimedia';

        return `
            <div class="chat-item ${currentChat === c.id ? 'active' : ''}" id="chat-${c.id}" onclick="loadChatHistory('${c.id}', '${c.name.replace(/'/g, "\\'")}', '${c.channel}')">
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
    // Limpiamos el texto de etiquetas de plataforma para que Lore vea el mensaje puro
    let text = msg.text.replace(/\[Instagram\] |\[Messenger\] /g, '');
    const bubbleClass = msg.role === 'user' ? 'msg-incoming' : 'msg-outgoing';
    
    const msgHTML = `
        <div class="message-bubble ${bubbleClass}">
            <div class="message-text">${text.replace(/\n/g, '<br>')}</div>
            <div class="message-time">${formatTime(msg.time)}</div>
        </div>
    `;
    messagesContainer.insertAdjacentHTML('beforeend', msgHTML);
}

async function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || !currentChat) return;

    msgInput.value = '';
    msgInput.focus();

    try {
        await fetch('/api/chat/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: currentChat, message: text })
        });
    } catch (error) {
        showToast("Error al enviar el mensaje.");
    }
}

btnSend.addEventListener('click', sendMessage);

function handleKeyboardShortcuts(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
    }
    if (e.altKey && e.key === '1') {
        e.preventDefault();
        toggleCRM();
    }
}

function formatTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function toggleCRM() {
    document.getElementById('crm-panel').classList.toggle('open');
}

function showToast(message) {
    const container = document.getElementById('toast-container');
    if(!container) return alert(message);
    const toast = document.createElement('div');
    toast.className = 'toast show';
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3000);
}

document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const currentTheme = document.body.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.body.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeIcon(newTheme);
});

function updateThemeIcon(theme) {
    const icon = document.querySelector('#theme-toggle i');
    if (!icon) return;
    icon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
}

async function loadLeadDataToCRM(phone) {
    try {
        const res = await fetch('/api/data/leads');
        const leads = await res.json();
        const lead = leads.find(l => l.phone === phone);
        document.getElementById('crm-id').value = phone;
        if (lead) {
            document.getElementById('crm-name').value = lead.nombre || '';
            document.getElementById('crm-tag').value = lead.status_tag || 'nuevo';
        }
    } catch(e) { console.error(e); }
}
