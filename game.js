// Paper 86 v3.1 - 60-second drift racing game with full physics rework
// Canvas and game state
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

// =============================================================================
// PHYSICS CONSTANTS - Arcade drift model tuned for 60s score attack
// =============================================================================
const PHYSICS = {
    // Speed and acceleration
    ACCELERATION: 0.28,              // Forward acceleration (automatic throttle)
    MAX_SPEED: 6.8,                  // Top speed (clean driving)
    CRUISE_SPEED: 5.2,               // Natural cruising speed
    MIN_SPEED_FOR_STEERING: 0.8,     // Minimum speed to turn
    
    // Steering (speed-sensitive)
    BASE_STEERING_RATE: 0.085,       // Max steering at low speed (rad/frame @ 120Hz)
    MIN_STEERING_RATE: 0.028,        // Min steering at top speed
    STEERING_SPEED_CURVE: 0.65,      // How quickly steering reduces with speed (0-1)
    
    // Grip and lateral damping
    LATERAL_GRIP: 0.86,              // How much lateral velocity is damped per frame (normal)
    DRIFT_REAR_GRIP: 0.38,           // Rear grip multiplier when drifting (causes oversteer)
    DRIFT_FRONT_GRIP: 0.90,          // Front grip stays higher (allows countersteer)
    GRIP_RECOVERY_RATE: 0.12,        // How quickly grip returns after releasing drift
    
    // Drift speed loss
    DRIFT_SPEED_RETENTION: 0.987,    // Speed multiplier per frame while drifting
    CLEAN_DRIFT_THRESHOLD: 0.4,      // Slip angle below this maintains more speed
    MESSY_DRIFT_PENALTY: 0.978,      // Extra speed loss for big slip angles
    
    // Drag and friction
    BASE_DRAG: 0.993,                // Always-on speed decay
    ROLLING_RESISTANCE: 0.002,       // Constant speed loss per frame
    
    // Collision response
    WALL_RESTITUTION: 0.3,           // Bounce factor (0=stick, 1=perfect bounce)
    WALL_SPEED_LOSS: 0.4,            // Speed retention after wall hit
    CONE_HIT_SPEED_LOSS: 0.85,       // Speed retention after hard cone hit
    COLLISION_SHAKE_WALL: 12,        // Screen shake intensity for wall
    COLLISION_SHAKE_CONE: 5,         // Screen shake intensity for cone
    
    // Tire marks (slip-based)
    TIRE_MARK_SLIP_THRESHOLD: 0.15,  // Minimum slip angle to leave marks
    TIRE_MARK_OPACITY_SCALE: 3.2,    // How dark marks get with slip
    TIRE_MARK_SPACING: 0.3,          // Random gate for mark density
    MAX_TIRE_MARKS: 350,
    
    // Drift detection (for sound and stats)
    DRIFT_SLIP_THRESHOLD: 0.18,      // Slip angle to trigger drift sound/stat (reduced for easier triggering)
    DRIFT_MIN_SPEED: 2.0,            // Minimum speed for drift to count (reduced)
    
    // Fixed timestep
    PHYSICS_HZ: 120,                 // Physics update rate (frame-rate independent)
    MAX_FRAME_TIME: 0.1              // Cap for spiral of death
};

// Ghost recording version
const GHOST_VERSION = 2; // Bump when recording format changes

// Game state
let gameState = 'ready'; // 'ready', 'playing', 'ended'
let score = 0;
let bestScore = parseInt(localStorage.getItem('paper86-best') || '0');
let timeLeft = 60;
let combo = 0;
let lastConeTime = 0;
let lastClipTime = 0;
let collisionGraceTime = 2.0; // Grace period after start/restart
let firstRun = !localStorage.getItem('paper86-played');
let screenShake = { x: 0, y: 0, intensity: 0 };
let currentLayout = 0;
let comboDecayWarning = false;

// Daily track and stats
let todayDateString = '';
let dailyBestScore = 0;
let runStats = {
    clips: 0,
    bestCombo: 0,
    driftTime: 0
};

// Audio state
let audioContext = null;
let audioMuted = localStorage.getItem('paper86-muted') === 'true';
let driftOscillator = null;
let driftGain = null;
let driftFilter = null;

// Input state
const keys = {};
let drifting = false;
let touchDrifting = false;
let touchSteerLeft = false;
let touchSteerRight = false;

// Car state
const car = {
    x: 475,
    y: 725,
    vx: 0,
    vy: 0,
    heading: Math.atan2(700 - 750, 350 - 600), // ~-2.944, pointing along track
    speed: 0,
    slipAngle: 0,
    currentGripFactor: 1.0,          // Current grip interpolation (for smooth recovery)
    width: 20,
    height: 36
};

// Fixed timestep accumulator
let physicsAccumulator = 0;
const physicsDt = 1 / PHYSICS.PHYSICS_HZ;

// Camera
const camera = {
    x: 0,
    y: 0
};

// Tire marks
const tireMarks = [];
const MAX_TIRE_MARKS = PHYSICS.MAX_TIRE_MARKS;

// Particles
const particles = [];

// Ghost recording and playback
let ghostRecording = [];
let ghostPlayback = [];
let recordingTimer = 0;
const GHOST_SAMPLE_RATE = 0.1; // Record every 0.1 seconds

// CLIP popups
const clipPopups = [];

// Audio functions
function initAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
}

function playSound(type, comboCount = 0) {
    if (audioMuted || !audioContext) return;
    
    const now = audioContext.currentTime;
    
    if (type === 'clip') {
        // CLIP blip that rises in pitch with combo
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        
        osc.connect(gain);
        gain.connect(audioContext.destination);
        
        const baseFreq = 400 + (comboCount * 50);
        osc.frequency.setValueAtTime(baseFreq, now);
        
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
        
        osc.start(now);
        osc.stop(now + 0.15);
    } else if (type === 'wall') {
        // Wall hit - harsh burst
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        
        osc.connect(gain);
        gain.connect(audioContext.destination);
        
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(100, now);
        osc.frequency.exponentialRampToValueAtTime(50, now + 0.2);
        
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
        
        osc.start(now);
        osc.stop(now + 0.2);
    } else if (type === 'start') {
        // Start cue - rising tone
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        
        osc.connect(gain);
        gain.connect(audioContext.destination);
        
        osc.frequency.setValueAtTime(300, now);
        osc.frequency.exponentialRampToValueAtTime(600, now + 0.3);
        
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
        
        osc.start(now);
        osc.stop(now + 0.3);
    } else if (type === 'end') {
        // End cue - falling tone
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        
        osc.connect(gain);
        gain.connect(audioContext.destination);
        
        osc.frequency.setValueAtTime(600, now);
        osc.frequency.exponentialRampToValueAtTime(200, now + 0.5);
        
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
        
        osc.start(now);
        osc.stop(now + 0.5);
    } else if (type === 'combo-break') {
        // Combo break - descending chirp
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        
        osc.connect(gain);
        gain.connect(audioContext.destination);
        
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(200, now + 0.25);
        
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
        
        osc.start(now);
        osc.stop(now + 0.25);
    }
}

function startDriftSound() {
    if (audioMuted || !audioContext || driftOscillator) return;
    
    const now = audioContext.currentTime;
    
    // Create noise buffer for tire hiss
    const bufferSize = audioContext.sampleRate * 2;
    const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
    }
    
    driftOscillator = audioContext.createBufferSource();
    driftOscillator.buffer = buffer;
    driftOscillator.loop = true;
    
    // Low-pass filter for tire hiss character
    driftFilter = audioContext.createBiquadFilter();
    driftFilter.type = 'lowpass';
    driftFilter.frequency.setValueAtTime(1200, now);
    driftFilter.Q.setValueAtTime(0.5, now);
    
    driftGain = audioContext.createGain();
    
    driftOscillator.connect(driftFilter);
    driftFilter.connect(driftGain);
    driftGain.connect(audioContext.destination);
    
    driftGain.gain.setValueAtTime(0, now);
    driftGain.gain.linearRampToValueAtTime(0.035, now + 0.1);
    
    driftOscillator.start(now);
}

function stopDriftSound() {
    if (!driftOscillator || !audioContext) return;
    
    const now = audioContext.currentTime;
    driftGain.gain.linearRampToValueAtTime(0, now + 0.1);
    
    setTimeout(() => {
        if (driftOscillator) {
            driftOscillator.stop();
            driftOscillator = null;
            driftGain = null;
            driftFilter = null;
        }
    }, 150);
}

function toggleMute() {
    audioMuted = !audioMuted;
    localStorage.setItem('paper86-muted', audioMuted.toString());
    
    if (audioMuted && driftOscillator) {
        stopDriftSound();
    }
    
    // Update mute button
    const muteBtn = document.getElementById('mute-button');
    if (muteBtn) {
        muteBtn.textContent = audioMuted ? '🔇' : '🔊';
    }
}

// Track definition - closed circuit with curves
const trackWidth = 200;
const trackPoints = [
    { x: 400, y: 200 },
    { x: 700, y: 250 },
    { x: 900, y: 400 },
    { x: 850, y: 650 },
    { x: 600, y: 750 },
    { x: 350, y: 700 },
    { x: 200, y: 500 },
    { x: 250, y: 300 }
];

// Cone layouts - hand-made patterns for variety
const coneLayouts = [
    // Layout 0: Gates and pairs
    [
        { x: 500, y: 220, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 540, y: 220, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 730, y: 260, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 770, y: 280, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 870, y: 430, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 880, y: 490, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 820, y: 600, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 780, y: 640, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 600, y: 735, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 540, y: 750, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 360, y: 690, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 300, y: 670, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 200, y: 470, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 220, y: 420, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 260, y: 310, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 290, y: 330, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 320, y: 235, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 350, y: 245, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 }
    ],
    // Layout 1: Slalom style
    [
        { x: 480, y: 210, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 560, y: 230, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 680, y: 250, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 780, y: 290, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 860, y: 380, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 890, y: 470, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 870, y: 550, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 800, y: 620, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 700, y: 700, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 580, y: 750, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 340, y: 700, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 280, y: 660, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 250, y: 620, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 200, y: 510, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 210, y: 400, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 250, y: 310, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 310, y: 250, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 380, y: 220, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 }
    ],
    // Layout 2: Tight threading lines
    [
        { x: 520, y: 225, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 540, y: 235, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 560, y: 225, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 740, y: 265, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 760, y: 280, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 850, y: 420, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 880, y: 450, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 890, y: 490, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 820, y: 610, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 790, y: 630, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 620, y: 745, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 580, y: 750, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 540, y: 745, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 340, y: 680, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 310, y: 670, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 210, y: 450, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 270, y: 310, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 280, y: 330, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 330, y: 240, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 }
    ]
];

// Initialize layout (will be set properly in init based on ghost)
currentLayout = 0;
let cones = [];

// Get today's date string (YYYY-MM-DD)
function getTodayDateString() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Simple hash function for date seeding
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

// Get daily seeded layout
function getDailyLayout() {
    const dateStr = getTodayDateString();
    const hash = hashString(dateStr);
    return hash % coneLayouts.length;
}

// Initialize
function init() {
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    // Initialize audio context on first user interaction
    const initAudio = () => {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
    };
    
    // Set today's date and load daily best
    todayDateString = getTodayDateString();
    dailyBestScore = parseInt(localStorage.getItem(`paper86-daily-best-${todayDateString}`) || '0');
    
    // Use daily seeded layout
    currentLayout = getDailyLayout();
    cones = JSON.parse(JSON.stringify(coneLayouts[currentLayout]));
    
    // Load ghost from localStorage only if it matches current layout and version
    const savedGhost = localStorage.getItem('paper86-ghost');
    ghostPlayback = [];
    if (savedGhost) {
        try {
            const ghostData = JSON.parse(savedGhost);
            // Check version compatibility
            if (ghostData.version === GHOST_VERSION && 
                ghostData.recording && 
                ghostData.layout === currentLayout) {
                ghostPlayback = ghostData.recording;
            }
        } catch (e) {
            ghostPlayback = [];
        }
    }
    
    // Keyboard controls
    window.addEventListener('keydown', (e) => {
        keys[e.key.toLowerCase()] = true;
        
        if (e.key.toLowerCase() === ' ') {
            e.preventDefault();
            initAudio();
            if (gameState === 'ready') {
                startGame();
            } else if (gameState === 'playing') {
                drifting = true;
            }
        }
        
        if (e.key.toLowerCase() === 'r' && gameState === 'ended') {
            initAudio();
            restart();
        }
        
        if (e.key.toLowerCase() === 'm') {
            toggleMute();
        }
    });
    
    window.addEventListener('keyup', (e) => {
        keys[e.key.toLowerCase()] = false;
        if (e.key.toLowerCase() === ' ') {
            drifting = false;
        }
    });
    
    // Prevent context menu on the game container
    const gameContainer = document.getElementById('game-container');
    gameContainer.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });
    
    // Track active touches for half-screen controls
    const activeTouches = new Map();
    
    // Half-screen touch controls for mobile
    canvas.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        initAudio();
        
        if (gameState === 'ready') {
            startGame();
            return;
        } else if (gameState === 'ended') {
            restart();
            return;
        } else if (gameState === 'playing') {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const halfWidth = rect.width / 2;
            
            const touchData = {
                side: x < halfWidth ? 'left' : 'right',
                startTime: Date.now()
            };
            
            activeTouches.set(e.pointerId, touchData);
            updateTouchState();
        }
    });
    
    canvas.addEventListener('pointermove', (e) => {
        if (gameState === 'playing' && activeTouches.has(e.pointerId)) {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const halfWidth = rect.width / 2;
            
            const touchData = activeTouches.get(e.pointerId);
            touchData.side = x < halfWidth ? 'left' : 'right';
            updateTouchState();
        }
    });
    
    canvas.addEventListener('pointerup', (e) => {
        activeTouches.delete(e.pointerId);
        updateTouchState();
    });
    
    canvas.addEventListener('pointercancel', (e) => {
        activeTouches.delete(e.pointerId);
        updateTouchState();
    });
    
    // Update touch state based on active touches
    function updateTouchState() {
        let hasLeft = false;
        let hasRight = false;
        let hasAnyTouch = false;
        
        for (const [id, data] of activeTouches) {
            hasAnyTouch = true;
            if (data.side === 'left') {
                hasLeft = true;
            } else {
                hasRight = true;
            }
        }
        
        // Set steering state
        touchSteerLeft = hasLeft && !hasRight;
        touchSteerRight = hasRight && !hasLeft;
        
        // If both sides are touched or multi-touch, use the most recent
        if (hasLeft && hasRight) {
            let latestTouch = null;
            let latestTime = 0;
            for (const [id, data] of activeTouches) {
                if (data.startTime > latestTime) {
                    latestTime = data.startTime;
                    latestTouch = data;
                }
            }
            if (latestTouch) {
                touchSteerLeft = latestTouch.side === 'left';
                touchSteerRight = latestTouch.side === 'right';
            }
        }
        
        // Drift when any touch is active (hold to drift)
        touchDrifting = hasAnyTouch;
    }
    
    // End screen tap to restart
    const endScreen = document.getElementById('end-screen');
    endScreen.addEventListener('pointerdown', (e) => {
        // Don't restart if clicking share button
        if (e.target.id === 'share-button') {
            return;
        }
        if (gameState === 'ended') {
            restart();
        }
    });
    
    // Mute button
    const muteBtn = document.getElementById('mute-button');
    muteBtn.textContent = audioMuted ? '🔇' : '🔊';
    muteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMute();
    });
    
    // Share button
    const shareBtn = document.getElementById('share-button');
    shareBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        
        const finalScore = Math.floor(score);
        const shareText = `I scored ${finalScore} in PAPER 86! 🏎️\n${todayDateString} · Daily best: ${dailyBestScore}\n\nPlay: https://paper-86.vercel.app`;
        
        // Try native share API
        if (navigator.share) {
            try {
                await navigator.share({
                    text: shareText
                });
            } catch (err) {
                // User cancelled or error
                if (err.name !== 'AbortError') {
                    console.error('Share failed:', err);
                    fallbackCopy(shareText, shareBtn);
                }
            }
        } else {
            // Fallback to clipboard
            fallbackCopy(shareText, shareBtn);
        }
    });
    
    function fallbackCopy(text, button) {
        navigator.clipboard.writeText(text).then(() => {
            const originalText = button.textContent;
            button.textContent = 'COPIED!';
            button.classList.add('copied');
            setTimeout(() => {
                button.textContent = originalText;
                button.classList.remove('copied');
            }, 2000);
        }).catch(err => {
            console.error('Copy failed:', err);
            button.textContent = 'COPY FAILED';
            setTimeout(() => {
                button.textContent = 'SHARE SCORE';
            }, 2000);
        });
    }
    
    gameLoop();
}

function resizeCanvas() {
    const container = document.getElementById('game-container');
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
}

function startGame() {
    gameState = 'playing';
    localStorage.setItem('paper86-played', 'true');
    firstRun = false;
    collisionGraceTime = 2.0; // Reset grace period
    playSound('start');
}

function restart() {
    gameState = 'playing';
    score = 0;
    timeLeft = 60;
    combo = 0;
    comboDecayWarning = false;
    collisionGraceTime = 2.0;
    car.x = 475;
    car.y = 725;
    car.vx = 0;
    car.vy = 0;
    car.heading = Math.atan2(700 - 750, 350 - 600);
    car.speed = 0;
    car.slipAngle = 0;
    car.currentGripFactor = 1.0;
    physicsAccumulator = 0;
    tireMarks.length = 0;
    particles.length = 0;
    clipPopups.length = 0;
    ghostRecording = [];
    recordingTimer = 0;
    screenShake = { x: 0, y: 0, intensity: 0 };
    
    // Reset run stats
    runStats = {
        clips: 0,
        bestCombo: 0,
        driftTime: 0
    };
    
    // Use daily seeded layout
    currentLayout = getDailyLayout();
    cones = JSON.parse(JSON.stringify(coneLayouts[currentLayout]));
    
    // Reload ghost from localStorage only if it matches current layout and version
    const savedGhost = localStorage.getItem('paper86-ghost');
    ghostPlayback = [];
    if (savedGhost) {
        try {
            const ghostData = JSON.parse(savedGhost);
            // Check version compatibility
            if (ghostData.version === GHOST_VERSION && 
                ghostData.recording && 
                ghostData.layout === currentLayout) {
                ghostPlayback = ghostData.recording;
            }
        } catch (e) {
            ghostPlayback = [];
        }
    }
    
    document.getElementById('end-screen').classList.add('hidden');
    lastConeTime = Date.now();
    lastClipTime = Date.now();
    playSound('start');
}

// =============================================================================
// PHYSICS UPDATE - Fixed timestep arcade drift model
// =============================================================================

function updateCarPhysicsStep() {
    // This runs at fixed PHYSICS_HZ (120Hz) for frame-rate independence
    
    const isDrifting = drifting || touchDrifting;
    
    // Steering input
    let steerInput = 0;
    if (keys['arrowleft'] || keys['a'] || touchSteerLeft) steerInput -= 1;
    if (keys['arrowright'] || keys['d'] || touchSteerRight) steerInput += 1;
    
    // Speed-sensitive steering rate
    const speedRatio = Math.min(car.speed / PHYSICS.MAX_SPEED, 1.0);
    const steerLerp = Math.pow(1.0 - speedRatio, PHYSICS.STEERING_SPEED_CURVE);
    const steeringRate = PHYSICS.MIN_STEERING_RATE + (PHYSICS.BASE_STEERING_RATE - PHYSICS.MIN_STEERING_RATE) * steerLerp;
    
    // Update heading (car's facing direction)
    if (steerInput !== 0 && car.speed > PHYSICS.MIN_SPEED_FOR_STEERING) {
        car.heading += steeringRate * steerInput;
    }
    
    // Automatic forward acceleration along heading
    car.vx += Math.cos(car.heading) * PHYSICS.ACCELERATION;
    car.vy += Math.sin(car.heading) * PHYSICS.ACCELERATION;
    
    // Calculate current speed and velocity angle
    car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    const velocityAngle = car.speed > 0.1 ? Math.atan2(car.vy, car.vx) : car.heading;
    
    // Slip angle = difference between heading and velocity direction
    let slipAngle = car.heading - velocityAngle;
    while (slipAngle > Math.PI) slipAngle -= Math.PI * 2;
    while (slipAngle < -Math.PI) slipAngle += Math.PI * 2;
    car.slipAngle = slipAngle;
    
    // Grip model: smooth transition between normal and drift grip
    const targetGrip = isDrifting ? PHYSICS.DRIFT_REAR_GRIP : 1.0;
    car.currentGripFactor += (targetGrip - car.currentGripFactor) * PHYSICS.GRIP_RECOVERY_RATE;
    
    // Lateral velocity damping (this is the "grip" that pulls velocity toward heading)
    // Split into forward and lateral components
    const forwardVel = car.vx * Math.cos(car.heading) + car.vy * Math.sin(car.heading);
    const lateralVel = -car.vx * Math.sin(car.heading) + car.vy * Math.cos(car.heading);
    
    // Damp lateral velocity based on grip (lower grip = more slide)
    const lateralGrip = isDrifting ? 
        (PHYSICS.DRIFT_FRONT_GRIP + car.currentGripFactor * (PHYSICS.LATERAL_GRIP - PHYSICS.DRIFT_FRONT_GRIP)) :
        PHYSICS.LATERAL_GRIP;
    const dampedLateralVel = lateralVel * lateralGrip;
    
    // Reconstruct velocity from forward/lateral in heading frame
    car.vx = Math.cos(car.heading) * forwardVel - Math.sin(car.heading) * dampedLateralVel;
    car.vy = Math.sin(car.heading) * forwardVel + Math.cos(car.heading) * dampedLateralVel;
    
    // Drift speed loss (scrubbing speed in slides)
    if (isDrifting && car.speed > PHYSICS.DRIFT_MIN_SPEED) {
        const absSlip = Math.abs(slipAngle);
        const speedLoss = absSlip < PHYSICS.CLEAN_DRIFT_THRESHOLD ? 
            PHYSICS.DRIFT_SPEED_RETENTION : 
            PHYSICS.DRIFT_SPEED_RETENTION * PHYSICS.MESSY_DRIFT_PENALTY;
        car.vx *= speedLoss;
        car.vy *= speedLoss;
    }
    
    // Base drag and rolling resistance
    car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    if (car.speed > 0.1) {
        car.vx *= PHYSICS.BASE_DRAG;
        car.vy *= PHYSICS.BASE_DRAG;
        const resistanceLoss = PHYSICS.ROLLING_RESISTANCE;
        const velScale = Math.max(0, car.speed - resistanceLoss) / car.speed;
        car.vx *= velScale;
        car.vy *= velScale;
    }
    
    // Cap at max speed
    car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    if (car.speed > PHYSICS.MAX_SPEED) {
        const scale = PHYSICS.MAX_SPEED / car.speed;
        car.vx *= scale;
        car.vy *= scale;
        car.speed = PHYSICS.MAX_SPEED;
    }
    
    // Update position
    car.x += car.vx;
    car.y += car.vy;
    
    // Tire marks from lateral slip
    const absSlip = Math.abs(slipAngle);
    if (absSlip > PHYSICS.TIRE_MARK_SLIP_THRESHOLD && 
        car.speed > PHYSICS.DRIFT_MIN_SPEED && 
        tireMarks.length < MAX_TIRE_MARKS && 
        Math.random() > PHYSICS.TIRE_MARK_SPACING) {
        
        const slipIntensity = Math.min(absSlip / 0.8, 1.0);
        const opacity = Math.min(slipIntensity * PHYSICS.TIRE_MARK_OPACITY_SCALE, 1.0);
        const offsetDist = 10;
        
        tireMarks.push({
            x: car.x - Math.sin(car.heading) * offsetDist,
            y: car.y + Math.cos(car.heading) * offsetDist,
            angle: velocityAngle + (Math.random() - 0.5) * 0.25,
            alpha: opacity * 0.85
        });
    }
}

function updateCar(dt) {
    if (gameState !== 'playing') return;
    
    const isDrifting = drifting || touchDrifting;
    
    // Track drift time based on actual slip
    const absSlip = Math.abs(car.slipAngle);
    if (absSlip > PHYSICS.DRIFT_SLIP_THRESHOLD && car.speed > PHYSICS.DRIFT_MIN_SPEED) {
        runStats.driftTime += dt;
    }
    
    // Handle drift sound keyed to real slip
    const shouldPlayDriftSound = absSlip > PHYSICS.DRIFT_SLIP_THRESHOLD && car.speed > PHYSICS.DRIFT_MIN_SPEED;
    if (shouldPlayDriftSound && !driftOscillator) {
        startDriftSound();
    } else if (!shouldPlayDriftSound && driftOscillator) {
        stopDriftSound();
    }
    
    // Fixed timestep physics (120Hz accumulator for frame-rate independence)
    physicsAccumulator += Math.min(dt, PHYSICS.MAX_FRAME_TIME);
    while (physicsAccumulator >= physicsDt) {
        updateCarPhysicsStep();
        physicsAccumulator -= physicsDt;
    }
    
    // Record ghost data
    recordingTimer += dt;
    if (recordingTimer >= GHOST_SAMPLE_RATE) {
        ghostRecording.push({
            x: car.x,
            y: car.y,
            heading: car.heading,
            time: 60 - timeLeft
        });
        recordingTimer = 0;
    }
    
    // Check collisions
    checkCollisions();
    
    // Check cone collection and near-misses
    checkCones();
    
    // Fade tire marks
    tireMarks.forEach(mark => {
        mark.alpha *= 0.995;
    });
    tireMarks.splice(0, tireMarks.filter(m => m.alpha < 0.1).length);
    
    // Update particles
    updateParticles(dt);
    
    // Update CLIP popups
    updateClipPopups(dt);
    
    // Update screen shake
    if (screenShake.intensity > 0) {
        screenShake.intensity *= 0.85;
        if (screenShake.intensity < 0.1) {
            screenShake.intensity = 0;
            screenShake.x = 0;
            screenShake.y = 0;
        } else {
            screenShake.x = (Math.random() - 0.5) * screenShake.intensity;
            screenShake.y = (Math.random() - 0.5) * screenShake.intensity;
        }
    }
}

function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.2; // Gravity
        p.vx *= 0.98;
        p.life -= dt;
        p.alpha = p.life / p.maxLife;
        
        if (p.life <= 0) {
            particles.splice(i, 1);
        }
    }
}

function updateClipPopups(dt) {
    for (let i = clipPopups.length - 1; i >= 0; i--) {
        const popup = clipPopups[i];
        popup.life -= dt;
        popup.y -= 50 * dt; // Float upward faster
        
        // Scale animation: grow then shrink
        const lifeRatio = popup.life / 1.5;
        if (lifeRatio > 0.8) {
            popup.scale = 1 + (1 - lifeRatio) * 5; // Grow
        } else {
            popup.scale = 1 + Math.sin(lifeRatio * Math.PI) * 0.2; // Bounce
        }
        
        popup.alpha = Math.min(1, popup.life / 0.4);
        
        if (popup.life <= 0) {
            clipPopups.splice(i, 1);
        }
    }
}

function spawnParticles(x, y, count, color) {
    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 3;
        particles.push({
            x,
            y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 2,
            color,
            life: 0.5 + Math.random() * 0.5,
            maxLife: 1,
            alpha: 1,
            size: 3 + Math.random() * 3
        });
    }
}

function addClipPopup(x, y, comboCount, text = 'CLIP') {
    clipPopups.push({
        x,
        y,
        text: comboCount > 1 ? `${text} x${comboCount}` : text,
        life: 1.5,
        alpha: 1,
        rotation: (Math.random() - 0.5) * 0.08,
        scale: 1
    });
}

// =============================================================================
// COLLISION HANDLING - Physical response with velocity reflection
// =============================================================================

function checkCollisions() {
    // Check if car is on track (only after grace period)
    if (collisionGraceTime <= 0 && !isOnTrack(car.x, car.y)) {
        handleWallCollision();
    }
}

function handleWallCollision() {
    // Physical wall bounce: reflect velocity with restitution and speed loss
    
    // Find closest track edge point to determine collision normal
    let closestDist = Infinity;
    let closestNormalX = 0;
    let closestNormalY = 0;
    
    for (let i = 0; i < trackPoints.length; i++) {
        const p1 = trackPoints[i];
        const p2 = trackPoints[(i + 1) % trackPoints.length];
        
        // Find closest point on this segment
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len2 = dx * dx + dy * dy;
        
        if (len2 === 0) continue;
        
        let t = ((car.x - p1.x) * dx + (car.y - p1.y) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        
        const nearestX = p1.x + t * dx;
        const nearestY = p1.y + t * dy;
        const dist = Math.hypot(car.x - nearestX, car.y - nearestY);
        
        if (dist < closestDist) {
            closestDist = dist;
            // Normal points from track center toward car (outward)
            const toCarX = car.x - nearestX;
            const toCarY = car.y - nearestY;
            const normalLen = Math.hypot(toCarX, toCarY);
            if (normalLen > 0.01) {
                closestNormalX = toCarX / normalLen;
                closestNormalY = toCarY / normalLen;
            }
        }
    }
    
    // Reflect velocity off wall normal
    const velDotNormal = car.vx * closestNormalX + car.vy * closestNormalY;
    
    // Only bounce if moving into the wall
    if (velDotNormal < 0) {
        car.vx -= 2 * velDotNormal * closestNormalX;
        car.vy -= 2 * velDotNormal * closestNormalY;
        
        // Apply restitution and speed loss
        car.vx *= PHYSICS.WALL_RESTITUTION * PHYSICS.WALL_SPEED_LOSS;
        car.vy *= PHYSICS.WALL_RESTITUTION * PHYSICS.WALL_SPEED_LOSS;
        
        // Push car back onto track slightly
        car.x += closestNormalX * 2;
        car.y += closestNormalY * 2;
        
        // Screen shake and sound
        screenShake.intensity = PHYSICS.COLLISION_SHAKE_WALL;
        playSound('wall');
    }
}

function isOnTrack(x, y) {
    // Find closest point on track centerline
    let minDist = Infinity;
    
    for (let i = 0; i < trackPoints.length; i++) {
        const p1 = trackPoints[i];
        const p2 = trackPoints[(i + 1) % trackPoints.length];
        
        const dist = distanceToSegment(x, y, p1.x, p1.y, p2.x, p2.y);
        minDist = Math.min(minDist, dist);
    }
    
    return minDist < trackWidth / 2;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    
    const nearestX = x1 + t * dx;
    const nearestY = y1 + t * dy;
    
    return Math.hypot(px - nearestX, py - nearestY);
}

function checkCones() {
    const now = Date.now();
    const coneRadius = 15;
    const nearMissRadius = 45; // Larger radius for near-miss CLIP detection
    const comboWindow = 3000; // 3 seconds to maintain combo
    const respawnTime = 2000; // 2 seconds to respawn
    const isDrifting = drifting || touchDrifting;
    
    cones.forEach((cone, idx) => {
        if (cone.hit) {
            // Respawn timer
            if (!cone.respawnTimer) {
                cone.respawnTimer = now;
            } else if (now - cone.respawnTimer > respawnTime) {
                cone.hit = false;
                cone.respawnTimer = 0;
                cone.clipped = false;
                cone.clipResetTimer = 0;
            }
            return;
        }
        
        const dist = Math.hypot(car.x - cone.x, car.y - cone.y);
        
        // Check for cone collection (direct hit) - now with physical response
        if (dist < coneRadius + car.width / 2) {
            cone.hit = true;
            combo++;
            runStats.clips++;
            runStats.bestCombo = Math.max(runStats.bestCombo, combo);
            score += 100 * combo;
            lastConeTime = now;
            spawnParticles(cone.x, cone.y, 12, '#d4773d');
            addClipPopup(cone.x, cone.y, combo, 'HIT');
            playSound('clip', combo);
            
            // Physical response: speed loss and small bounce
            const speedLoss = PHYSICS.CONE_HIT_SPEED_LOSS;
            car.vx *= speedLoss;
            car.vy *= speedLoss;
            
            // Small deflection away from cone
            const toConeX = cone.x - car.x;
            const toConeY = cone.y - car.y;
            const coneDistNorm = Math.hypot(toConeX, toConeY);
            if (coneDistNorm > 0.01) {
                const normalX = -toConeX / coneDistNorm;
                const normalY = -toConeY / coneDistNorm;
                car.vx += normalX * 0.5;
                car.vy += normalY * 0.5;
            }
            
            screenShake.intensity = PHYSICS.COLLISION_SHAKE_CONE;
        }
        // Check for near-miss CLIP (threading while drifting)
        else if (!cone.clipped && isDrifting && Math.abs(car.slipAngle) > 0.2 && car.speed > 2.32 && dist < nearMissRadius) {
            cone.clipped = true;
            cone.clipResetTimer = now;
            combo++;
            runStats.clips++;
            runStats.bestCombo = Math.max(runStats.bestCombo, combo);
            const clipScore = 50 * combo;
            score += clipScore;
            lastConeTime = now;
            lastClipTime = now;
            spawnParticles(cone.x, cone.y, 8, '#f3e6c9');
            addClipPopup(cone.x, cone.y, combo, 'CLIP');
            playSound('clip', combo);
            screenShake.intensity = 2;
        }
        
        // Reset clipped status after a short time
        if (cone.clipped && cone.clipResetTimer && now - cone.clipResetTimer > 1000) {
            cone.clipped = false;
            cone.clipResetTimer = 0;
        }
    });
    
    // Check if combo should be dropped
    const timeSinceLastCone = now - lastConeTime;
    if (combo > 0) {
        if (timeSinceLastCone > comboWindow) {
            // Combo broke
            playSound('combo-break');
            screenShake.intensity = 4;
            combo = 0;
            comboDecayWarning = false;
        } else if (timeSinceLastCone > comboWindow * 0.7 && !comboDecayWarning) {
            // Warning that combo is about to break
            comboDecayWarning = true;
        } else if (timeSinceLastCone < comboWindow * 0.7) {
            comboDecayWarning = false;
        }
    }
}

function endGame(reason = 'timeout') {
    gameState = 'ended';
    playSound('end');
    
    if (driftOscillator) {
        stopDriftSound();
    }
    
    const finalScore = Math.floor(score);
    const oldBestScore = bestScore;
    const oldDailyBest = dailyBestScore;
    const isNewBest = finalScore > bestScore;
    const isNewDailyBest = finalScore > dailyBestScore;
    
    // Update all-time best
    if (isNewBest) {
        bestScore = finalScore;
        localStorage.setItem('paper86-best', bestScore.toString());
        
        // Save ghost recording with layout and version
        if (ghostRecording.length > 0) {
            const ghostData = {
                version: GHOST_VERSION,
                layout: currentLayout,
                recording: ghostRecording
            };
            localStorage.setItem('paper86-ghost', JSON.stringify(ghostData));
            ghostPlayback = [...ghostRecording];
        }
    }
    
    // Update daily best
    if (isNewDailyBest) {
        dailyBestScore = finalScore;
        localStorage.setItem(`paper86-daily-best-${todayDateString}`, dailyBestScore.toString());
    }
    
    // Update end card title based on reason
    const endTitle = document.querySelector('.end-title');
    endTitle.textContent = reason === 'crash' ? 'CRASH' : "TIME'S UP";
    
    document.getElementById('final-score').textContent = finalScore;
    document.getElementById('best-score').textContent = bestScore;
    
    // Update run breakdown
    document.getElementById('run-clips').textContent = runStats.clips;
    document.getElementById('run-best-combo').textContent = runStats.bestCombo;
    document.getElementById('run-drift-time').textContent = runStats.driftTime.toFixed(1) + 's';
    
    // Show beat message
    const beatMessage = document.getElementById('beat-message');
    
    if (isNewDailyBest && finalScore > 0) {
        if (oldDailyBest > 0) {
            const improvement = finalScore - oldDailyBest;
            beatMessage.textContent = `New daily best! +${improvement} points`;
        } else {
            beatMessage.textContent = 'First run today!';
        }
        beatMessage.classList.remove('hidden');
    } else if (finalScore > 0 && oldDailyBest > 0) {
        const deficit = oldDailyBest - finalScore;
        beatMessage.textContent = `${deficit} behind today's best`;
        beatMessage.classList.remove('hidden');
    } else {
        beatMessage.classList.add('hidden');
    }
    
    // Show new best badge
    const newBestBadge = document.getElementById('new-best-badge');
    if (isNewDailyBest && finalScore > 0) {
        newBestBadge.classList.remove('hidden');
    } else {
        newBestBadge.classList.add('hidden');
    }
    
    document.getElementById('end-screen').classList.remove('hidden');
}

function updateCamera() {
    // Smooth camera follow
    const targetX = car.x - canvas.width / 2;
    const targetY = car.y - canvas.height / 2;
    
    camera.x += (targetX - camera.x) * 0.1;
    camera.y += (targetY - camera.y) * 0.1;
}

function render() {
    // Clear with paper background
    ctx.fillStyle = '#f3e6c9';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Subtle paper texture (very light noise)
    if (Math.random() > 0.97) {
        ctx.fillStyle = 'rgba(92, 83, 72, 0.015)';
        const x = Math.random() * canvas.width;
        const y = Math.random() * canvas.height;
        ctx.fillRect(x, y, 2, 2);
    }
    
    // Apply camera transform with screen shake
    ctx.save();
    ctx.translate(-camera.x + screenShake.x, -camera.y + screenShake.y);
    
    // Draw track
    drawTrack();
    
    // Draw ghost trail (if playing and ghost exists)
    if (gameState === 'playing' && ghostPlayback.length > 0) {
        drawGhost();
    }
    
    // Draw tire marks
    ctx.strokeStyle = 'rgba(42, 36, 28, 0.3)';
    ctx.lineWidth = 3;
    tireMarks.forEach(mark => {
        ctx.globalAlpha = mark.alpha;
        ctx.save();
        ctx.translate(mark.x, mark.y);
        ctx.rotate(mark.angle);
        ctx.beginPath();
        ctx.moveTo(-5, 0);
        ctx.lineTo(5, 0);
        ctx.stroke();
        ctx.restore();
    });
    ctx.globalAlpha = 1;
    
    // Draw cones
    cones.forEach(cone => {
        if (!cone.hit) {
            ctx.fillStyle = '#d4773d';
            ctx.strokeStyle = '#2a241c';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cone.x, cone.y, 12, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    });
    
    // Draw particles
    particles.forEach(p => {
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    });
    ctx.globalAlpha = 1;
    
    // Draw CLIP popups
    clipPopups.forEach(popup => {
        ctx.save();
        ctx.translate(popup.x, popup.y);
        ctx.rotate(popup.rotation);
        ctx.scale(popup.scale, popup.scale);
        
        ctx.globalAlpha = popup.alpha;
        ctx.font = 'bold 18px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.letterSpacing = '0.15em';
        
        // Cream outline for readability on kraft
        ctx.strokeStyle = '#f3e6c9';
        ctx.lineWidth = 4;
        ctx.strokeText(popup.text, 0, 0);
        
        // Stamp-red fill
        ctx.fillStyle = '#8b1e1e';
        ctx.fillText(popup.text, 0, 0);
        
        ctx.letterSpacing = '0px';
        ctx.restore();
    });
    ctx.globalAlpha = 1;
    
    // Draw car
    drawCar();
    
    // Draw start card
    if (gameState === 'ready') {
        drawStartCard();
    }
    
    // Draw combo meter (when playing and combo > 0)
    if (gameState === 'playing' && combo > 0) {
        drawComboMeter();
    }
    
    ctx.restore();
}

function drawGhost() {
    if (ghostPlayback.length < 2) return;
    
    const currentTime = 60 - timeLeft;
    
    // Find the closest ghost point
    let ghostPoint = null;
    for (let i = 0; i < ghostPlayback.length; i++) {
        if (ghostPlayback[i].time >= currentTime) {
            ghostPoint = ghostPlayback[i];
            break;
        }
    }
    
    if (!ghostPoint && ghostPlayback.length > 0) {
        ghostPoint = ghostPlayback[ghostPlayback.length - 1];
    }
    
    if (!ghostPoint) return;
    
    // Draw softer ghost trail (lighter, finer dash)
    ctx.strokeStyle = 'rgba(139, 30, 30, 0.15)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 10]);
    ctx.beginPath();
    
    let drawnPoints = 0;
    for (let i = 0; i < ghostPlayback.length && drawnPoints < 30; i++) {
        const point = ghostPlayback[i];
        if (point.time <= currentTime) {
            if (drawnPoints === 0) {
                ctx.moveTo(point.x, point.y);
            } else {
                ctx.lineTo(point.x, point.y);
            }
            drawnPoints++;
        }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Draw ghost car - clearer silhouette but still faint
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.translate(ghostPoint.x, ghostPoint.y);
    ctx.rotate(ghostPoint.heading);
    
    // Softer red fill
    ctx.fillStyle = '#8b1e1e';
    
    // Main body
    ctx.beginPath();
    ctx.moveTo(-8, -14);
    ctx.lineTo(-8, 8);
    ctx.lineTo(-5, 14);
    ctx.lineTo(5, 14);
    ctx.lineTo(8, 8);
    ctx.lineTo(8, -14);
    ctx.closePath();
    ctx.fill();
    
    // Lighter windshield detail for depth
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#5c5348';
    ctx.beginPath();
    ctx.moveTo(-6, -8);
    ctx.lineTo(-6, -2);
    ctx.lineTo(6, -2);
    ctx.lineTo(6, -8);
    ctx.closePath();
    ctx.fill();
    
    ctx.restore();
}

function drawStartCard() {
    ctx.save();
    ctx.resetTransform();
    
    // Semi-transparent kraft overlay
    ctx.fillStyle = 'rgba(243, 230, 201, 0.92)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    
    // Stamp-paper card frame
    ctx.save();
    ctx.translate(centerX, centerY - 20);
    ctx.rotate(-0.01);
    
    const cardWidth = 340;
    const cardHeight = 280;
    const cardX = -cardWidth / 2;
    const cardY = -cardHeight / 2;
    
    // Cream card fill
    ctx.fillStyle = '#f3e6c9';
    ctx.fillRect(cardX, cardY, cardWidth, cardHeight);
    
    // Double stamp-red border (outer)
    ctx.strokeStyle = '#8b1e1e';
    ctx.lineWidth = 3;
    ctx.strokeRect(cardX, cardY, cardWidth, cardHeight);
    
    // Inset border
    ctx.lineWidth = 2;
    ctx.strokeRect(cardX + 8, cardY + 8, cardWidth - 16, cardHeight - 16);
    
    // PAPER 86 wordmark
    ctx.fillStyle = '#2a241c';
    ctx.font = '42px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = '0.25em';
    ctx.fillText('PAPER 86', 0, -85);
    ctx.letterSpacing = '0px';
    
    // Date stamp
    ctx.font = '11px "Courier New", monospace';
    ctx.fillStyle = '#8b1e1e';
    ctx.letterSpacing = '0.1em';
    ctx.fillText(todayDateString, 0, -55);
    ctx.letterSpacing = '0px';
    
    // Quiet pitch
    ctx.font = '13px Georgia, serif';
    ctx.fillStyle = '#5c5348';
    ctx.fillText('60s drift attack', 0, -30);
    
    // Controls - tighter, mobile-aware
    ctx.font = '12px "Courier New", monospace';
    ctx.fillStyle = '#2a241c';
    const isMobile = 'ontouchstart' in window;
    if (isMobile) {
        ctx.fillText('Hold left / right half to steer · hold to drift', 0, 10);
    } else {
        ctx.fillText('Arrows steer · Space drifts', 0, 10);
    }
    
    // Thread the cones hint
    ctx.font = '11px Georgia, serif';
    ctx.fillStyle = '#5c5348';
    ctx.fillText('Thread the cones', 0, 40);
    
    // DAILY BEST line (stamp-red Courier when present)
    if (dailyBestScore > 0) {
        ctx.font = 'bold 16px "Courier New", monospace';
        ctx.fillStyle = '#8b1e1e';
        ctx.letterSpacing = '0.1em';
        ctx.fillText(`TODAY'S BEST  ${dailyBestScore}`, 0, 75);
        ctx.letterSpacing = '0px';
    }
    
    // Start hint
    ctx.font = '12px Georgia, serif';
    ctx.fillStyle = '#5c5348';
    ctx.fillText(isMobile ? 'Tap to start' : 'Space or tap to start', 0, 105);
    
    ctx.restore();
    ctx.restore();
}

function drawComboMeter() {
    ctx.save();
    ctx.resetTransform();
    
    const now = Date.now();
    const timeSinceLastCone = now - lastConeTime;
    const comboWindow = 3000;
    const remainingTime = Math.max(0, comboWindow - timeSinceLastCone);
    const progress = remainingTime / comboWindow;
    
    const centerX = canvas.width / 2;
    // Position higher on mobile to avoid overlap with mute button
    const isMobile = canvas.width < 768;
    const meterY = canvas.height - (isMobile ? 100 : 80);
    const meterWidth = 200;
    const meterHeight = 12;
    
    // Background
    ctx.fillStyle = 'rgba(42, 36, 28, 0.3)';
    ctx.fillRect(centerX - meterWidth / 2, meterY, meterWidth, meterHeight);
    
    // Progress bar
    const barColor = comboDecayWarning ? '#d4773d' : '#8b1e1e';
    ctx.fillStyle = barColor;
    ctx.fillRect(centerX - meterWidth / 2, meterY, meterWidth * progress, meterHeight);
    
    // Combo text above meter
    ctx.font = 'bold 20px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#2a241c';
    ctx.fillText(`x${combo} COMBO`, centerX, meterY - 8);
    
    ctx.restore();
}

function drawTrack() {
    // Draw track surface
    ctx.strokeStyle = '#2a241c';
    ctx.lineWidth = trackWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    ctx.beginPath();
    ctx.moveTo(trackPoints[0].x, trackPoints[0].y);
    for (let i = 1; i < trackPoints.length; i++) {
        ctx.lineTo(trackPoints[i].x, trackPoints[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    
    // Draw track fill
    ctx.strokeStyle = '#ded4b8';
    ctx.lineWidth = trackWidth - 8;
    
    ctx.beginPath();
    ctx.moveTo(trackPoints[0].x, trackPoints[0].y);
    for (let i = 1; i < trackPoints.length; i++) {
        ctx.lineTo(trackPoints[i].x, trackPoints[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    
    // Draw center line
    ctx.strokeStyle = 'rgba(42, 36, 28, 0.2)';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 10]);
    
    ctx.beginPath();
    ctx.moveTo(trackPoints[0].x, trackPoints[0].y);
    for (let i = 1; i < trackPoints.length; i++) {
        ctx.lineTo(trackPoints[i].x, trackPoints[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
}

function drawCar() {
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.heading);
    
    // Car body - simple 86 coupe silhouette
    ctx.fillStyle = '#2a241c';
    ctx.strokeStyle = '#2a241c';
    ctx.lineWidth = 2;
    
    // Main body
    ctx.beginPath();
    ctx.moveTo(-10, -18);
    ctx.lineTo(-10, 10);
    ctx.lineTo(-7, 18);
    ctx.lineTo(7, 18);
    ctx.lineTo(10, 10);
    ctx.lineTo(10, -18);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Windshield
    ctx.fillStyle = '#5c5348';
    ctx.beginPath();
    ctx.moveTo(-7, -10);
    ctx.lineTo(-7, -2);
    ctx.lineTo(7, -2);
    ctx.lineTo(7, -10);
    ctx.closePath();
    ctx.fill();
    
    // Hood detail
    ctx.strokeStyle = '#2a241c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -18);
    ctx.lineTo(0, -10);
    ctx.stroke();
    
    ctx.restore();
}

function updateHUD() {
    if (gameState === 'ready') {
        document.getElementById('time-display').textContent = '60.0';
        document.getElementById('score-display').textContent = '0';
        document.getElementById('combo-display').textContent = '';
    } else {
        document.getElementById('time-display').textContent = timeLeft.toFixed(1);
        document.getElementById('score-display').textContent = Math.floor(score);
        document.getElementById('combo-display').textContent = combo > 0 ? `x${combo}` : '';
    }
}

function gameLoop() {
    const dt = 1 / 60;
    
    if (gameState === 'playing') {
        // Update timer
        timeLeft -= dt;
        if (timeLeft <= 0) {
            timeLeft = 0;
            endGame('timeout');
        }
        
        // Update collision grace
        if (collisionGraceTime > 0) {
            collisionGraceTime -= dt;
        }
        
        updateCar(dt);
        updateCamera();
    }
    
    render();
    updateHUD();
    
    requestAnimationFrame(gameLoop);
}

// Start the game
init();
