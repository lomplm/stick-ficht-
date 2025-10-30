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
  }

  // Show start menu
  showMenu() {
    // pseudo-code: Draw "Create Game" and "Join Game" buttons
    // On click -> this.startGame(isHost)
    this.state = 'menu';
    console.log("Menu: Create Game / Join Game");
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
    this.drawState();
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

    const roomId = `stickfight_${this.room}`;
    this.roomDocRef = this.db.collection('rooms').doc(roomId);

    if(this.isHost) {
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
            updatedAt: Date.now()
          };
          // game over check
          if(this.playerHP <= 0 || this.opponentHP <= 0) {
            next.state = 'gameover';
          }
          await this.roomDocRef.update(next);
          // reset local chosen actions
          this.playerAction = null;
          this.opponentAction = null;
          this.drawState();
        }
      } else {
        // Client clears its local chosen action once host resolved
        if(!p2A && this.playerAction) {
          this.playerAction = null;
        }
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
    if(data.state !== 'playing') return;
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
    // Simple example logic
    if(this.playerAction === 'attack' && this.opponentAction !== 'block') {
      this.opponentHP -= 20;
    }
    if(this.opponentAction === 'attack' && this.playerAction !== 'block') {
      this.playerHP -= 20;
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
    // pseudo: Draw stick figures and HP bars
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
}

// Usage:
// const myGame = new Game('YourName');
// myGame.showMenu();

