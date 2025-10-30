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
    this.animationDurationMs = 500;
    this.lastResolvedAtSeen = 0;
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
    this.resolveActions();
    const result = {
      type: 'turn_result',
      playerHP: this.playerHP,
      opponentHP: this.opponentHP
    };
    this.send(result);
    this.startActionAnimation(this.playerAction, this.opponentAction);
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
      this.playerHP = data.player2HP;
      this.opponentHP = data.player1HP;
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
          this.playerAction = null;
          this.opponentAction = null;
          this.startActionAnimation(p1A, p2A);
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
          // client perspective: our action first param
          this.startActionAnimation(lp2, lp1);
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
    console.log(`You: ${this.playerHP} HP vs Opponent: ${this.opponentHP} HP`);
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
    // Option to play again
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

  startActionAnimation(playerAction, opponentAction) {
    this.lastPlayerActionDrawn = playerAction || '';
    this.lastOpponentActionDrawn = opponentAction || '';
    this.animationStartMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const step = () => {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const elapsed = now - this.animationStartMs;
      if (elapsed <= this.animationDurationMs) {
        this.drawScene();
        if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(step);
      } else {
        // End of animation: clear last actions and draw final state
        this.lastPlayerActionDrawn = '';
        this.lastOpponentActionDrawn = '';
        this.animationStartMs = 0;
        this.drawState();
      }
    };
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(step); else step();
  }

  drawScene() {
    if (!this.ctx || !this.canvas) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Ground
    ctx.strokeStyle = '#c8d1e3';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(20, h - 40);
    ctx.lineTo(w - 20, h - 40);
    ctx.stroke();

    // Names and HP
    ctx.fillStyle = '#111';
    ctx.font = '14px system-ui, Arial';
    const you = this.playerName || 'You';
    const opp = this.opponentName || 'Opponent';
    ctx.fillText(`${you} — ${this.playerHP} HP`, 40, 30);
    ctx.fillText(`${opp} — ${this.opponentHP} HP`, w - 220, 30);

    // Stick figures positions with simple animation offsets
    const baseY = h - 40;
    let leftX = 140; let rightX = w - 140;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const elapsed = this.animationStartMs ? (now - this.animationStartMs) : 0;
    const t = Math.min(1, Math.max(0, elapsed / this.animationDurationMs));
    const ease = (p) => (1 - Math.cos(Math.PI * p)) / 2; // easeInOut
    const e = ease(t);

    // Attack: lunge forward; Run: step back
    const pA = this.lastPlayerActionDrawn || this.playerAction;
    const oA = this.lastOpponentActionDrawn || this.opponentAction;
    if (pA === 'attack') leftX += 18 * e;
    if (oA === 'attack') rightX -= 18 * e;
    if (pA === 'run') leftX -= 12 * e;
    if (oA === 'run') rightX += 12 * e;

    this.drawStickFigure(leftX, baseY, 'right', pA);
    this.drawStickFigure(rightX, baseY, 'left', oA);
  }

  drawStickFigure(x, baseY, facing, action) {
    const ctx = this.ctx; if (!ctx) return;
    // body proportions
    const headR = 16; const body = 40; const leg = 28; const arm = 22;
    const yHead = baseY - (leg + body + headR*2);
    const centerY = yHead + headR*2;
    const dir = facing === 'right' ? 1 : -1;

    // Head
    ctx.strokeStyle = '#222'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, yHead + headR, headR, 0, Math.PI * 2); ctx.stroke();
    // Body
    ctx.beginPath(); ctx.moveTo(x, centerY); ctx.lineTo(x, centerY + body); ctx.stroke();
    // Arms
    const armY = centerY + 8;
    ctx.beginPath(); ctx.moveTo(x, armY); ctx.lineTo(x - arm, armY + 10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, armY); ctx.lineTo(x + arm, armY + 10); ctx.stroke();
    // Legs
    const legY = centerY + body;
    ctx.beginPath(); ctx.moveTo(x, legY); ctx.lineTo(x - 12, legY + leg); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, legY); ctx.lineTo(x + 12, legY + leg); ctx.stroke();

    // Action visuals
    if (action === 'attack') {
      ctx.strokeStyle = '#e11d48'; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x + dir * (arm + 2), armY + 10);
      ctx.lineTo(x + dir * (arm + 40), armY);
      ctx.stroke();
    } else if (action === 'block') {
      ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x + dir * (arm + 8), armY + 10, 10, 0, Math.PI * 2);
      ctx.stroke();
    } else if (action === 'item') {
      ctx.fillStyle = '#16a34a';
      ctx.fillRect(x - 6, yHead - 10, 12, 12);
    } else if (action === 'run') {
      ctx.fillStyle = '#9ca3af';
      ctx.beginPath();
      ctx.arc(x - dir * 18, legY + leg - 6, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// Usage:
// const myGame = new Game('YourName');
// myGame.showMenu();

