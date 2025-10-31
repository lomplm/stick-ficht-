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

    this.turn = 1;
    // cooldowns for local client perspective (actionName -> remaining turns)
    this.myCooldowns = {};
    // local optimistic buffs (for immediate UI feedback)
    this.myBuffs = {};
    // server-visible buffs for player/opponent (host keeps authoritative maps here)
    this.playerBuffs = {};
    this.opponentBuffs = {};
    // attack/item configs (tweak values as desired)
    this.attacksConfig = {
      light: { damage: 12, hit: 0.92 },
      heavy: { damage: 28, hit: 0.65, cooldown: 2 },
      special: { damage: 40, hit: 0.45, cooldown: 5 }
    };
    this.itemsConfig = {
      heal_small: { heal: 18, cooldown: 3 },
      speed_boost: { speed: 0.15, duration: 2, cooldown: 4 }, // raises hit chance
      defense_buff: { defense: 0.5, duration: 2, cooldown: 4 } // reduces incoming damage by 50%
    };
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

  // Helper: can current player use an action (respects cooldowns)
  canUseAction(action) {
    if (!action) return false;
    // Always allow non-special default actions like 'run'/'block'
    if (action === 'block' || action === 'run') return true;
    // Attacks may have cooldown in config
    const attack = this.attacksConfig[action];
    if (attack && attack.cooldown) {
      return !(this.myCooldowns[action] > 0);
    }
    const item = this.itemsConfig[action];
    if (item) {
      return !(this.myCooldowns[action] > 0);
    }
    // default allow (e.g., light attack with no cooldown)
    return !(this.myCooldowns[action] > 0);
  }

  getRemainingCooldown(action) {
    return this.myCooldowns[action] || 0;
  }

  // Local use: mark action as used and set its cooldown
  useActionLocal(action) {
    const attack = this.attacksConfig[action];
    if (attack && attack.cooldown) this.myCooldowns[action] = attack.cooldown;
    const item = this.itemsConfig[action];
    if (item && item.cooldown) this.myCooldowns[action] = item.cooldown;
  }

  // Decrement all local cooldown counters (called after a turn resolved)
  decrementLocalCooldowns() {
    for (const k of Object.keys(this.myCooldowns)) {
      if (this.myCooldowns[k] > 0) this.myCooldowns[k]--;
      if (this.myCooldowns[k] <= 0) delete this.myCooldowns[k];
    }
  }

  submitAction(action) {
    if(this.isOnline) {
      this.submitActionOnline(action);
      return;
    }
    if(this.state !== 'playing') return;
    if(this.playerAction) return; // already chosen
    if (!this.canUseAction(action)) {
      console.log(`Actie '${action}' is nog in cooldown.`);
      return;
    }
    this.playerAction = action;
    console.log(`${this.playerName} chooses ${action}`);
    this.send({ type: 'action', action });
    if(this.isHost) {
      // For local host resolution, mark used action and host will resolve
      this.useActionLocal(action);
      this.tryResolveTurn();
    }
  }

  tryResolveTurn() {
    if(this.isOnline) return; // online resolution handled by host via Firestore
    if(!this.isHost) return;
    if(!this.playerAction || !this.opponentAction) return;
    // Host authoritative resolution
    const beforeP = this.playerHP;
    const beforeO = this.opponentHP;
    this.resolveActions();
    // decrement local cooldowns and advance turn
    this.decrementLocalCooldowns();
    this.turn++;
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
    // Prepare next turn (clear chosen actions)
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
        p1Cooldowns: {}, // cooldown maps
        p2Cooldowns: {},
        p1Buffs: {},    // buff maps (name -> remaining turns)
        p2Buffs: {},
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

    // Host: ensure join robust
    if (this.isHost && data.clientName && this.state !== 'playing') {
      // mirror baseline
      this.opponentName = data.clientName;
      this.playerHP = data.player1HP || 100;
      this.opponentHP = data.player2HP || 100;
      this.playerAction = null;
      this.opponentAction = null;
      try {
        if (data.state !== 'playing' && this.roomDocRef) {
          await this.roomDocRef.update({ state: 'playing', updatedAt: Date.now() });
        }
      } catch (e) { console.warn('Kon room state niet updaten naar playing:', e); }
      this.state = 'playing';
      console.log(`${this.opponentName} joined!`);
      this.drawState();
      return;
    }

    if(!this.isHost) {
      // mirror host-driven state
      const prevState = this.state;
      this.state = data.state;
      this.opponentName = data.hostName || 'Host';
      const prevP = this.playerHP;
      const prevO = this.opponentHP;
      // store previous for animation numbers
      this._prevPlayerHP = prevP;
      this._prevOpponentHP = prevO;
      this.playerHP = data.player2HP || 100;
      this.opponentHP = data.player1HP || 100;
      // Sync client cooldowns & buffs from server
      try {
        this.myCooldowns = JSON.parse(JSON.stringify(data.p2Cooldowns || {}));
        this.myBuffs = JSON.parse(JSON.stringify(data.p2Buffs || {}));
      } catch (_) { this.myCooldowns = {}; this.myBuffs = {}; }
      if (this.state === 'playing' && prevState !== 'playing') {
        this.playerAction = null;
        this.opponentAction = null;
        this.drawState();
      }
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
          // mirror server HP & actions into host
          this.playerHP = data.player1HP;
          this.opponentHP = data.player2HP;
          this.playerAction = p1A;
          this.opponentAction = p2A;

          // load cooldown & buff maps
          const p1Cooldowns = Object.assign({}, data.p1Cooldowns || {});
          const p2Cooldowns = Object.assign({}, data.p2Cooldowns || {});
          const p1Buffs = Object.assign({}, data.p1Buffs || {});
          const p2Buffs = Object.assign({}, data.p2Buffs || {});

          // set host-local buff maps so resolveActions reads them
          this.playerBuffs = JSON.parse(JSON.stringify(p1Buffs));
          this.opponentBuffs = JSON.parse(JSON.stringify(p2Buffs));

          // perform resolution
          const beforeHP1 = data.player1HP;
          const beforeHP2 = data.player2HP;
          this.resolveActions();

          // Decrement cooldowns and buff durations (end of turn)
          const decMap = (map) => {
            const out = {};
            for (const k in map) {
              const v = (map[k] || 0) - 1;
              if (v > 0) out[k] = v;
            }
            return out;
          };
          const nextP1Cooldowns = decMap(p1Cooldowns);
          const nextP2Cooldowns = decMap(p2Cooldowns);
          const nextP1Buffs = decMap(p1Buffs);
          const nextP2Buffs = decMap(p2Buffs);

          // If actions applied generate cooldowns or buffs for next turn
          const applyUsedCooldown = (usedAction, targetCooldownMap) => {
            if (!usedAction) return;
            const aConf = this.attacksConfig[usedAction];
            const iConf = this.itemsConfig[usedAction];
            const cd = (aConf && aConf.cooldown) || (iConf && iConf.cooldown) || 0;
            if (cd && cd > 0) targetCooldownMap[usedAction] = cd + 0; // set after dec
          };
          const applyUsedBuff = (usedAction, targetBuffMap) => {
            if (!usedAction) return;
            const iConf = this.itemsConfig[usedAction];
            if (iConf && iConf.duration) {
              targetBuffMap[usedAction] = iConf.duration + 0;
            }
          };
          applyUsedCooldown(p1A, nextP1Cooldowns);
          applyUsedCooldown(p2A, nextP2Cooldowns);
          applyUsedBuff(p1A, nextP1Buffs);
          applyUsedBuff(p2A, nextP2Buffs);

          // Compose update object
          const next = {
            player1HP: this.playerHP,
            player2HP: this.opponentHP,
            p1Action: '',
            p2Action: '',
            p1Cooldowns: nextP1Cooldowns,
            p2Cooldowns: nextP2Cooldowns,
            p1Buffs: nextP1Buffs,
            p2Buffs: nextP2Buffs,
            turn: (data.turn || 1) + 1,
            updatedAt: Date.now(),
            lastP1Action: p1A,
            lastP2Action: p2A,
            lastResolvedAt: Date.now()
          };
          if(this.playerHP <= 0 || this.opponentHP <= 0) next.state = 'gameover';
          await this.roomDocRef.update(next);

          // clear local chosen actions and sync host-local cooldowns/buffs
          this.playerAction = null;
          this.opponentAction = null;
          this.myCooldowns = JSON.parse(JSON.stringify(nextP1Cooldowns || {}));
          this.playerBuffs = JSON.parse(JSON.stringify(nextP1Buffs || {}));
          this.opponentBuffs = JSON.parse(JSON.stringify(nextP2Buffs || {}));

          // start animation using previous HPs
          this.startActionAnimation(p1A, p2A, beforeHP1, beforeHP2);
        }
      } else {
        // Client: clear local chosen action when host cleared theirs, and sync cooldowns/buffs
        if(!p2A && this.playerAction) this.playerAction = null;
        try {
          this.myCooldowns = JSON.parse(JSON.stringify(data.p2Cooldowns || {}));
          this.myBuffs = JSON.parse(JSON.stringify(data.p2Buffs || {}));
        } catch (_) { this.myCooldowns = {}; this.myBuffs = {}; }

        // animation trigger
        const lrAt = data.lastResolvedAt || 0;
        if (lrAt && lrAt !== this.lastResolvedAtSeen) {
          this.lastResolvedAtSeen = lrAt;
          const lp1 = data.lastP1Action || '';
          const lp2 = data.lastP2Action || '';
          const beforeP2 = this._prevPlayerHP !== undefined ? this._prevPlayerHP : this.playerHP;
          const beforeP1 = this._prevOpponentHP !== undefined ? this._prevOpponentHP : this.opponentHP;
          this.startActionAnimation(lp2, lp1, beforeP2, beforeP1);
          this._prevPlayerHP = undefined;
          this._prevOpponentHP = undefined;
        }
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

    const canActState =
      data.state === 'playing' ||
      (data.state === 'matchmaking' && (!this.isHost || (this.isHost && data.clientName)));
    if (!canActState) return;

    const serverCooldowns = this.isHost ? (data.p1Cooldowns || {}) : (data.p2Cooldowns || {});
    if (serverCooldowns && serverCooldowns[action] > 0) {
      console.log(`Actie '${action}' is nog in cooldown (${serverCooldowns[action]}).`);
      return;
    }
    if(data[field]) return; // already chosen this turn

    await this.roomDocRef.update({ [field]: action, updatedAt: Date.now() });
    console.log(`${this.playerName} chooses ${action}`);

    // reflect locally and optimistic buff effect
    try {
      this.playerAction = action;
      this.useActionLocal(action);
      // optimistic: if item grants buff, set myBuffs locally
      const iConf = this.itemsConfig[action];
      if (iConf && iConf.duration) {
        this.myBuffs[action] = iConf.duration;
      }
    } catch (_) {}
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

  // Enhanced resolution logic to handle multiple attack types and items and buffs
  resolveActions() {
    const pAct = this.playerAction;
    const oAct = this.opponentAction;

    // Helper to check buff presence and config
    const playerHas = (name) => !!(this.playerBuffs && this.playerBuffs[name]);
    const oppHas = (name) => !!(this.opponentBuffs && this.opponentBuffs[name]);

    // apply attack function for player
    const applyPlayerAttack = () => {
      if (!this.attacksConfig[pAct]) return;
      const conf = this.attacksConfig[pAct];
      let hitChance = conf.hit || this.attackHitChance;
      if (playerHas('speed_boost')) hitChance += (this.itemsConfig['speed_boost'].speed || 0);
      const didHit = Math.random() < hitChance;
      if (!didHit) return;
      let dmg = conf.damage || 0;
      if (oppHas('defense_buff')) dmg = Math.ceil(dmg * (1 - (this.itemsConfig['defense_buff'].defense || 0)));
      this.opponentHP -= dmg;
    };
    const applyOpponentAttack = () => {
      if (!this.attacksConfig[oAct]) return;
      const conf = this.attacksConfig[oAct];
      let hitChance = conf.hit || this.attackHitChance;
      if (oppHas('speed_boost')) hitChance += (this.itemsConfig['speed_boost'].speed || 0);
      const didHit = Math.random() < hitChance;
      if (!didHit) return;
      let dmg = conf.damage || 0;
      if (playerHas('defense_buff')) dmg = Math.ceil(dmg * (1 - (this.itemsConfig['defense_buff'].defense || 0)));
      this.playerHP -= dmg;
    };

    // apply attacks
    applyPlayerAttack();
    applyOpponentAttack();

    // items: healing
    if (pAct && this.itemsConfig[pAct] && this.itemsConfig[pAct].heal) {
      this.playerHP += this.itemsConfig[pAct].heal;
    }
    if (oAct && this.itemsConfig[oAct] && this.itemsConfig[oAct].heal) {
      this.opponentHP += this.itemsConfig[oAct].heal;
    }

    // run/evasion: slight extra chance to avoid damage already covered by hitChance adjustments earlier if needed
    // clamp HP
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

