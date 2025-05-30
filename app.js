class FractalNode {
  constructor(id, level = 0, capacity = 100, trust = 0) {
    this.id = id;
    this.level = level; // 0: user, 1: post, 2: evaluation
    this.capacity = capacity;
    this.trust = trust;
    this.connections = new Set();
    this.data_cache = new Map(); // { postId: { content, signature, likes, dislikes, comments, author, level } }
    this.rtcConnections = new Map();
    this.db = null;
    this.keyPair = null;
    this.publicKeyStr = null;
    this.publicKeyCache = new Map();
    this.ws = null;
    this.postCount = 0;
    this.banUntil = 0;
    this.draftPosts = new Map();
    this.subNodes = new Map();
    this.isAuthenticated = false;
    this.emojiList = null;
  }

  async init() {
    try {
      await this.loadEmojiList();
      await this.initDB();
      await this.loadPostCount();
      this.updatePostLimitUI();
      this.connectToSignalServer();
      await this.loadPosts();
      this.setupEventListeners();
      this.startHeartbeat();
    } catch (error) {
      this.updateModalError(`Ошибка инициализации: ${error.message}`);
      console.error('Ошибка инициализации:', error);
    }
  }

  async loadEmojiList() {
    try {
      const response = await fetch('/emoji.json');
      if (!response.ok) {
        throw new Error(`Не удалось загрузить emoji.json: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();

      // Подсчёт количества эмодзи для каждого status
      const statusCounts = {};
      Object.entries(data).forEach(([emoji, meta]) => {
        const status = meta.status;
        if (!statusCounts[status]) {
          statusCounts[status] = 0;
        }
        statusCounts[status]++;
      });

      // Выводим количество эмодзи для каждого status
      console.log('Количество эмодзи по status:', statusCounts);

      // Выбираем status (временно оставим status: 2, но после анализа выберем другой)
      const selectedStatus = 2; // Заменим после анализа
      this.emojiList = Object.keys(data).filter(emoji => data[emoji].status === selectedStatus);
      console.log(`Загруженные эмодзи с status: ${selectedStatus}:`, this.emojiList);
      if (this.emojiList.length < 12) {
        throw new Error(`Недостаточно эмодзи с status: ${selectedStatus} в emoji.json (нужно минимум 12)`);
      }
    } catch (error) {
      this.updateModalError(`Ошибка загрузки эмодзи: ${error.message}`);
      console.error('Ошибка загрузки emoji.json:', error);
      throw error;
    }
  }

  async initDB() {
    return new Promise((resolve) => {
      const request = indexedDB.open('FractalDB', 4);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('posts')) {
          db.createObjectStore('posts', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('keys')) {
          db.createObjectStore('keys', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
    });
  }

  async login(seedPhrase) {
    try {
      if (!this.emojiList) {
        throw new Error('Список эмодзи не загружен');
      }
      const emojis = seedPhrase.match(/[\p{Emoji}]/gu) || [];
      if (emojis.length !== 12 || emojis.some(e => !this.emojiList.includes(e))) {
        throw new Error('Seed-фраза должна состоять из 12 эмодзи из emoji.json');
      }

      const encoder = new TextEncoder();
      const seedData = encoder.encode(seedPhrase);
      const seedHash = await crypto.subtle.digest('SHA-256', seedData);
      const seedId = Array.from(new Uint8Array(seedHash)).map(b => b.toString(16).padStart(2, '0')).join('');

      const existingKeys = await this.loadKeys(seedId);
      if (existingKeys) {
        this.keyPair = existingKeys;
        this.publicKeyStr = await this.exportPublicKey(this.keyPair.publicKey);
        this.id = seedId;
        this.isAuthenticated = true;
        this.updateAuthStatus('Авторизован');
        this.enablePosting();
        this.closeModal();
        return;
      }

      this.keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify']
      );
      this.publicKeyStr = await this.exportPublicKey(this.keyPair.publicKey);
      this.id = seedId;
      await this.saveKeys(seedId, this.keyPair);
      this.isAuthenticated = true;
      this.updateAuthStatus('Авторизован');
      this.enablePosting();
      this.closeModal();
    } catch (error) {
      this.updateModalError(`Ошибка: ${error.message}`);
      console.error('Ошибка входа:', error);
    }
  }

  async createAccount() {
    try {
      if (!this.emojiList) {
        throw new Error('Список эмодзи не загружен');
      }
      const seedPhrase = Array.from({ length: 12 }, () => 
        this.emojiList[Math.floor(Math.random() * this.emojiList.length)]
      ).join('');
      document.getElementById('new-seed').value = seedPhrase;
      await this.login(seedPhrase);
    } catch (error) {
      this.updateModalError(`Ошибка при создании аккаунта: ${error.message}`);
      console.error('Ошибка создания аккаунта:', error);
    }
  }

  async exportPublicKey(publicKey) {
    const exported = await crypto.subtle.exportKey('raw', publicKey);
    return Array.from(new Uint8Array(exported)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async saveKeys(id, keyPair) {
    const tx = this.db.transaction(['keys'], 'readwrite');
    const store = tx.objectStore('keys');
    await store.put({ id, publicKey: await this.exportPublicKey(keyPair.publicKey) });
  }

  async loadKeys(id) {
    const tx = this.db.transaction(['keys'], 'readonly');
    const store = tx.objectStore('keys');
    const request = store.get(id);
    return new Promise((resolve) => {
      request.onsuccess = () => {
        const result = request.result;
        if (result) {
          resolve({
            publicKey: crypto.subtle.importKey(
              'raw',
              new Uint8Array(result.publicKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16))),
              { name: 'ECDSA', namedCurve: 'P-256' },
              true,
              ['verify']
            ),
          });
        } else {
          resolve(null);
        }
      };
      request.onerror = () => resolve(null);
    });
  }

  connectToSignalServer() {
    this.ws = new WebSocket(`wss://server-by7n.onrender.com/${this.id}`);
    this.ws.onopen = () => console.log('Connected to signal server');
    this.ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'offer') {
        await this.handleOffer(data);
      } else if (data.type === 'answer') {
        await this.handleAnswer(data);
      } else if (data.type === 'candidate') {
        await this.handleCandidate(data);
      }
    };
    this.ws.onclose = () => {
      console.log('Signal server disconnected, reconnecting...');
      setTimeout(() => this.connectToSignalServer(), 5000);
    };
  }

  async connectToPeer(peerId) {
    if (this.connections.has(peerId) || peerId === this.id) return;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.rtcConnections.set(peerId, pc);

    const channel = pc.createDataChannel('posts');
    channel.onmessage = (event) => this.handleMessage(event.data);
    channel.onopen = () => {
      this.connections.add(peerId);
      console.log(`Connected to ${peerId}`);
      this.syncPostsWithPeer(peerId);
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.ws.send(JSON.stringify({ type: 'candidate', target: peerId, candidate, sender: this.id }));
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.ws.send(JSON.stringify({ type: 'offer', target: peerId, offer, sender: this.id }));
  }

  async handleOffer({ sender, offer }) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.rtcConnections.set(sender, pc);

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.onmessage = (event) => this.handleMessage(event.data);
      channel.onopen = () => {
        this.connections.add(sender);
        console.log(`Connected to ${sender}`);
        this.syncPostsWithPeer(sender);
      };
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.ws.send(JSON.stringify({ type: 'candidate', target: sender, candidate, sender: this.id }));
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.ws.send(JSON.stringify({ type: 'answer', target: sender, answer, sender: this.id }));
  }

  async handleAnswer({ sender, answer }) {
    const pc = this.rtcConnections.get(sender);
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  async handleCandidate({ sender, candidate }) {
    const pc = this.rtcConnections.get(sender);
    if (pc && candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  async handleMessage(data) {
    const msg = JSON.parse(data);
    if (msg.type === 'post') {
      if (await this.verifySignature(msg.post)) {
        this.data_cache.set(msg.post.id, msg.post);
        await this.savePost(msg.post);
        this.renderPosts();
      }
    } else if (msg.type === 'like' || msg.type === 'dislike') {
      await this.handleEvaluation(msg);
    } else if (msg.type === 'sync') {
      await this.handleSync(msg);
    }
  }

  async verifySignature(post) {
    try {
      const { content, signature, author } = post;
      if (!content || !signature || !author) {
        throw new Error('Некорректные данные поста');
      }

      let publicKey = this.publicKeyCache.get(author);
      if (!publicKey) {
        const keyData = new Uint8Array(author.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        publicKey = await crypto.subtle.importKey(
          'raw',
          keyData,
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['verify']
        );
        this.publicKeyCache.set(author, publicKey);
      }

      const encoder = new TextEncoder();
      const data = encoder.encode(content);
      const sigBytes = new Uint8Array(signature.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        sigBytes,
        data
      );
    } catch (e) {
      console.error('Ошибка проверки подписи:', e);
      return false;
    }
  }

  async postMessage(content, isDraft = false) {
    if (!this.isAuthenticated) {
      alert('Пожалуйста, авторизуйтесь');
      return;
    }
    if (this.postCount >= 3) {
      alert('Достигнут лимит в 3 поста');
      return;
    }
    if (Date.now() < this.banUntil) {
      alert(`Вы забанены до ${new Date(this.banUntil).toLocaleTimeString()}`);
      return;
    }

    const id = Math.random().toString(36).slice(2);
    const signature = await this.signMessage(content);
    const post = {
      id,
      content,
      signature,
      author: this.publicKeyStr,
      likes: 0,
      dislikes: 0,
      comments: [],
      level: 1,
      violationCount: 0,
      isDraft
    };
    if (!isDraft) {
      this.data_cache.set(id, post);
      await this.savePost(post);
      this.postCount++;
      await this.savePostCount();
      this.updatePostLimitUI();
      this.broadcast({ type: 'post', post });
    } else {
      this.draftPosts.set(id, post);
    }
    this.renderPosts();
  }

  async signMessage(content) {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      this.keyPair.privateKey,
      data
    );
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async savePost(post) {
    const tx = this.db.transaction(['posts'], 'readwrite');
    const store = tx.objectStore('posts');
    await store.put(post);
  }

  async loadPosts() {
    const tx = this.db.transaction(['posts'], 'readonly');
    const store = tx.objectStore('posts');
    const request = store.getAll();
    const posts = await new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve([]);
    });
    posts.forEach(post => {
      if (!post.isDraft) {
        this.data_cache.set(post.id, post);
      } else {
        this.draftPosts.set(post.id, post);
      }
    });
    this.renderPosts();
  }

  async savePostCount() {
    const tx = this.db.transaction(['meta'], 'readwrite');
    const store = tx.objectStore('meta');
    await store.put({ key: 'postCount', value: this.postCount });
  }

  async loadPostCount() {
    const tx = this.db.transaction(['meta'], 'readonly');
    const store = tx.objectStore('meta');
    const request = store.get('postCount');
    const result = await new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
    this.postCount = result?.value || 0;
  }

  updatePostLimitUI() {
    document.getElementById('post-limit').textContent = `Осталось постов: ${3 - this.postCount}`;
    document.getElementById('post-btn').disabled = !this.isAuthenticated || this.postCount >= 3 || Date.now() < this.banUntil;
  }

  updateAuthStatus(message) {
    document.getElementById('auth-status').textContent = message;
  }

  updateModalError(message) {
    document.getElementById('modal-error').textContent = message;
  }

  enablePosting() {
    document.getElementById('post-input').disabled = false;
    document.getElementById('post-btn').disabled = this.postCount >= 3 || Date.now() < this.banUntil;
  }

  closeModal() {
    document.getElementById('auth-modal').style.display = 'none';
  }

  async handleEvaluation({ type, postId, sender }) {
    const post = this.data_cache.get(postId);
    if (!post) return;

    if (type === 'like') {
      post.likes++;
      this.trust += 0.1;
    } else if (type === 'dislike') {
      post.dislikes++;
      if (post.dislikes >= 5) {
        post.violationCount++;
        if (post.author === this.publicKeyStr) {
          post.isDraft = true;
          this.draftPosts.set(postId, { ...post, note: 'Нарушены правила' });
          this.data_cache.delete(postId);
          if (post.violationCount >= 3) {
            this.banUntil = Date.now() + 60 * 1000;
            this.updatePostLimitUI();
          }
        } else {
          this.data_cache.delete(postId);
        }
        await this.savePost(post);
      }
    }
    await this.savePost(post);
    this.broadcast({ type: 'post', post });
    this.renderPosts();
  }

  async editPost(postId, newContent) {
    const post = this.draftPosts.get(postId) || this.data_cache.get(postId);
    if (!post || post.author !== this.publicKeyStr) return;
    post.content = newContent;
    post.signature = await this.signMessage(newContent);
    post.isDraft = false;
    this.draftPosts.delete(postId);
    this.data_cache.set(postId, post);
    await this.savePost(post);
    this.broadcast({ type: 'post', post });
    this.renderPosts();
  }

  async syncPostsWithPeer(peerId) {
    const posts = Array.from(this.data_cache.values());
    for (const post of posts) {
      if (!post.isDraft) {
        this.sendToPeer(peerId, { type: 'sync', post });
      }
    }
  }

  async handleSync({ post }) {
    if (await this.verifySignature(post) && !post.isDraft) {
      this.data_cache.set(post.id, post);
      await this.savePost(post);
      this.renderPosts();
    }
  }

  broadcast(message) {
    for (const peerId of this.connections) {
      this.sendToPeer(peerId, message);
    }
  }

  sendToPeer(peerId, message) {
    const pc = this.rtcConnections.get(peerId);
    const channel = pc?.getSenders()?.[0]?.channel;
    if (channel?.readyState === 'open') {
      channel.send(JSON.stringify(message));
    }
  }

  renderPosts() {
    const postsDiv = document.getElementById('posts');
    postsDiv.innerHTML = '';
    for (const [id, post] of this.data_cache) {
      if (post.isDraft) continue;
      const postDiv = document.createElement('div');
      postDiv.className = 'post';
      postDiv.innerHTML = `
        <div class="post-header">Автор: ${post.author.slice(0, 8)}... (Уровень: ${post.level})</div>
        <div>${post.content}</div>
        <div class="post-actions">
          <button onclick="node.handleEvaluation({ type: 'like', postId: '${id}', sender: node.id })">Лайк (${post.likes})</button>
          <button onclick="node.handleEvaluation({ type: 'dislike', postId: '${id}', sender: node.id })">Дизлайк (${post.dislikes})</button>
          <button onclick="node.promptEdit('${id}')" ${post.author !== this.publicKeyStr ? 'disabled' : ''}>Редактировать</button>
        </div>
      `;
      postsDiv.appendChild(postDiv);
    }
    for (const [id, post] of this.draftPosts) {
      if (post.author === this.publicKeyStr) {
        const postDiv = document.createElement('div');
        postDiv.className = 'post';
        postDiv.innerHTML = `
          <div class="post-header">Черновик: ${post.note || ''}</div>
          <div>${post.content}</div>
          <div class="post-actions">
            <button onclick="node.promptEdit('${id}')">Редактировать</button>
          </div>
        `;
        postsDiv.appendChild(postDiv);
      }
    }
  }

  startHeartbeat() {
    setInterval(() => {
      if (this.connections.size < 3) {
        const peerId = `peer-${Math.random().toString(36).slice(2)}`;
        this.connectToPeer(peerId);
      }
      this.optimizeConnections();
    }, 10000);
  }

  optimizeConnections() {
    const sortedPeers = Array.from(this.connections).sort((a, b) => {
      const trustA = this.rtcConnections.get(a)?.trust || 0;
      const trustB = this.rtcConnections.get(b)?.trust || 0;
      return trustB - trustA;
    });
    if (sortedPeers.length > 3) {
      const toRemove = sortedPeers.slice(3);
      toRemove.forEach(peerId => {
        this.rtcConnections.get(peerId)?.close();
        this.rtcConnections.delete(peerId);
        this.connections.delete(peerId);
      });
    }
  }

  setupEventListeners() {
    const modal = document.getElementById('auth-modal');
    const loginBtn = document.getElementById('login-btn');
    const closeBtn = document.getElementsByClassName('close')[0];
    const generateSeedBtn = document.getElementById('generate-seed');
    const loginSubmitBtn = document.getElementById('login-submit');

    loginBtn.onclick = () => {
      modal.style.display = 'block';
      document.getElementById('new-seed').value = '';
      document.getElementById('seed-input').value = '';
      document.getElementById('modal-error').textContent = '';
    };

    closeBtn.onclick = () => {
      modal.style.display = 'none';
    };

    window.onclick = (event) => {
      if (event.target === modal) {
        modal.style.display = 'none';
      }
    };

    generateSeedBtn.onclick = () => {
      this.createAccount();
    };

    loginSubmitBtn.onclick = async () => {
      const seedPhrase = document.getElementById('seed-input').value;
      await this.login(seedPhrase);
    };

    document.getElementById('post-btn').addEventListener('click', async () => {
      const content = document.getElementById('post-input').value;
      if (content) {
        await this.postMessage(content);
        document.getElementById('post-input').value = '';
      }
    });

    document.getElementById('search').addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      const postsDiv = document.getElementById('posts');
      postsDiv.innerHTML = '';
      for (const [id, post] of this.data_cache) {
        if (post.isDraft) continue;
        if (post.content.toLowerCase().includes(query)) {
          const postDiv = document.createElement('div');
          postDiv.className = 'post';
          postDiv.innerHTML = `
            <div class="post-header">Автор: ${post.author.slice(0, 8)}... (Уровень: ${post.level})</div>
            <div>${post.content}</div>
            <div class="post-actions">
              <button onclick="node.handleEvaluation({ type: 'like', postId: '${id}', sender: node.id })">Лайк (${post.likes})</button>
              <button onclick="node.handleEvaluation({ type: 'dislike', postId: '${id}', sender: node.id })">Дизлайк (${post.dislikes})</button>
              <button onclick="node.promptEdit('${id}')" ${post.author !== this.publicKeyStr ? 'disabled' : ''}>Редактировать</button>
            </div>
          `;
          postsDiv.appendChild(postDiv);
        }
      }
    });
  }

  promptEdit(postId) {
    const newContent = prompt('Редактировать пост:', this.data_cache.get(postId)?.content || this.draftPosts.get(postId)?.content);
    if (newContent) {
      this.editPost(postId, newContent);
    }
  }
}

const node = new FractalNode(Math.random().toString(36).slice(2));
node.init();

window.node = node;
