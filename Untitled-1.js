/*
  Simple multiplayer stick-fight game concept for browser-based play.

  Features:
  - Start menu with "Join Game" and "Create Game"
  - Online play against other player
  - Each player is a stick figure in 2D, takes turns choosing actions:
      - Attack, Items, Run, Block
  - Turns are simultaneous; when both players make a choice, actions are resolved
  - Game ends when a player's HP reaches 0
  - Leaderboard with player names and wins

  Core logic skeleton below (pseudo-code with some real JS for structure)
*/

class Game {
  constructor(playerName) {
    this.playerName = playerName;
    this.opponentName = null;
    this.playerHP = 100;
    this.opponentHP = 100;
    this.playerWins = 0;
    this.playerAction = null;
    this.opponentAction = null;
    this.state = 'menu'; // 'menu', 'matchmaking', 'playing', 'gameover'
    // Networking & leaderboard not implemented here (use Firebase, Websockets etc)
    this.loopHandle = null; // interval handle for non-blocking loop
    this.room = null;
    this.isHost = false;
    this.channel = null; // BroadcastChannel for local two-tab play
    this.db = null; // Firestore instance for online play
    this.roomDocRef = null;
    this.roomUnsub = null;
    this.isOnline = false;
    // Combat tuning
    this.attackHitChance = 0.8; // 80% kans dat een aanval raakt
    // Rendering
    this.canvas = null;
    this.ctx = null;
    this.lastPlayerActionDrawn = '';
    this.lastOpponentActionDrawn = '';
    this.animationStartMs = 0;
    this.animationDurationMs = 800;
    this.lastResolvedAtSeen = 0;
    this.animationFrameId = null;
    this.particles = [];
    this.damageNumbers = [];
    // Logging helpers to tonen alleen delta's
    this.lastLoggedPlayerHP = this.playerHP;
    this.lastLoggedOpponentHP = this.opponentHP;
    this.initRenderer();
  }

  // Show start menu
  showMenu() {
    // pseudo-code: Draw "Create Game" and "Join Game" buttons
    // Removed normal local Create/Join; keep only Online options
    // On click -> this.startOnline(db, room, isHost)
    this.state = 'menu';
    console.log("Menu: Host Online / Join Online");
    // UI code here
  }

  // Matchmaking (stub)
  startGame(isHost) {
    this.state = 'matchmaking';
    if(isHost) {
      // Wait for other player to join
      console.log("Waiting for opponent...");
      // pseudo: networking to wait for join
    } else {
      // Join another player
      console.log("Searching for open games...");
      // pseudo: networking to find & join
    }
    // On success:
    this.state = 'playing';
    this.opponentName = "Opponent"; // get from server
    this.mainLoop();
  }

  // Local networking using BroadcastChannel (works across two tabs)
  startNetwork(room, isHost) {
    this.cleanupNetwork();
    this.room = String(room || 'room-1');
    this.isHost = !!isHost;
    this.channel = new BroadcastChannel(`stickfight:${this.room}`);
    this.channel.onmessage = (ev) => this.onMessage(ev.data);

    this.state = 'matchmaking';
    if(this.isHost) {
      console.log(`Room ${this.room} aangemaakt. Wachten op join...`);
    } else {
      console.log(`Join room ${this.room}...`);
      this.send({ type: 'join', name: this.playerName });
    }
  }

  cleanupNetwork() {
    if(this.channel) {
      try { this.channel.close(); } catch(_) {}
    }
    this.channel = null;
    if(this.roomUnsub) {
      try { this.roomUnsub(); } catch(_) {}
    }
    this.roomUnsub = null;
    this.roomDocRef = null;
    this.isOnline = false;
  }

  // Limit UI interactions to only a Back action while hosting online
  lockUIForHosting() {
    try {
      if (typeof document === 'undefined') return;
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'));
      for (const el of buttons) {
        if (el.id === 'btnBack') continue;
        el.setAttribute('disabled', 'true');
        el.classList.add('disabled');
      }
    } catch (_) {}
  }

  unlockUI() {
    try {
      if (typeof document === 'undefined') return;
      const buttons = Array.from(document.querySelectorAll('button.disabled, [role="button"].disabled, input.disabled'));
      for (const el of buttons) {
        el.removeAttribute('disabled');
        el.classList.remove('disabled');
      }
    } catch (_) {}
  }

  attachBackHandler() {
    try {
      if (typeof document === 'undefined') return;
      const backBtn = document.getElementById('btnBack');
      if (backBtn) {
        backBtn.onclick = () => this.onBack();
      }
    } catch (_) {}
  }

  async onBack() {
    // If hosting online, delete the room before navigating back
    if (this.isOnline && this.isHost && this.roomDocRef) {
      try {
        await this.deleteOnlineRoom();
      } catch (e) {
        console.warn('Kon room niet verwijderen:', e);
      }
    }
    this.cleanupNetwork();
    this.unlockUI();
    this.showMenu();
  }

  async deleteOnlineRoom() {
    if (!this.roomDocRef) return;
    try {
      await this.roomDocRef.delete();
      console.log(`Room ${this.room} verwijderd.`);
    } catch (e) {
      // If delete fails (permissions), mark as gameover as fallback
      try {
        await this.roomDocRef.update({ state: 'gameover', updatedAt: Date.now() });
      } catch (_) {}
    }
  }

  send(message) {
    if(this.channel) this.channel.postMessage({ ...message, _from: this.isHost ? 'host' : 'client' });
  }

  onMessage(msg) {
    if(!msg || typeof msg !== 'object') return;
    // Host handles joins
    if(this.isHost && msg.type === 'join' && this.state === 'matchmaking') {
      this.opponentName = msg.name || 'Opponent';
      console.log(`${this.opponentName} joined!`);
      this.state = 'playing';
      this.playerAction = null;
      this.opponentAction = null;
      this.send({ type: 'start', host: this.playerName, opponent: this.opponentName });
      return;
    }

    // Client receives start
    if(!this.isHost && msg.type === 'start' && this.state === 'matchmaking') {
      this.opponentName = msg.host || 'Host';
      this.state = 'playing';
      this.playerAction = null;
      this.opponentAction = null;
      console.log(`Verbonden met ${this.opponentName}.`);
      return;
    }

    // Both sides exchange actions
    if(msg.type === 'action') {
      const fromOpponent = (this.isHost && msg._from === 'client') || (!this.isHost && msg._from === 'host');
      if(fromOpponent) {
        this.opponentAction = msg.action;
        console.log(`Opponent chooses ${this.opponentAction}`);
        // Host resolves when both actions present
        if(this.isHost) this.tryResolveTurn();
      }
      return;
    }

    // Host sends resolved state
    if(msg.type === 'turn_result') {
      if(!this.isHost) {
        this.playerHP = msg.playerHP;
        this.opponentHP = msg.opponentHP;
        this.playerAction = null;
        this.opponentAction = null;
        this.drawState();
        if(this.playerHP <= 0 || this.opponentHP <= 0) {
          this.state = 'gameover';
          this.showGameOver();
        }
      }
      return;
    }
  }

  submitAction(action) {
    if(this.isOnline) {
      this.submitActionOnline(action);
      return;
    }
    if(this.state !== 'playing') return;
    if(this.playerAction) return; // already chosen
    this.playerAction = action;
    console.log(`${this.playerName} chooses ${action}`);
    this.send({ type: 'action', action });
    if(this.isHost) this.tryResolveTurn();
  }

  tryResolveTurn() {
    if(this.isOnline) return; // online resolution handled by host via Firestore
    if(!this.isHost) return;
    if(!this.playerAction || !this.opponentAction) return;
    // Host authoritative resolution
    const beforeP = this.playerHP;
    const beforeO = this.opponentHP;
    this.resolveActions();
    // Log alleen delta's voor host
    const dSelf = this.playerHP - beforeP;
    const dOpp = this.opponentHP - beforeO;
    if (dOpp < 0) console.log(`${this.opponentName || 'Opponent'} verliest ${-dOpp} HP`);
    if (dOpp > 0) console.log(`${this.opponentName || 'Opponent'} krijgt +${dOpp} HP`);
    if (dSelf < 0) console.log(`Jij verliest ${-dSelf} HP`);
    if (dSelf > 0) console.log(`Jij krijgt +${dSelf} HP`);
    this.lastLoggedPlayerHP = this.playerHP;
    this.lastLoggedOpponentHP = this.opponentHP;
    const result = {
      type: 'turn_result',
      playerHP: this.playerHP,
      opponentHP: this.opponentHP
    };
    this.send(result);
    this.startActionAnimation(this.playerAction, this.opponentAction, beforeP, beforeO);
    if(this.playerHP <= 0 || this.opponentHP <= 0) {
      this.state = 'gameover';
      this.showGameOver();
      return;
    }
    // Prepare next turn
    this.playerAction = null;
    this.opponentAction = null;
  }

  // ===== Online (Firestore) =====
  async startOnline(db, room, isHost) {
    this.cleanupNetwork();
    this.db = db;
    this.room = String(room || 'room-1');
    this.isHost = !!isHost;
    this.isOnline = true;
    this.state = 'matchmaking';

    // Ensure Back button works in this mode
    this.attachBackHandler();

    // Helper to check/allocate a free room ID for host
    const ensureHostRoom = async () => {
      const baseId = `stickfight_${this.room}`;
      let candidateId = baseId;
      let tries = 0;
      while (tries < 50) {
        const ref = this.db.collection('rooms').doc(candidateId);
        const snap = await ref.get();
        if (!snap.exists) {
          this.roomDocRef = ref;
          return candidateId; // free
        }
        const data = snap.data() || {};
        if (data.state === 'gameover') {
          this.roomDocRef = ref;
          return candidateId; // reuse finished room
        }
        // Taken and active -> try next suffix
        tries += 1;
        const suffix = tries + 1; // start from -2
        candidateId = `${baseId}-${suffix}`;
      }
      // fallback random
      const rand = Math.random().toString(36).slice(2, 7);
      candidateId = `${baseId}-${rand}`;
      this.roomDocRef = this.db.collection('rooms').doc(candidateId);
      return candidateId;
    };

    if(this.isHost) {
      const allocatedDocId = await ensureHostRoom();
      // Update visible room code if auto-changed
      const allocatedRoom = allocatedDocId.replace(/^stickfight_/, '');
      if (allocatedRoom !== this.room) {
        console.log(`Gekozen room is bezet. Nieuwe room toegewezen: ${allocatedRoom}`);
        this.room = allocatedRoom;
        try {
          if (typeof document !== 'undefined') {
            const input = document.getElementById('room');
            if (input) input.value = this.room;
          }
        } catch (_) {}
      }

      await this.roomDocRef.set({
        state: 'matchmaking',
        hostName: this.playerName,
        clientName: '',
        player1HP: 100,
        player2HP: 100,
        p1Action: '',
        p2Action: '',
        turn: 1,
        updatedAt: Date.now()
      });
      console.log(`Online room ${this.room} aangemaakt. Wachten op speler...`);
    } else {
      const roomId = `stickfight_${this.room}`;
      this.roomDocRef = this.db.collection('rooms').doc(roomId);
      const snap = await this.roomDocRef.get();
      if(!snap.exists) {
        console.log('Room bestaat niet. Laat de host eerst aanmaken.');
        return;
      }
      await this.roomDocRef.update({ clientName: this.playerName, updatedAt: Date.now() });
      console.log(`Gejoined: ${this.room}`);
    }

    // Subscribe to room updates
    this.roomUnsub = this.roomDocRef.onSnapshot((doc) => this.onRoomUpdate(doc.data()));
  }

  async onRoomUpdate(data) {
    if(!data) return;
    // Transition to playing when both names set
    if(this.isHost && data.clientName && data.state === 'matchmaking') {
      await this.roomDocRef.update({ state: 'playing', updatedAt: Date.now() });
      this.state = 'playing';
      this.opponentName = data.clientName;
      this.playerHP = data.player1HP;
      this.opponentHP = data.player2HP;
      console.log(`${this.opponentName} joined!`);
      return;
    }

    if(!this.isHost) {
      // mirror host-driven state
      this.state = data.state;
      this.opponentName = data.hostName || 'Host';
      const prevP = this.playerHP;
      const prevO = this.opponentHP;
      // Store HP before update for damage tracking
      this._prevPlayerHP = prevP;
      this._prevOpponentHP = prevO;
      this.playerHP = data.player2HP;
      this.opponentHP = data.player1HP;
      // Indien state al playing is en HP's gewijzigd, log deltas éénmalig bij verandering
      if (this.playerHP !== prevP || this.opponentHP !== prevO) {
        const dSelf = this.playerHP - (this.lastLoggedPlayerHP ?? prevP);
        const dOpp = this.opponentHP - (this.lastLoggedOpponentHP ?? prevO);
        if (dOpp < 0) console.log(`${this.opponentName || 'Opponent'} verliest ${-dOpp} HP`);
        if (dOpp > 0) console.log(`${this.opponentName || 'Opponent'} krijgt +${dOpp} HP`);
        if (dSelf < 0) console.log(`Jij verliest ${-dSelf} HP`);
        if (dSelf > 0) console.log(`Jij krijgt +${dSelf} HP`);
        this.lastLoggedPlayerHP = this.playerHP;
        this.lastLoggedOpponentHP = this.opponentHP;
      }
    }

    // When playing, check for resolution
    if(data.state === 'playing') {
      const p1A = data.p1Action || '';
      const p2A = data.p2Action || '';
      if(this.isHost) {
        // Host resolves when both actions present
        if(p1A && p2A) {
          // apply on host authoritative state
          this.playerHP = data.player1HP;
          this.opponentHP = data.player2HP;
          this.playerAction = p1A;
          this.opponentAction = p2A;
          this.resolveActions();
          const next = {
            player1HP: this.playerHP,
            player2HP: this.opponentHP,
            p1Action: '',
            p2Action: '',
            turn: (data.turn || 1) + 1,
            updatedAt: Date.now(),
            lastP1Action: p1A,
            lastP2Action: p2A,
            lastResolvedAt: Date.now()
          };
          // game over check
          if(this.playerHP <= 0 || this.opponentHP <= 0) {
            next.state = 'gameover';
          }
          await this.roomDocRef.update(next);
          // reset local chosen actions
          const beforeHP1 = data.player1HP;
          const beforeHP2 = data.player2HP;
          this.playerAction = null;
          this.opponentAction = null;
          this.startActionAnimation(p1A, p2A, beforeHP1, beforeHP2);
        }
      } else {
        // Client clears its local chosen action once host resolved
        if(!p2A && this.playerAction) {
          this.playerAction = null;
        }
        // Trigger animation when host reports a resolved turn
        const lrAt = data.lastResolvedAt || 0;
        if (lrAt && lrAt !== this.lastResolvedAtSeen) {
          this.lastResolvedAtSeen = lrAt;
          const lp1 = data.lastP1Action || '';
          const lp2 = data.lastP2Action || '';
          // Use stored HP values before update for damage numbers
          const beforeP2 = this._prevPlayerHP !== undefined ? this._prevPlayerHP : this.playerHP;
          const beforeP1 = this._prevOpponentHP !== undefined ? this._prevOpponentHP : this.opponentHP;
          // client perspective: our action first param
          this.startActionAnimation(lp2, lp1, beforeP2, beforeP1);
          // Clear stored values after use
          this._prevPlayerHP = undefined;
          this._prevOpponentHP = undefined;
        }
        // Always redraw to keep HP labels in sync
        this.drawState();
      }
    }

    if(data.state === 'gameover') {
      this.state = 'gameover';
      this.drawState();
      this.showGameOver();
    }
  }

  async submitActionOnline(action) {
    if(!this.isOnline || !this.roomDocRef) return;
    const field = this.isHost ? 'p1Action' : 'p2Action';
    const snap = await this.roomDocRef.get();
    if(!snap.exists) return;
    const data = snap.data();
    // Sta client toe om alvast te kiezen in matchmaking; host lost op zodra beide acties en state door host naar 'playing' gaat
    if(data.state !== 'playing' && !(data.state === 'matchmaking' && !this.isHost)) return;
    if(data[field]) return; // already chosen this turn
    await this.roomDocRef.update({ [field]: action, updatedAt: Date.now() });
    console.log(`${this.playerName} chooses ${action}`);
  }

  // Loop remains unused in networked simultaneous turn mode
  mainLoop() {}

  // Show action choices to player, return selected action (replace with UI code)
  promptAction() {
    // ("attack", "block", "item", "run")
    const actions = ['attack','block','item','run'];
    // pseudo: present UI for selection
    const chosenAction = actions[Math.floor(Math.random() * actions.length)];
    console.log(`${this.playerName} chooses ${chosenAction}`);
    return chosenAction;
  }

  randomAction() {
    const actions = ['attack','block','item','run'];
    return actions[Math.floor(Math.random()*actions.length)];
  }

  // Action resolution logic
  resolveActions() {
    // Simple example logic met miss-kans
    const playerAttackEligible = this.playerAction === 'attack' && this.opponentAction !== 'block';
    const opponentAttackEligible = this.opponentAction === 'attack' && this.playerAction !== 'block';

    if (playerAttackEligible) {
      const hit = Math.random() < this.attackHitChance;
      if (hit) {
        this.opponentHP -= 20;
      } else {
        console.log(`${this.playerName}'s attack mist!`);
      }
    }

    if (opponentAttackEligible) {
      const hit = Math.random() < this.attackHitChance;
      if (hit) {
        this.playerHP -= 20;
      } else {
        console.log(`Opponent's attack mist!`);
      }
    }
    if(this.playerAction === 'item') {
      this.playerHP += 10; // heal
    }
    if(this.opponentAction === 'item') {
      this.opponentHP += 10;
    }
    // Clamp HP
    this.playerHP = Math.min(100, Math.max(0, this.playerHP));
    this.opponentHP = Math.min(100, Math.max(0, this.opponentHP));
  }

  drawState() {
    this.drawScene();
  }

  showGameOver() {
    if(this.playerHP <= 0 && this.opponentHP <= 0) {
      console.log("Draw!");
    } else if(this.playerHP <= 0) {
      console.log("You lose!");
    } else {
      console.log("You win!");
      this.playerWins++;
      // pseudo: leaderboard logic here
    }
    // Host: show options to play again or stop (delete room)
    try {
      if (typeof document !== 'undefined' && this.isOnline && this.isHost) {
        if (typeof window.__showEndButtons === 'function') {
          window.__showEndButtons(true);
        }
      }
    } catch (_) {}
  }

  async resetOnlineGame() {
    if (!this.isOnline || !this.isHost || !this.roomDocRef) return;
    try {
      await this.roomDocRef.update({
        state: 'matchmaking',
        player1HP: 100,
        player2HP: 100,
        p1Action: '',
        p2Action: '',
        turn: 1,
        lastP1Action: '',
        lastP2Action: '',
        lastResolvedAt: 0,
        updatedAt: Date.now()
      });
      this.state = 'matchmaking';
      this.playerHP = 100;
      this.opponentHP = 100;
      this.playerAction = null;
      this.opponentAction = null;
      this.drawState();
    } catch (e) {
      console.log('Reset faalde:', e && e.message ? e.message : e);
    }
  }

  async stopOnlineGame() {
    if (!this.isOnline || !this.isHost) return;
    try {
      await this.deleteOnlineRoom();
    } catch (_) {}
    this.cleanupNetwork();
    this.showMenu();
  }

  initRenderer() {
    try {
      if (typeof document === 'undefined') return;
      this.canvas = document.getElementById('gameCanvas');
      if (!this.canvas) return;
      this.ctx = this.canvas.getContext('2d');
      this.drawScene();
    } catch (_) {}
  }

  startActionAnimation(playerAction, opponentAction, prevPlayerHP = null, prevOpponentHP = null) {
    // Cancel any existing animation
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    
    this.lastPlayerActionDrawn = playerAction || '';
    this.lastOpponentActionDrawn = opponentAction || '';
    this.animationStartMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    
    // Add particles for attacks
    if (playerAction === 'attack') {
      this.addParticles(140, 250, '#ef4444');
    }
    if (opponentAction === 'attack') {
      this.addParticles(560, 250, '#ef4444');
    }
    
    // Use provided HP values or fall back to current HP (for cases where damage wasn't tracked)
    const beforePlayerHP = prevPlayerHP !== null ? prevPlayerHP : this.playerHP;
    const beforeOpponentHP = prevOpponentHP !== null ? prevOpponentHP : this.opponentHP;
    
    const step = () => {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const elapsed = now - this.animationStartMs;
      const progress = Math.min(1, elapsed / this.animationDurationMs);
      
      if (progress < 1) {
        // Update particles and damage numbers
        this.updateParticles();
        this.updateDamageNumbers();
        
        this.drawScene();
        this.animationFrameId = requestAnimationFrame(step);
      } else {
        // End of animation: clear last actions and draw final state
        this.lastPlayerActionDrawn = '';
        this.lastOpponentActionDrawn = '';
        this.animationStartMs = 0;
        this.particles = [];
        this.damageNumbers = [];
        this.animationFrameId = null;
        this.drawState();
      }
    };
    
    // Show damage numbers after resolution
    const playerDamage = beforePlayerHP - this.playerHP;
    const opponentDamage = beforeOpponentHP - this.opponentHP;
    
    if (playerDamage > 0) {
      this.addDamageNumber(140, 180, playerDamage, true);
    }
    if (opponentDamage > 0) {
      this.addDamageNumber(560, 180, opponentDamage, false);
    }
    
    if (typeof requestAnimationFrame !== 'undefined') {
      this.animationFrameId = requestAnimationFrame(step);
    } else {
      step();
    }
  }
  
  addParticles(x, y, color) {
    for (let i = 0; i < 8; i++) {
      this.particles.push({
        x: x,
        y: y,
        vx: (Math.random() - 0.5) * 4,
        vy: (Math.random() - 0.5) * 4,
        life: 1,
        decay: 0.02,
        color: color,
        size: Math.random() * 4 + 2
      });
    }
  }
  
  updateParticles() {
    this.particles = this.particles.filter(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.decay;
      p.vy += 0.2; // gravity
      return p.life > 0;
    });
  }
  
  addDamageNumber(x, y, damage, isPlayer) {
    this.damageNumbers.push({
      x: x,
      y: y,
      value: damage,
      life: 1,
      decay: 0.015,
      isPlayer: isPlayer,
      offsetY: 0
    });
  }
  
  updateDamageNumbers() {
    this.damageNumbers = this.damageNumbers.filter(d => {
      d.life -= d.decay;
      d.offsetY -= 2;
      return d.life > 0;
    });
  }

  drawScene() {
    if (!this.ctx || !this.canvas) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Sky gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, '#e0e7ff');
    gradient.addColorStop(1, '#f7f9fc');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    // Ground with shadow
    ctx.fillStyle = '#d1d5db';
    ctx.fillRect(0, h - 40, w, 40);
    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(20, h - 40);
    ctx.lineTo(w - 20, h - 40);
    ctx.stroke();

    // HP bars background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.fillRect(40, 45, 180, 20);
    ctx.fillRect(w - 220, 45, 180, 20);

    // HP bars
    const playerHPPercent = Math.max(0, this.playerHP / 100);
    const opponentHPPercent = Math.max(0, this.opponentHP / 100);
    
    ctx.fillStyle = playerHPPercent > 0.5 ? '#10b981' : playerHPPercent > 0.25 ? '#f59e0b' : '#ef4444';
    ctx.fillRect(42, 47, 176 * playerHPPercent, 16);
    
    ctx.fillStyle = opponentHPPercent > 0.5 ? '#10b981' : opponentHPPercent > 0.25 ? '#f59e0b' : '#ef4444';
    ctx.fillRect(w - 218, 47, 176 * opponentHPPercent, 16);

    // HP bar borders
    ctx.strokeStyle = '#4b5563';
    ctx.lineWidth = 1;
    ctx.strokeRect(40, 45, 180, 20);
    ctx.strokeRect(w - 220, 45, 180, 20);

    // Names and HP text
    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 14px system-ui, Arial';
    const you = this.playerName || 'You';
    const opp = this.opponentName || 'Opponent';
    ctx.fillText(`${you}`, 40, 28);
    ctx.fillText(`${opp}`, w - 220, 28);
    ctx.font = '12px system-ui, Arial';
    ctx.fillText(`${this.playerHP} HP`, 42, 78);
    ctx.fillText(`${this.opponentHP} HP`, w - 218, 78);

    // Stick figures positions with smooth animation
    const baseY = h - 40;
    let leftX = 140; let rightX = w - 140;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const elapsed = this.animationStartMs ? (now - this.animationStartMs) : 0;
    const t = Math.min(1, Math.max(0, elapsed / this.animationDurationMs));
    
    // Improved easing function (ease-out-cubic)
    const ease = (p) => 1 - Math.pow(1 - p, 3);
    const e = ease(t);
    
    // Bounce effect for attacks
    const bounce = (p) => {
      if (p < 0.5) return 4 * p * p;
      return 1 - Math.pow(-2 * p + 2, 2) / 2;
    };
    const b = bounce(t);

    // Attack: lunge forward with bounce; Run: step back
    const pA = this.lastPlayerActionDrawn || this.playerAction;
    const oA = this.lastOpponentActionDrawn || this.opponentAction;
    if (pA === 'attack') leftX += 25 * e - 8 * (1 - b);
    if (oA === 'attack') rightX -= 25 * e + 8 * (1 - b);
    if (pA === 'run') leftX -= 15 * e;
    if (oA === 'run') rightX += 15 * e;

    this.drawStickFigure(leftX, baseY, 'right', pA, e);
    this.drawStickFigure(rightX, baseY, 'left', oA, e);
    
    // Draw particles
    this.drawParticles();
    
    // Draw damage numbers
    this.drawDamageNumbers();
  }
  
  drawParticles() {
    if (!this.ctx || this.particles.length === 0) return;
    const ctx = this.ctx;
    this.particles.forEach(p => {
      ctx.save();
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }
  
  drawDamageNumbers() {
    if (!this.ctx || this.damageNumbers.length === 0) return;
    const ctx = this.ctx;
    this.damageNumbers.forEach(d => {
      ctx.save();
      ctx.globalAlpha = d.life;
      ctx.fillStyle = d.isPlayer ? '#ef4444' : '#3b82f6';
      ctx.font = `bold ${16 + (1 - d.life) * 8}px system-ui, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText(`-${d.value}`, d.x, d.y + d.offsetY);
      ctx.restore();
    });
  }

  drawStickFigure(x, baseY, facing, action, animProgress = 0) {
    const ctx = this.ctx; if (!ctx) return;
    ctx.save();
    
    // body proportions
    const headR = 18; const body = 45; const leg = 32; const arm = 26;
    const yHead = baseY - (leg + body + headR*2);
    const centerY = yHead + headR*2;
    const dir = facing === 'right' ? 1 : -1;

    // Calculate animation offsets for limbs
    let armOffset = 0;
    let legSpread = 12;
    let bodyLean = 0;
    
    if (action === 'attack') {
      armOffset = dir * 25 * animProgress;
      bodyLean = dir * 3 * animProgress;
    } else if (action === 'block') {
      armOffset = dir * -15 * animProgress;
    } else if (action === 'run') {
      legSpread = 12 + 8 * Math.sin(animProgress * Math.PI * 4);
      bodyLean = dir * 2 * animProgress;
    }

    // Head with face
    ctx.strokeStyle = '#1f2937'; 
    ctx.lineWidth = 2.5;
    ctx.beginPath(); 
    ctx.arc(x + bodyLean, yHead + headR, headR, 0, Math.PI * 2); 
    ctx.stroke();
    
    // Face expression
    ctx.fillStyle = '#1f2937';
    ctx.beginPath();
    ctx.arc(x + bodyLean - 4, yHead + headR - 2, 2, 0, Math.PI * 2);
    ctx.arc(x + bodyLean + 4, yHead + headR - 2, 2, 0, Math.PI * 2);
    ctx.fill();
    
    if (action === 'attack') {
      // Angry expression
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + bodyLean - 6, yHead + headR + 4);
      ctx.lineTo(x + bodyLean, yHead + headR + 6);
      ctx.lineTo(x + bodyLean + 6, yHead + headR + 4);
      ctx.stroke();
    }
    
    // Body with lean
    ctx.strokeStyle = '#1f2937'; 
    ctx.lineWidth = 2.5;
    ctx.beginPath(); 
    ctx.moveTo(x + bodyLean, centerY); 
    ctx.lineTo(x + bodyLean, centerY + body); 
    ctx.stroke();
    
    // Arms with animation
    const armY = centerY + 10;
    ctx.beginPath(); 
    ctx.moveTo(x + bodyLean, armY); 
    ctx.lineTo(x + bodyLean - (arm - armOffset) * (dir === 1 ? -1 : 1), armY + 12); 
    ctx.stroke();
    
    ctx.beginPath(); 
    ctx.moveTo(x + bodyLean, armY); 
    ctx.lineTo(x + bodyLean + (arm + armOffset) * (dir === 1 ? 1 : -1), armY + 12); 
    ctx.stroke();
    
    // Legs with animation
    const legY = centerY + body;
    ctx.beginPath(); 
    ctx.moveTo(x + bodyLean, legY); 
    ctx.lineTo(x + bodyLean - legSpread, legY + leg); 
    ctx.stroke();
    
    ctx.beginPath(); 
    ctx.moveTo(x + bodyLean, legY); 
    ctx.lineTo(x + bodyLean + legSpread, legY + leg); 
    ctx.stroke();

    // Action visuals with better effects
    if (action === 'attack') {
      // Attack slash with glow
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#ef4444';
      ctx.strokeStyle = '#ef4444'; 
      ctx.lineWidth = 4;
      ctx.beginPath();
      const attackX = x + bodyLean + dir * (arm + 2 + armOffset);
      const attackY = armY + 12;
      ctx.moveTo(attackX, attackY);
      ctx.lineTo(attackX + dir * 45, attackY - 15);
      ctx.lineTo(attackX + dir * 50, attackY - 20);
      ctx.stroke();
      ctx.shadowBlur = 0;
      
      // Multiple slashes for effect
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(attackX, attackY);
      ctx.lineTo(attackX + dir * 40, attackY - 12);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (action === 'block') {
      // Shield effect
      ctx.strokeStyle = '#2563eb'; 
      ctx.lineWidth = 4;
      ctx.fillStyle = 'rgba(37, 99, 235, 0.2)';
      ctx.beginPath();
      const shieldX = x + bodyLean + dir * (arm + 10);
      ctx.arc(shieldX, armY + 12, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      
      // Shield highlight
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(shieldX - dir * 3, armY + 9, 8, 0, Math.PI * 2);
      ctx.stroke();
    } else if (action === 'item') {
      // Healing glow
      ctx.shadowBlur = 15;
      ctx.shadowColor = '#10b981';
      ctx.fillStyle = '#10b981';
      ctx.beginPath();
      ctx.arc(x + bodyLean, yHead - 8, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      
      // Plus sign
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + bodyLean, yHead - 13);
      ctx.lineTo(x + bodyLean, yHead - 3);
      ctx.moveTo(x + bodyLean - 5, yHead - 8);
      ctx.lineTo(x + bodyLean + 5, yHead - 8);
      ctx.stroke();
    } else if (action === 'run') {
      // Dust clouds
      ctx.fillStyle = 'rgba(156, 163, 175, 0.6)';
      ctx.beginPath();
      ctx.arc(x + bodyLean - dir * 25, legY + leg - 5, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + bodyLean - dir * 20, legY + leg - 2, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    
    ctx.restore();
  }
}

// Usage:
// const myGame = new Game('YourName');
// myGame.showMenu();

