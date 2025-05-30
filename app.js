// FractalNode реализация
class FractalNode {
  constructor(id, level = 2, capacity = 100, trust = 0) {
    this.id = id;
    this.level = level; // 0-глобальный, 1-региональный, 2-локальный
    this.capacity = capacity;
    this.trust = trust;
    this.connections = new Set();
    this.data_cache = new Map();
    this.rtcConnections = new Map();
    this.db = null;
    this.keyPair = null;
    this.ws = null;
  }

  async init() {
    await this.initDB();
    await this.generateKeyPair();
    this.connectToSignalServer();
    this.loadPosts();
  }

  async initDB() {
    return new Promise((resolve) => {
      const request = indexedDB.open('FractalDB', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('posts', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
    });
  }

  async generateKeyPair() {
    this.keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
  }

  connectToSignalServer() {
    this.ws = new WebSocket(`wss://your-signal-server.onrender.com/${this.id}`);
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
  }

  async connectToPeer(peerId) {
    if (this.connections.has(peerId)) return;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.rtcConnections.set(peerId, pc);

    const channel = pc.createDataChannel('posts');
    channel.onmessage = (event) => this.handleMessage(event.data);
    channel.onopen = () => {
      this.connections.add(peerId);
      console.log(`Connected to ${peerId}`);
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
    const { id, content, signature } = JSON.parse(data);
    // Проверка подписи (упрощенно)
    this.data_cache.set(id, { content, signature });
    await this.savePost({ id, content, signature });
    this.renderPosts();
  }

  async postMessage(content) {
    const id = Math.random().toString(36).slice(2);
    const signature = await this.signMessage(content);
    const message = { id, content, signature };
    this.data_cache.set(id, message);
    await this.savePost(message);

    for (const peerId of this.connections) {
      const pc = this.rtcConnections.get(peerId);
      const channel = pc.getSenders()[0]?.channel;
      if (channel?.readyState === 'open') {
        channel.send(JSON.stringify(message));
      }
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
    const posts = await store.getAll();
    posts.forEach(post => this.data_cache.set(post.id, post));
    this.renderPosts();
  }

  renderPosts() {
    const postsDiv = document.getElementById('posts');
    postsDiv.innerHTML = '';
    for (const [id, { content, signature }] of this.data_cache) {
      const postDiv = document.createElement('div');
      postDiv.className = 'post';
      postDiv.textContent = content;
      postsDiv.appendChild(postDiv);
    }
  }
}

// Инициализация узла
const node = new FractalNode(Math.random().toString(36).slice(2));
node.init();

// UI логика
document.getElementById('post-btn').addEventListener('click', async () => {
  const content = document.getElementById('post-input').value;
  if (content) {
    await node.postMessage(content);
    document.getElementById('post-input').value = '';
  }
});

document.getElementById('search').addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase();
  const postsDiv = document.getElementById('posts');
  postsDiv.innerHTML = '';
  for (const [id, { content, signature }] of node.data_cache) {
    if (content.toLowerCase().includes(query)) {
      const postDiv = document.createElement('div');
      postDiv.className = 'post';
      postDiv.textContent = content;
      postsDiv.appendChild(postDiv);
    }
  }
});

document.getElementById('login').addEventListener('click', () => {
  // Упрощенная авторизация (seed-фраза может быть добавлена позже)
  alert('Вход выполнен (упрощенно)');
});

// Подключение к случайному узлу (для теста)
setTimeout(() => node.connectToPeer('test-peer-id'), 1000);
