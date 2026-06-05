/**
 * ICBOT - Lógica del Frontend para Bandeja Omnicanal (Meta)
 * Versión v33.6 - IA Fantasma, CRM, Fix Etiquetas y BORRADO MASIVO
 */

const socket = io();
let currentChat = null;
let currentPlatform = 'all'; 
let currentView = 'active'; // <-- NUEVO: Para manejar Activos/Archivados
let omniChats = []; 
window._cachedTags = []; 

// --- VARIABLES SELECCIÓN MÚLTIPLE ---
let bulkMode = false;
let selectedChats = new Set();
let lastCheckedIndex = -1;

const chatItemsList = document.getElementById('chat-items-list');
const messagesContainer = document.getElementById('messages-container');
const msgInput = document.getElementById('msg-input');
const btnSend = document.getElementById('btn-send');
const searchInput = document.getElementById('chat-search');

const executivesMap = {
    "005Dn000007mWFhIAM": "Luz",
    "005UO000000PdB3YAK": "Felipe",
    "005Dn000005u1yTIAQ": "Mario",
    "005Dn000005u27NIAQ": "Marcos",
    "005Dn000005u22vIAA": "Fabio",
    "005Dn000005u2BkIAI": "Diana",
    "005Dn000007H1EUIA0": "Marketing",
    "005Dn000003Z5vbIAC": "Oscar",
    "Pendiente": "Pendiente (Sin Asignar)"
};

document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.body.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);

    loadOmniChats();
    loadTagFilterOptions(); 

    msgInput.addEventListener('keydown', handleKeyboardShortcuts);
    
    // Filtros de Plataforma
    document.querySelectorAll('.platform-filter, .filters .filter-btn:not(.view-filter)').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if(e.currentTarget.innerText.includes('Cerrar')) return;
            // Ajuste para que solo desmarque los de su grupo
            const siblings = e.currentTarget.parentElement.querySelectorAll('.filter-btn');
            siblings.forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            currentPlatform = e.currentTarget.dataset.filter;
            renderChatList();
        });
    });

    // Filtros de Vista (Activos / Archivados)
    document.querySelectorAll('.view-filter').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.view-filter').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            currentView = e.currentTarget.dataset.view;
            loadOmniChats(); // Refrescar base de datos
        });
    });

    searchInput.addEventListener('input', (e) => {
        renderChatList(e.target.value.toLowerCase());
    });
});

// --- WEBSOCKETS ---
socket.on('update_chats_list', () => {
    loadOmniChats(); 
});

socket.on('new_message', (msg) => {
    if (currentChat === msg.phone) {
        appendMessage(msg);
        scrollToBottom();
    }
});

// --- CARGA Y RENDERIZADO DE CHATS ---
async function loadOmniChats() {
    try {
        const res = await fetch(`/api/chats-full?view=${currentView}`);
        const allChats = await res.json();
        
        let waUnread = 0;
        let omniUnread = 0;
        
        allChats.forEach(c => {
            const ch = c.channel || 'whatsapp';
            if (c.unreadCount > 0) {
                if (ch === 'whatsapp') waUnread += 1; 
                else omniUnread += 1;
            }
        });
        
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
        
        omniChats = allChats.filter(c => c.channel === 'instagram' || c.channel === 'messenger');

        renderChatList();
    } catch (error) {
        console.error('Error cargando chats omnicanal:', error);
    }
}

function renderChatList(searchTerm = searchInput.value.toLowerCase()) {
    if (omniChats.length === 0) {
        chatItemsList.innerHTML = `<div class="empty-state" style="margin-top: 40px;"><p>No hay mensajes ${currentView === 'archived' ? 'archivados' : 'activos'} en redes.</p></div>`;
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
        
        const cleanMsg = c.lastMessage.text ? c.lastMessage.text.replace(/\[Instagram\] |\[Messenger\] /g, '') : 'Multimedia';

        let uniqueLabels = [];
        let seenTexts = new Set();
        if(c.labels && Array.isArray(c.labels)) {
            c.labels.forEach(l => {
                let txt = l.text || l;
                if(!seenTexts.has(txt)) {
                    seenTexts.add(txt);
                    uniqueLabels.push(l);
                }
            });
        }
        
        const labelsHtml = uniqueLabels.map(l => { 
            const tag = typeof l === 'string' ? {text: l, color: '#555'} : l;
            return `<span class="mini-tag" style="background:${tag.color}20; color:${tag.color}; border:1px solid ${tag.color}50">${tag.text}</span>`;
        }).join('');

        const isSelected = selectedChats.has(c.id);

        return `
            <div class="chat-item ${currentChat === c.id ? 'active' : ''}" id="chat-${c.id}" onclick="handleChatClick('${c.id}', '${c.name.replace(/'/g, "\\'")}', '${c.channel}', event)">
                <input type="checkbox" class="bulk-checkbox" ${isSelected ? 'checked' : ''} onclick="toggleChatSelection('${c.id}', event)">
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
                    <div class="mini-tags">${labelsHtml}</div>
                </div>
            </div>
        `;
    }).join('');
}

// --- SISTEMA DE BORRADO MASIVO Y SELECCIÓN MÚLTIPLE ---
function toggleBulkMode() {
    bulkMode = !bulkMode;
    const btn = document.getElementById('bulk-toggle-btn');
    const toolbar = document.getElementById('bulk-toolbar');
    const panel = document.querySelector('.chat-list');
    
    if (bulkMode) { 
        if(btn) btn.classList.add('active'); 
        if(panel) panel.classList.add('bulk-mode'); 
        if(toolbar) toolbar.classList.add('show');
    } else { 
        if(btn) btn.classList.remove('active'); 
        if(panel) panel.classList.remove('bulk-mode'); 
        if(toolbar) toolbar.classList.remove('show'); 
        selectedChats.clear(); 
        lastCheckedIndex = -1;
        updateBulkVisuals();
    }
}

function handleChatClick(phone, name, channel, event) {
    if (bulkMode) {
        toggleChatSelection(phone, event);
    } else {
        loadChatHistory(phone, name, channel);
    }
}

function selectAllBulkChats() {
    if (!bulkMode) return;
    const checkboxes = document.querySelectorAll('.bulk-checkbox');
    let allChecked = true;
    checkboxes.forEach(cb => { if (!cb.checked) allChecked = false; });

    checkboxes.forEach(cb => {
        const phone = cb.closest('.chat-item').id.replace('chat-', '');
        if (allChecked) {
            selectedChats.delete(phone);
        } else {
            selectedChats.add(phone);
        }
    });
    const counter = document.getElementById('bulk-count');
    if(counter) counter.innerText = selectedChats.size;
    updateBulkVisuals();
}

function toggleChatSelection(phone, event) {
    if (!bulkMode) return;
    event.stopPropagation();
    
    const checkboxes = Array.from(document.querySelectorAll('.bulk-checkbox'));
    let targetCb = event.target;
    
    if (targetCb.tagName !== 'INPUT') {
        targetCb = document.querySelector(`#chat-${phone} .bulk-checkbox`);
        targetCb.checked = !targetCb.checked;
    }

    const currentIndex = checkboxes.indexOf(targetCb);
    const isChecking = targetCb.checked;

    if (event.shiftKey && lastCheckedIndex !== -1) {
        const start = Math.min(lastCheckedIndex, currentIndex);
        const end = Math.max(lastCheckedIndex, currentIndex);
        
        for (let i = start; i <= end; i++) {
            checkboxes[i].checked = isChecking;
            const p = checkboxes[i].closest('.chat-item').id.replace('chat-', '');
            if (isChecking) {
                selectedChats.add(p);
            } else {
                selectedChats.delete(p);
            }
        }
    } else {
        if (isChecking) {
            selectedChats.add(phone);
        } else {
            selectedChats.delete(phone);
        }
    }
    
    lastCheckedIndex = currentIndex;
    const counter = document.getElementById('bulk-count');
    if(counter) counter.innerText = selectedChats.size;
}

function updateBulkVisuals() {
    document.querySelectorAll('.chat-item').forEach(item => {
        const p = item.id.replace('chat-', '');
        const cb = item.querySelector('.bulk-checkbox');
        if (cb) cb.checked = selectedChats.has(p);
    });
}

async function executeBulkDelete() {
    if (selectedChats.size === 0) return showToast("Selecciona al menos un chat para eliminar.");
    
    if (!confirm(`⚠️ ¡Peligro! Vas a eliminar PERMANENTEMENTE ${selectedChats.size} chats de la Bandeja Omnicanal.\nEsta acción borra todo el historial y no se puede deshacer.\n\n¿Estás seguro?`)) return;
    
    showToast("🗑️ Eliminando chats... por favor espera.");
    
    const phones = Array.from(selectedChats);
    
    // Borrado secuencial para no sobrecargar la base de datos
    for (let i = 0; i < phones.length; i++) {
        try {
            await fetch('/api/chat/action', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ phone: phones[i], action: 'delete' })
            });
        } catch(e) { console.error(`Error borrando ${phones[i]}`, e); }
    }
    
    showToast(`✅ ${phones.length} chats eliminados correctamente.`);
    toggleBulkMode();
    
    if (selectedChats.has(currentChat)) {
        currentChat = null;
        document.getElementById('conversation-empty').style.display = 'flex';
        document.getElementById('conversation-active').style.display = 'none';
        document.getElementById('crm-panel').classList.remove('open');
    }

    loadOmniChats(); 
}

async function loadChatHistory(phone, name, platform) {
    currentChat = phone;
    
    document.getElementById('conversation-empty').style.display = 'none';
    document.getElementById('conversation-active').style.display = 'flex';
    document.getElementById('active-name').innerText = name;
    
    const sourceIcon = platform === 'instagram' ? '<i class="fab fa-instagram" style="color: #E1306C;"></i> Instagram Direct' : '<i class="fab fa-facebook-messenger" style="color: #0084FF;"></i> Messenger';
    document.getElementById('active-source').innerHTML = sourceIcon;

    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
    const clickedItem = document.getElementById(`chat-${phone}`);
    if (clickedItem) clickedItem.classList.add('active');

    try {
        messagesContainer.innerHTML = '<div class="loading-state" style="text-align:center; padding:20px;"><i class="fas fa-circle-notch fa-spin"></i> Cargando...</div>';
        const res = await fetch(`/api/chat-history/${phone}`);
        const history = await res.json();
        
        messagesContainer.innerHTML = '';
        history.forEach(msg => appendMessage(msg));
        
        scrollToBottom();
        msgInput.focus();

        loadLeadDataToCRM(phone); 
        renderCRMTags(window._cachedTags);
    } catch (error) {
        console.error('Error cargando historial:', error);
    }
}

function appendMessage(msg) {
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

// --- ENVÍO DE MENSAJES Y ATAJOS ---
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

// --- 🔥 IA FANTASMA: LECTURA Y AUTO-LLENADO ---
async function analyzeChatAI() {
    if(!currentChat) return showToast("Abre un chat primero para analizar.");
    
    const btn = document.getElementById('btn-analyze-ai');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Leyendo chat...';
    btn.disabled = true;

    try {
        const res = await fetch('/api/chat/analyze-lead', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: currentChat })
        });
        const result = await res.json();

        if (result.success && result.data) {
            const d = result.data;
            if(d.nombre) document.getElementById('crm-name').value = d.nombre;
            if(d.ciudad) document.getElementById('crm-city').value = d.ciudad;
            if(d.correo) document.getElementById('crm-email').value = d.correo;
            if(d.producto_especifico) document.getElementById('crm-specific-interest').value = d.producto_especifico;
            
            if(d.categoria_interes) {
                const select = document.getElementById('crm-interest');
                for(let opt of select.options) {
                    if(opt.value.toUpperCase() === d.categoria_interes.toUpperCase()) {
                        select.value = opt.value;
                        break;
                    }
                }
            }
            showToast("✨ Ficha llenada por la IA. Revisa y haz clic en Guardar.");
        } else {
            showToast("No se encontró información clara en el chat.");
        }
    } catch (error) {
        showToast("Error conectando con la IA.");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// --- CRM COMPLETO Y ETIQUETAS ---
async function loadLeadDataToCRM(phone) {
    try {
        // 1. Limpiar campos
        document.getElementById('crm-name').value = ""; 
        document.getElementById('crm-city').value = ""; 
        document.getElementById('crm-email').value = ""; 
        document.getElementById('crm-interest').value = ""; 
        document.getElementById('crm-specific-interest').value = ""; 
        document.getElementById('crm-executive').value = "Pendiente"; 

        // 2. Traer datos
        const res = await fetch('/api/data/leads');
        const leads = await res.json();
        const lead = leads.find(l => l.phone === phone);
        
        const idField = document.getElementById('crm-id');
        if(idField) idField.value = phone;
        
        // 3. Llenar si existe
        if (lead) {
            document.getElementById('crm-name').value = lead.nombre || '';
            document.getElementById('crm-city').value = lead.ciudad || '';
            document.getElementById('crm-email').value = lead.correo || '';
            document.getElementById('crm-specific-interest').value = lead.producto_especifico || '';
            
            if(lead.interes) {
                const select = document.getElementById('crm-interest');
                let found = false;
                for(let opt of select.options) {
                    if(opt.value.toUpperCase() === lead.interes.toUpperCase()) {
                        select.value = opt.value;
                        found = true;
                        break;
                    }
                }
                if(!found) select.value = "Consultando";
            }
            
            let execSelect = document.getElementById('crm-executive'); 
            if (lead.etiqueta && executivesMap[lead.etiqueta]) { 
                execSelect.value = lead.etiqueta; 
            } else { 
                execSelect.value = "Pendiente"; 
            }
        }
    } catch(e) { console.error("Error cargando CRM:", e); }
}

async function saveLeadManual() { 
    if(!currentChat) return; 
    
    try {
        const res = await fetch('/api/data/leads'); 
        const leads = await res.json(); 
        const lead = leads.find(l => l.phone === currentChat); 
        const id = lead ? lead.id : null; 
        
        if(id) { 
            const updates = [ 
                {field:'nombre', value:document.getElementById('crm-name').value}, 
                {field:'ciudad', value:document.getElementById('crm-city').value}, 
                {field:'correo', value:document.getElementById('crm-email').value}, 
                {field:'interes', value:document.getElementById('crm-interest').value}, 
                {field:'producto_especifico', value:document.getElementById('crm-specific-interest').value}, 
                {field:'etiqueta', value:document.getElementById('crm-executive').value} 
            ]; 
            
            for(let u of updates) { 
                await fetch('/api/leads/update', { 
                    method: 'POST', 
                    headers: {'Content-Type': 'application/json'}, 
                    body: JSON.stringify({ id, field: u.field, value: u.value }) 
                }); 
            }
            showToast("✅ Ficha Guardada Correctamente"); 
        } else { 
            showToast("⚠️ Espera un primer mensaje del cliente para crear su ficha."); 
        } 
    } catch (e) {
        showToast("Error al guardar.");
    }
}

async function syncSalesforceCurrent() {
    if(!currentChat) return;
    showToast("🔄 Sincronizando SF...");
    try {
        const res = await fetch('/api/salesforce/sync-lead', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ phone: currentChat })
        });
        const data = await res.json();
        if(data.success) {
            showToast("✅ Subido a Salesforce (ID: " + data.sfId + ")");
        } else {
            showToast("❌ Error: " + data.message);
        }
    } catch(e) {
        showToast("❌ Fallo de red con el servidor");
    }
}

// --- GESTIÓN DE ETIQUETAS VISUALES ---
async function loadTagFilterOptions() { 
    try { 
        const tagsResponse = await fetch('/api/data/tags');
        window._cachedTags = await tagsResponse.json(); 
    } catch(e) { console.error("Error cargando etiquetas", e); } 
}

function renderCRMTags(tags) {
    const container = document.getElementById('tag-list');
    if (!container) return;

    const chat = omniChats.find(c => c.id === currentChat); 
    const activeTags = chat ? (chat.labels || []) : []; 

    const uniqueTags = [];
    const seenTags = new Set();
    tags.forEach(t => {
        if(!seenTags.has(t.name)) { seenTags.add(t.name); uniqueTags.push(t); }
    });

    container.innerHTML = uniqueTags.map(t => { 
        const isActive = activeTags.find(l => (l.text || l) === t.name); 
        return `<div class="tag ${isActive ? 'selected' : ''}" style="${isActive ? `background:${t.color}; border-color:${t.color};` : ''}" onclick="toggleTagLocal('${t.name}', '${t.color}')">${t.name}</div>`; 
    }).join(''); 
}

function updateTagsOptimistic(phone, tagObj, remove = false) {
    const chat = omniChats.find(c => c.id === phone);
    if (chat) {
        if (!chat.labels) chat.labels = [];
        if (remove) {
            chat.labels = chat.labels.filter(l => (l.text || l) !== tagObj.text);
        } else {
            if (!chat.labels.find(l => (l.text || l) === tagObj.text)) {
                chat.labels.push(tagObj);
            }
        }
        updateBulkVisuals();
    }
}

async function toggleTagLocal(name, color) { 
    if(!currentChat) return; 
    
    const chat = omniChats.find(c => c.id === currentChat);
    const activeTags = chat ? (chat.labels || []) : [];
    const exists = activeTags.find(l => (l.text || l) === name);
    
    const tagObj = { text: name, color: color };
    
    // UI Optimista
    updateTagsOptimistic(currentChat, tagObj, !!exists);
    renderCRMTags(window._cachedTags);
    
    // Petición al Backend
    try {
        let newTags = [...activeTags]; 
        if(exists) newTags = newTags.filter(l => (l.text || l) !== name); 
        else newTags.push(tagObj); 
        
        await fetch('/api/chat/action', { 
            method: 'POST', 
            headers: {'Content-Type': 'application/json'}, 
            body: JSON.stringify({ phone: currentChat, action: 'set_labels', value: newTags }) 
        });
    } catch(e) { 
        showToast("Error guardando etiqueta."); 
    }
}

// --- UTILIDADES ---
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
    if (panel) panel.classList.toggle('open');
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
