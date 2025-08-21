(function() {
  const el = (sel, root=document) => root.querySelector(sel);
  const elAll = (sel, root=document) => Array.from(root.querySelectorAll(sel));

  const app = el('#app');
  app.innerHTML = `
    <div class="sidebar">
      <div class="title" id="app-title">Slack Archive</div>
      <div id="workspace-selector" class="workspace-selector" style="display: none;">
        <select id="workspace-select">
          <option value="">Loading...</option>
        </select>
      </div>
      <div class="search">
        <input id="search" placeholder="Search messages"/>
        <button id="clear-search" class="clear-btn" title="Clear search">×</button>
      </div>
      <div class="list" id="conv-list"></div>
    </div>
    <div class="main">
      <div class="header">
        <div class="title" id="conv-title">Select a conversation</div>
        <div class="actions"><button id="toggle-sort" class="icon-btn" title="Toggle sort order">↓ Oldest</button></div>
      </div>
      <div class="messages" id="messages"></div>
      <div class="footer">Local viewer. Files served from ./exports/files if present.</div>
    </div>
  `;

  let conversations = [];
  let activeId = null;
  let userIdToName = {};
  let meId = null;
  let users = {};
  let emojiMap = {};
  let sortNewestFirst = false;
  let currentConversation = null;
  let loadedConversations = {};
  let searchTimeout = null;
  let currentSearchTerm = null;
  let currentWorkspace = null;
  let workspaceInfo = null;
  
  // Extract workspace from URL path (e.g., /workspace-id or /)
  function getWorkspaceFromUrl() {
    const path = window.location.pathname;
    return path.length > 1 ? path.substring(1) : null; // Remove leading slash
  }
  
  // Update URL to reflect current workspace
  function updateUrl(workspaceId) {
    const newPath = workspaceId ? `/${workspaceId}` : '/';
    if (window.location.pathname !== newPath) {
      window.history.pushState(null, '', newPath);
    }
  }

  function initials(name) {
    const parts = String(name || '?').split(/\s+/).filter(Boolean);
    return parts.slice(0,2).map(s => s[0]).join('').toUpperCase();
  }

  function prettifyMpdmName(name) {
    // Convert "mpdm-user1--user2--user3-1" to "user1, user2, user3"
    const match = String(name).match(/^mpdm-(.+)-\d+$/);
    if (match) {
      const usernames = match[1].split('--');
      return usernames.join(', ');
    }
    return name;
  }

  function timeFromTs(ts) {
    const d = new Date(Number(ts) * 1000);
    return d.toLocaleString();
  }

  async function fetchWorkspaces() {
    const res = await fetch('/api/workspaces');
    return res.json();
  }

  function getApiUrl(endpoint) {
    const url = new URL(endpoint, window.location.origin);
    if (currentWorkspace) {
      url.searchParams.set('workspace', currentWorkspace);
    }
    return url.toString();
  }

  async function fetchSummary() {
    const res = await fetch(getApiUrl('/api/summary'));
    const data = await res.json();
    return data && data.summary ? data.summary : [];
  }

  async function fetchConversation(id) {
    const res = await fetch(getApiUrl(`/api/conversation/${encodeURIComponent(id)}`));
    if (!res.ok) throw new Error('Failed to load conversation');
    return res.json();
  }

  async function renderList() {
    const q = el('#search').value.toLowerCase().trim();
    const list = el('#conv-list');
    list.innerHTML = '';

    if (!q) {
      // Show all conversations when no search query
      currentSearchTerm = null;
      conversations
        .sort((a,b) => a.name.localeCompare(b.name))
        .forEach(c => {
          const div = document.createElement('div');
          div.className = 'conv' + (c.id === activeId ? ' active' : '');
          const displayName = prettifyMpdmName(c.name.replace(/_/g, ' '));

          // Check if this is a multi-party DM
          const isMpdm = /^mpdm-.+-\d+$/.test(c.name);
          let avatarHtml;

          if (isMpdm) {
            avatarHtml = `<img src="group-icon.svg" alt="Group chat"/>`;
          } else {
            const avatarFile = (c.is_im && c.user && users[c.user] && users[c.user].avatar) ? getApiUrl(`/api/avatars/${encodeURIComponent(users[c.user].avatar)}`) : null;
            avatarHtml = avatarFile ? `<img src="${avatarFile}" alt="${displayName}"/>` : initials(displayName);
          }

          div.innerHTML = `<div class="avatar">${avatarHtml}</div><div><div class="name">${displayName}</div><div class="meta">${c.messages} messages</div></div>`;
          div.onclick = () => selectConversation(c.id, c.name);
          list.appendChild(div);
        });
    } else {
      // Search through message content
      currentSearchTerm = q;
      const results = await searchMessages(q);
      if (results.length === 0) {
        list.innerHTML = '<div class="no-results">No messages found</div>';
        return;
      }
      
      results.slice(0, 50).forEach(result => { // Limit to 50 results for performance
        const div = document.createElement('div');
        div.className = 'search-result';
        const author = userIdToName[result.message.user] || result.message.user || 'unknown';
        const avatarFile = (users[result.message.user] && users[result.message.user].avatar) ? getApiUrl(`/api/avatars/${encodeURIComponent(users[result.message.user].avatar)}`) : null;
        const avatarHtml = avatarFile ? `<img src="${avatarFile}" alt="${author}" style="width:32px;height:32px;border-radius:4px;object-fit:cover;"/>` : initials(author);
        
        const messageText = result.message.text || '';
        const highlightedText = highlightSearchTerm(messageText, q);
        
        div.innerHTML = `
          <div class="avatar" style="margin-right:8px;">${avatarHtml}</div>
          <div style="flex:1;">
            <div class="result-header">
              <span class="author" style="font-weight:bold;">${author}</span>
              <span class="conv-name" style="color:#666;margin-left:8px;">#${prettifyMpdmName(result.conversation.name)}</span>
              <span class="time" style="color:#888;margin-left:8px;font-size:0.8em;">${timeFromTs(result.message.ts)}</span>
            </div>
            <div class="message-preview" style="margin-top:2px;">${highlightedText}</div>
          </div>
        `;
        div.onclick = () => selectConversationAndMessage(result.conversation.id, result.conversation.name, result.message.ts);
        list.appendChild(div);
      });
    }
  }

  function highlightSearchTerm(text, searchTerm) {
    if (!text || !searchTerm) return escapeHtml(text || '');
    const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escapeHtml(text).replace(regex, '<mark>$1</mark>');
  }

  function highlightSearchInText(text, searchTerm) {
    if (!text || !searchTerm) return text;
    const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, '<mark>$1</mark>');
  }

  function highlightSearchInRenderedText(renderedHtml, searchTerm) {
    if (!renderedHtml || !searchTerm) return renderedHtml;
    const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return renderedHtml.replace(regex, '<mark>$1</mark>');
  }

  async function searchMessages(query) {
    const results = [];
    
    // Load all conversations if not already loaded
    for (const conv of conversations) {
      if (!loadedConversations[conv.id]) {
        try {
          loadedConversations[conv.id] = await fetchConversation(conv.id);
        } catch (e) {
          console.warn(`Failed to load conversation ${conv.id}:`, e);
          continue;
        }
      }
      
      const convData = loadedConversations[conv.id];
      if (!convData || !convData.messages) continue;
      
      // Search through messages in this conversation
      for (const message of convData.messages) {
        if (message.text && message.text.toLowerCase().includes(query)) {
          results.push({
            conversation: { id: conv.id, name: conv.name },
            message: message
          });
        }
      }
    }
    
    // Sort by timestamp (newest first)
    results.sort((a, b) => Number(b.message.ts) - Number(a.message.ts));
    return results;
  }

  async function selectConversationAndMessage(id, name, messageTs) {
    activeId = id;
    if (!loadedConversations[id]) {
      loadedConversations[id] = await fetchConversation(id);
    }
    currentConversation = loadedConversations[id];
    renderMessages(currentConversation, false);
    
    // Scroll to the specific message
    setTimeout(() => {
      const messageEl = el(`[data-ts="${messageTs}"]`);
      if (messageEl) {
        messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
  }

  function renderMessages(conv, preserveAnchor=false) {
    const channelName = conv.channel.name ||
                       (conv.channel.user ? (userIdToName[conv.channel.user] || conv.channel.user) : null) ||
                       conv.channel.id;
    el('#conv-title').textContent = prettifyMpdmName(channelName.replace(/_/g, ' '));
    const box = el('#messages');
    let anchorTs = null;
    let anchorOffset = 0;
    if (preserveAnchor && box.children.length > 0) {
      const scrollTop = box.scrollTop;
      let found = null;
      for (const child of Array.from(box.children)) {
        const top = child.offsetTop;
        const bottom = top + child.offsetHeight;
        if (bottom > scrollTop) { found = child; break; }
      }
      if (found) {
        anchorTs = found.getAttribute('data-ts');
        anchorOffset = scrollTop - found.offsetTop;
      }
    }
    box.innerHTML = '';
    const msgs = (conv.messages || []).slice().sort((a,b) => sortNewestFirst ? (Number(b.ts) - Number(a.ts)) : (Number(a.ts) - Number(b.ts)));
    msgs.forEach(m => {
      const author = userIdToName[m.user] || m.user || 'unknown';
      const avatarFile = (users[m.user] && users[m.user].avatar) ? getApiUrl(`/api/avatars/${encodeURIComponent(users[m.user].avatar)}`) : null;
      const item = document.createElement('div');
      item.className = 'message';
      item.setAttribute('data-ts', String(m.ts));
      const isMe = (m.user && m.user === meId);
      item.innerHTML = `
        <div class="avatar">${avatarFile ? `<img src="${avatarFile}" alt="${author}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;"/>` : initials(author)}</div>
        <div class="bubble${isMe ? ' me' : ''}">
          <div><span class="author">${author}</span><span class="time">${timeFromTs(m.ts)}</span></div>
          <div class="text">${highlightSearchInRenderedText(renderSlackText(applyEmojis(m.text || '')), currentSearchTerm)}</div>
          ${attachmentsHtml(conv, m)}
        </div>
      `;
      box.appendChild(item);
    });
    if (anchorTs) {
      const target = Array.from(box.children).find(el => el.getAttribute('data-ts') === anchorTs);
      if (target) {
        box.scrollTop = target.offsetTop + anchorOffset;
      } else {
        box.scrollTop = 0;
      }
    } else {
      box.scrollTop = 0; // default top
    }
  }

  function attachmentsHtml(conv, m) {
    if (!Array.isArray(m.files) || m.files.length === 0) return '';
    const convDir = `${(conv.channel.name || conv.channel.user || conv.channel.id).replace(/[^a-zA-Z0-9-_\.]/g, '_')}__${conv.channel.id}`;
    const items = m.files.map(f => {
      const filename = `${f.id}_${(f.name || '').replace(/[^a-zA-Z0-9-_\.]/g,'_')}`;
      const href = getApiUrl(`/api/files/${encodeURIComponent(convDir)}/${encodeURIComponent(filename)}`);
      return `<a class="file" href="${href}" target="_blank" rel="noopener">${f.name || f.id}</a>`;
    }).join('');
    return `<div class="attachments">${items}</div>`;
  }

  async function selectConversation(id, name) {
    activeId = id;
    renderList();
    
    // Use cached conversation if available
    if (!loadedConversations[id]) {
      loadedConversations[id] = await fetchConversation(id);
    }
    const conv = loadedConversations[id];
    
    // Lazy build user map from message authors
    const authors = new Set(conv.messages.map(m => m.user).filter(Boolean));
    await ensureUsersLoaded(authors);
    currentConversation = conv;
    renderMessages(currentConversation, false);
  }

  async function ensureUsersLoaded(ids) {
    // Nothing dynamic here; we derive from messages and me
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderSlackText(text) {
    if (!text) return '';
    const anchors = [];
    const codeBlocks = [];
    // Handle fenced code blocks first: ```lang?\n...```
    let t = String(text);
    t = t.replace(/```([a-zA-Z0-9_+\-]+)?\n?([\s\S]*?)```/g, (m, lang, code) => {
      const html = `<pre class=\"code\"><code>${escapeHtml(code.trim())}</code></pre>`;
      const idx = codeBlocks.push(html) - 1;
      return `__CODE${idx}__`;
    });
    // Replace Slack-style <url|label> and <url>, allow accidental double '<<'
    t = t.replace(/<<?(https?:\/\/[^>|\s]+)\|([^>]+)>/g, (m, url, label) => {
      const idx = anchors.push(`<a href=\"${escapeHtml(url)}\" target=\"_blank\" rel=\"noopener\">${escapeHtml(label)}</a>`) - 1;
      return `__LINK${idx}__`;
    });
    t = t.replace(/<<?(https?:\/\/[^>\s]+)>/g, (m, url) => {
      const idx = anchors.push(`<a href=\"${escapeHtml(url)}\" target=\"_blank\" rel=\"noopener\">${escapeHtml(url)}</a>`) - 1;
      return `__LINK${idx}__`;
    });
    // Escape the rest
    t = escapeHtml(t);
    // Auto-link bare URLs (outside code blocks)
    t = t.replace(/(https?:\/\/[^\s<]+[^\s<\.)])/g, (m) => `<a href=\"${m}\" target=\"_blank\" rel=\"noopener\">${m}</a>`);
    // Restore anchors and code blocks
    t = t.replace(/__LINK(\d+)__/g, (m, n) => anchors[Number(n)] || m);
    t = t.replace(/__CODE(\d+)__/g, (m, n) => codeBlocks[Number(n)] || m);
    return t;
  }

  async function loadWorkspaceData() {
    try {
      const [sumRes, usersRes, emojisRes, whoamiRes] = await Promise.all([
        fetch(getApiUrl('/api/summary')),
        fetch(getApiUrl('/api/users')),
        fetch(getApiUrl('/api/emojis')),
        fetch(getApiUrl('/api/whoami')),
      ]);
      const sumData = await sumRes.json();
      const usersData = await usersRes.json();
      const emojisData = await emojisRes.json();
      const whoamiData = await whoamiRes.json();
      
      conversations = sumData.summary || [];
      users = {};
      userIdToName = {};
      for (const u of (usersData.users || [])) {
        users[u.id] = u;
        if (u.name) userIdToName[u.id] = u.name;
      }
      emojiMap = buildEmojiMap(emojisData);
      
      // Update title with team name from whoami.json
      if (whoamiData && whoamiData.team) {
        el('#app-title').textContent = `Slack Archive - ${whoamiData.team}`;
      }
      meId = whoamiData && whoamiData.user_id ? whoamiData.user_id : null;
      
      // Clear loaded conversations when switching workspaces
      loadedConversations = {};
      renderList();
    } catch (e) {
      console.error('Error loading workspace data:', e);
    }
  }

  async function setupWorkspaceSelector() {
    try {
      workspaceInfo = await fetchWorkspaces();
      const selector = el('#workspace-selector');
      const select = el('#workspace-select');
      
      if (workspaceInfo.multiWorkspace && workspaceInfo.workspaces.length > 1) {
        selector.style.display = 'block';
        select.innerHTML = workspaceInfo.workspaces.map(ws => 
          `<option value="${ws.id}">${ws.name}</option>`
        ).join('');
        
        // Set workspace from URL or use default
        const urlWorkspace = getWorkspaceFromUrl();
        const validWorkspace = urlWorkspace && workspaceInfo.workspaces.find(w => w.id === urlWorkspace);
        currentWorkspace = validWorkspace ? urlWorkspace : workspaceInfo.default;
        select.value = currentWorkspace;
        updateUrl(currentWorkspace);
        
        select.addEventListener('change', async () => {
          currentWorkspace = select.value;
          updateUrl(currentWorkspace);
          await loadWorkspaceData();
        });
      } else if (workspaceInfo.workspaces.length === 1) {
        // Single workspace, set it as current but don't show selector
        const urlWorkspace = getWorkspaceFromUrl();
        const validWorkspace = urlWorkspace && workspaceInfo.workspaces.find(w => w.id === urlWorkspace);
        currentWorkspace = validWorkspace ? urlWorkspace : workspaceInfo.workspaces[0].id;
        updateUrl(currentWorkspace);
      }
    } catch (e) {
      console.error('Error setting up workspace selector:', e);
    }
  }

  async function init() {
    try {
      await setupWorkspaceSelector();
      await loadWorkspaceData();
      el('#search').addEventListener('input', () => {
        const searchInput = el('#search');
        const clearBtn = el('#clear-search');
        
        // Show/hide clear button based on input content
        if (searchInput.value.trim()) {
          clearBtn.classList.add('show');
        } else {
          clearBtn.classList.remove('show');
        }
        
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(async () => {
          await renderList();
        }, 300);
      });
      el('#clear-search').addEventListener('click', () => {
        el('#search').value = '';
        el('#clear-search').classList.remove('show');
        currentSearchTerm = null;
        renderList();
      });
      el('#toggle-sort').addEventListener('click', () => {
        sortNewestFirst = !sortNewestFirst;
        const btn = el('#toggle-sort');
        btn.textContent = sortNewestFirst ? '↑ Newest' : '↓ Oldest';
        if (currentConversation) {
          renderMessages(currentConversation, true);
        }
      });
    } catch (e) {
      console.error(e);
    }
  }

  function buildEmojiMap(emojisData) {
    const map = {};
    const list = (emojisData && emojisData.emojis) || [];
    for (const e of list) {
      if (e.type === 'image' && e.file) map[e.name] = { type: 'image', url: getApiUrl(`/api/emoji/${encodeURIComponent(e.file)}`) };
      if (e.type === 'alias' && e.alias) map[e.name] = { type: 'alias', alias: e.alias };
    }
    // Common unicode shortcodes fallback
    const unicode = {
      joy: '😂',
      thumbs_up: '👍',
      thumbsup: '👍',
      heart: '❤️',
      smile: '😄',
      grinning: '😀',
      wink: '😉',
      cry: '😢',
      sob: '😭',
      tada: '🎉',
      fire: '🔥',
      // Additional common Slack emojis
      '+1': '👍',
      '-1': '👎',
      laughing: '😆',
      blush: '😊',
      smiley: '😃',
      relaxed: '☺️',
      smirk: '😏',
      heart_eyes: '😍',
      kissing_heart: '😘',
      kissing_closed_eyes: '😚',
      flushed: '😳',
      relieved: '😌',
      satisfied: '😆',
      grin: '😁',
      stuck_out_tongue: '😛',
      stuck_out_tongue_winking_eye: '😜',
      stuck_out_tongue_closed_eyes: '😝',
      disappointed: '😞',
      worried: '😟',
      angry: '😠',
      rage: '😡',
      pensive: '😔',
      confused: '😕',
      persevere: '😣',
      confounded: '😖',
      tired_face: '😫',
      weary: '😩',
      triumph: '😤',
      sleepy: '😪',
      yum: '😋',
      mask: '😷',
      sunglasses: '😎',
      dizzy_face: '😵',
      imp: '👿',
      smiling_imp: '😈',
      neutral_face: '😐',
      no_mouth: '😶',
      innocent: '😇',
      alien: '👽',
      yellow_heart: '💛',
      blue_heart: '💙',
      purple_heart: '💜',
      green_heart: '💚',
      broken_heart: '💔',
      heartbeat: '💓',
      heartpulse: '💗',
      two_hearts: '💕',
      revolving_hearts: '💞',
      cupid: '💘',
      sparkling_heart: '💖',
      sparkles: '✨',
      star: '⭐',
      star2: '🌟',
      dizzy: '💫',
      boom: '💥',
      collision: '💥',
      anger: '💢',
      exclamation: '❗',
      question: '❓',
      grey_exclamation: '❕',
      grey_question: '❔',
      zzz: '💤',
      dash: '💨',
      sweat_drops: '💦',
      notes: '🎶',
      musical_note: '🎵',
      clap: '👏',
      wave: '👋',
      '+1': '👍',
      '-1': '👎',
      facepunch: '👊',
      fist: '✊',
      v: '✌️',
      ok_hand: '👌',
      point_left: '👈',
      point_right: '👉',
      point_up: '☝️',
      point_up_2: '👆',
      point_down: '👇',
      raised_hand: '✋',
      // More face emojis
      slightly_smiling_face: '🙂',
      upside_down_face: '🙃',
      melting_face: '🫠',
      winking_face: '😉',
      smiling_face_with_3_hearts: '🥰',
      face_with_hand_over_mouth: '🤭',
      shushing_face: '🤫',
      thinking_face: '🤔',
      face_with_raised_eyebrow: '🤨',
      neutral_face: '😐',
      expressionless: '😑',
      face_without_mouth: '😶',
      face_in_clouds: '😶‍🌫️',
      smirking_face: '😏',
      unamused: '😒',
      face_with_rolling_eyes: '🙄',
      grimacing: '😬',
      face_exhaling: '😮‍💨',
      lying_face: '🤥',
      relieved: '😌',
      sleepy: '😪',
      drooling_face: '🤤',
      sleeping: '😴',
      face_with_medical_mask: '😷',
      face_with_thermometer: '🤒',
      face_with_head_bandage: '🤕',
      nauseated_face: '🤢',
      face_vomiting: '🤮',
      sneezing_face: '🤧',
      hot_face: '🥵',
      cold_face: '🥶',
      woozy_face: '🥴',
      dizzy_face: '😵',
      face_with_spiral_eyes: '😵‍💫',
      exploding_head: '🤯',
      cowboy_hat_face: '🤠',
      partying_face: '🥳',
      disguised_face: '🥸',
      face_with_monocle: '🧐',
      nerd_face: '🤓',
      face_with_tongue: '😛',
      money_mouth_face: '🤑',
      shushing: '🤫',
      hugging_face: '🤗',
      saluting_face: '🫡',
      // Common objects and symbols
      thumbsup: '👍',
      thumbsdown: '👎',
      ok: '👌',
      peace: '✌️',
      love_you_gesture: '🤟',
      call_me_hand: '🤙',
      point_left: '👈',
      point_right: '👉',
      point_up: '👆',
      point_down: '👇',
      raised_hands: '🙌',
      pray: '🙏',
      handshake: '🤝',
      nail_care: '💅',
      muscle: '💪',
      // Food emojis
      coffee: '☕',
      tea: '🍵',
      beer: '🍺',
      beers: '🍻',
      wine_glass: '🍷',
      cocktail: '🍸',
      pizza: '🍕',
      hamburger: '🍔',
      fries: '🍟',
      cake: '🍰',
      cookie: '🍪',
      doughnut: '🍩',
      ice_cream: '🍦',
      // Animals
      dog: '🐶',
      cat: '🐱',
      mouse: '🐭',
      hamster: '🐹',
      rabbit: '🐰',
      fox_face: '🦊',
      bear: '🐻',
      panda_face: '🐼',
      tiger: '🐯',
      lion_face: '🦁',
      unicorn_face: '🦄',
      // More commonly used emojis
      sweat_smile: '😅',
      rofl: '🤣',
      joy_cat: '😹',
      smiling_face_with_tear: '🥲',
      pleading_face: '🥺',
      face_with_open_mouth: '😮',
      hushed: '😯',
      astonished: '😲',
      frowning: '😦',
      anguished: '😧',
      fearful: '😨',
      cold_sweat: '😰',
      disappointed_relieved: '😥',
      sob: '😭',
      scream: '😱',
      confounded: '😖',
      persevere: '😣',
      disappointed: '😞',
      sweat: '😓',
      weary: '😩',
      tired_face: '😫',
      yawning_face: '🥱',
      steam_from_nose: '😤',
      pouting_face: '😡',
      smiling_face_with_horns: '😈',
      skull: '💀',
      skull_and_crossbones: '☠️',
      clown_face: '🤡',
      ghost: '👻',
      alien: '👽',
      robot_face: '🤖',
      smiley_cat: '😺',
      smile_cat: '😸',
      heart_eyes_cat: '😻',
      kissing_cat: '😽',
      scream_cat: '🙀',
      crying_cat_face: '😿',
      pouting_cat: '😾'
    };
    for (const k in unicode) map[k] = map[k] || { type: 'unicode', char: unicode[k] };
    return map;
  }

  function applyEmojis(text) {
    if (!text) return text;
    return text.replace(/:([a-zA-Z0-9_+\-]+):/g, (m, nameRaw) => {
      let name = nameRaw;
      let seen = new Set();
      while (emojiMap[name] && emojiMap[name].type === 'alias' && !seen.has(name)) {
        seen.add(name);
        name = emojiMap[name].alias;
      }
      const meta = emojiMap[name];
      if (!meta) return m;
      if (meta.type === 'unicode') return meta.char;
      if (meta.type === 'image' && meta.url) return `<img alt=":${name}:" src="${meta.url}" style="height:1.2em;vertical-align:-0.2em"/>`;
      return m;
    });
  }

  // Handle browser back/forward buttons
  window.addEventListener('popstate', async () => {
    const urlWorkspace = getWorkspaceFromUrl();
    if (workspaceInfo && urlWorkspace !== currentWorkspace) {
      const validWorkspace = urlWorkspace && workspaceInfo.workspaces.find(w => w.id === urlWorkspace);
      if (validWorkspace || (!urlWorkspace && workspaceInfo.workspaces.length > 0)) {
        currentWorkspace = validWorkspace ? urlWorkspace : workspaceInfo.default;
        
        // Update selector if it exists
        const select = document.getElementById('workspace-select');
        if (select) {
          select.value = currentWorkspace;
        }
        
        await loadWorkspaceData();
      }
    }
  });

  init();
})();


