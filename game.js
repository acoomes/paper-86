// Paper 86 v4 - 60-second drift racing game
// Canvas and game state
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

// =============================================================================
// PHYSICS — every tunable lives here.
// Main's motion numbers were tuned by Andrew at 60Hz as per-frame constants.
// Frame-rate independence: k = dt * 60.
//   accel/turn/position  *= k
//   damping              Math.pow(f, k)
//   alignment lerp       1 - Math.pow(1 - a, k)
// Never apply these per-frame values at a higher tick rate without scaling.
// =============================================================================
const PHYSICS = {
    // --- Planted driving (must match main's on-screen speed within ~10%) ---
    accel: 0.10,              // forward accel along heading, px per 60Hz frame
    maxSpeed: 4.75,           // hard cap, px per 60Hz frame
    gripFriction: 0.97,       // linear damping while planted
    turnRate: 0.06,           // heading yaw at maxSpeed, rad per 60Hz frame
    minSteerSpeed: 0.5,       // no steering below this speed
    gripAlign: 0.85,          // how fast velocity snaps to heading when planted

    // --- Drift (space / mobile hold): heading and velocity stay separate ---
    driftTurnRate: 0.09,      // yaw while drifting, rad per 60Hz frame at maxSpeed
    driftFriction: 0.97,      // keep near planted damping so speed doesn't cliff
    driftBleed: 0.992,        // extra per-frame speed scrub while sliding
    driftMinSpeed: 2.0,       // must be moving to break the rear loose
    driftAlign: 0.06,         // weak velocity follow → tail steps out
    counterAlign: 0.06,       // keep velocity lag while holding a slide
    holdTurnRate: 0.16,       // yaw cap while countersteering so heading can track a holdable slip
    driftAccelMix: 0.22,      // while drifting, this much throttle follows heading (rest follows velocity)
    gripRecoverTime: 0.25,    // seconds to restore planted grip after release
    targetSlip: 0.52,         // ~30 deg — holdable slide with countersteer
    maxSlip: 0.61,            // ~35 deg hard cap; prevents spin-outs
    minVisibleSlip: 0.35,     // ~20 deg — target lower bound of a held slide

    // --- Track collisions (uses real centerline + trackWidth, not a box) ---
    wallRestitution: 0.35,    // reflected normal speed fraction
    wallSpeedKeep: 0.55,      // keep this much speed after a wall hit
    wallShake: 10,            // screen-shake intensity on contact
    wallInset: 0.5,           // stay this many px inside the track edge

    // --- Audio: all gains capped ~0.12, short ramps, no stacking ---
    gainCap: 0.12,
    clipGain: 0.08,
    wallGain: 0.08,
    startGain: 0.08,
    endGain: 0.07,
    comboBreakGain: 0.055,
    driftGain: 0.03
};

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
let lastFrameTime = 0;

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
let activeAudioNodes = []; // oscillators / buffer sources still ringing
let lastWallSoundAt = 0;

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
    velocityAngle: Math.atan2(700 - 750, 350 - 600),
    speed: 0,
    slipAngle: 0,
    slipRecoveryTimer: 0,
    gripBlend: 1, // 1 = planted, 0 = full drift
    width: 20,
    height: 36
};

// Camera
const camera = {
    x: 0,
    y: 0
};

// Tire marks
const tireMarks = [];
const MAX_TIRE_MARKS = 300;

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

function capGain(value) {
    return Math.min(Math.max(value, 0), PHYSICS.gainCap);
}

function trackAudioNode(node, stopAt) {
    activeAudioNodes.push({ node, stopAt });
    node.onended = () => {
        activeAudioNodes = activeAudioNodes.filter(n => n.node !== node);
    };
}

function pruneAudioNodes(now) {
    activeAudioNodes = activeAudioNodes.filter(n => n.stopAt > now);
}

function playPitchedTone({ type = 'sine', freqFrom, freqTo, peakGain, attack = 0.02, duration, curve = 'exp' }) {
    if (audioMuted || !audioContext) return;
    
    const now = audioContext.currentTime;
    pruneAudioNodes(now);
    
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = type;
    osc.connect(gain);
    gain.connect(audioContext.destination);
    
    osc.frequency.setValueAtTime(freqFrom, now);
    if (freqTo !== undefined && freqTo !== freqFrom) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(freqTo, 1), now + duration);
    }
    
    const peak = capGain(peakGain);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + attack);
    if (curve === 'linear') {
        gain.gain.linearRampToValueAtTime(0, now + duration);
    } else {
        gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    }
    
    osc.start(now);
    osc.stop(now + duration + 0.02);
    trackAudioNode(osc, now + duration + 0.02);
}

function playSound(type, comboCount = 0) {
    if (audioMuted || !audioContext) return;
    
    if (type === 'clip') {
        playPitchedTone({
            freqFrom: 400 + (comboCount * 50),
            peakGain: PHYSICS.clipGain,
            attack: 0.01,
            duration: 0.15
        });
    } else if (type === 'wall') {
        // Soft thump — no sawtooth burst, and don't stack on top of a recent hit
        const now = audioContext ? audioContext.currentTime : 0;
        if (now - lastWallSoundAt < 0.12) return;
        lastWallSoundAt = now;
        playPitchedTone({
            type: 'triangle',
            freqFrom: 140,
            freqTo: 70,
            peakGain: PHYSICS.wallGain,
            attack: 0.012,
            duration: 0.16
        });
    } else if (type === 'start') {
        playPitchedTone({
            freqFrom: 300,
            freqTo: 560,
            peakGain: PHYSICS.startGain,
            attack: 0.04,
            duration: 0.28
        });
    } else if (type === 'end') {
        // Soft falling sine, linear fade, no harsh drop
        playPitchedTone({
            type: 'sine',
            freqFrom: 420,
            freqTo: 220,
            peakGain: PHYSICS.endGain,
            attack: 0.05,
            duration: 0.4,
            curve: 'linear'
        });
    } else if (type === 'combo-break') {
        playPitchedTone({
            freqFrom: 640,
            freqTo: 220,
            peakGain: PHYSICS.comboBreakGain,
            attack: 0.01,
            duration: 0.22
        });
    }
}

function stopAllAudio({ playEndCue = false } = {}) {
    if (driftOscillator) {
        stopDriftSound();
    }
    
    if (audioContext) {
        const now = audioContext.currentTime;
        activeAudioNodes.forEach(({ node }) => {
            try {
                node.stop(now);
            } catch (e) {
                // already stopped
            }
        });
        activeAudioNodes = [];
    }
    
    if (playEndCue) {
        playSound('end');
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
    driftFilter.frequency.setValueAtTime(900, now);
    driftFilter.Q.setValueAtTime(0.4, now);
    
    driftGain = audioContext.createGain();
    
    driftOscillator.connect(driftFilter);
    driftFilter.connect(driftGain);
    driftGain.connect(audioContext.destination);
    
    driftGain.gain.setValueAtTime(0, now);
    driftGain.gain.linearRampToValueAtTime(capGain(PHYSICS.driftGain), now + 0.08);
    
    driftOscillator.start(now);
    trackAudioNode(driftOscillator, now + 3600);
}

function stopDriftSound() {
    if (!driftOscillator || !audioContext) return;
    
    const now = audioContext.currentTime;
    const osc = driftOscillator;
    const gain = driftGain;
    driftOscillator = null;
    driftGain = null;
    driftFilter = null;
    
    try {
        if (gain) {
            gain.gain.cancelScheduledValues(now);
            const current = Math.max(gain.gain.value, 0.0001);
            gain.gain.setValueAtTime(current, now);
            gain.gain.linearRampToValueAtTime(0, now + 0.08);
        }
        osc.stop(now + 0.09);
    } catch (e) {
        // already stopped
    }
}

function toggleMute() {
    audioMuted = !audioMuted;
    localStorage.setItem('paper86-muted', audioMuted.toString());
    
    if (audioMuted) {
        stopAllAudio({ playEndCue: false });
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
    
    // Load ghost from localStorage only if it matches current layout
    const savedGhost = localStorage.getItem('paper86-ghost');
    ghostPlayback = [];
    if (savedGhost) {
        try {
            const ghostData = JSON.parse(savedGhost);
            if (ghostData.recording && ghostData.layout === currentLayout) {
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
    stopAllAudio({ playEndCue: false });
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
    car.velocityAngle = car.heading;
    car.speed = 0;
    car.slipAngle = 0;
    car.slipRecoveryTimer = 0;
    car.gripBlend = 1;
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
    
    // Reload ghost from localStorage only if it matches current layout
    const savedGhost = localStorage.getItem('paper86-ghost');
    ghostPlayback = [];
    if (savedGhost) {
        try {
            const ghostData = JSON.parse(savedGhost);
            if (ghostData.recording && ghostData.layout === currentLayout) {
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

function wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
}

function lerpFactor(perFrame, k) {
    // Convert a 60Hz per-frame lerp into a dt-scaled equivalent
    if (k <= 0) return 0;
    return 1 - Math.pow(1 - perFrame, k);
}

function updateCar(dt) {
    if (gameState !== 'playing') return;
    
    // k = 1 at 60Hz. Caps keep a stalled tab from exploding the sim.
    if (dt > 0.05) dt = 0.05;
    if (dt < 0) dt = 0;
    const k = dt * 60;
    
    const holdingDrift = drifting || touchDrifting;
    const isDrifting = holdingDrift && car.speed > PHYSICS.driftMinSpeed;
    
    // Blend grip: 0 while drifting, 1 when planted. Release restores over ~0.25s.
    const gripTarget = isDrifting ? 0 : 1;
    if (isDrifting) {
        car.gripBlend = 0;
    } else if (PHYSICS.gripRecoverTime > 0) {
        car.gripBlend = Math.min(1, car.gripBlend + dt / PHYSICS.gripRecoverTime);
    } else {
        car.gripBlend = gripTarget;
    }
    
    // Track drift time
    if (isDrifting) {
        runStats.driftTime += dt;
    }
    
    // Handle drift sound
    if (isDrifting && !driftOscillator) {
        startDriftSound();
    } else if (!isDrifting && driftOscillator) {
        stopDriftSound();
    }
    
    // Steering input
    let steerInput = 0;
    if (keys['arrowleft'] || keys['a'] || touchSteerLeft) steerInput -= 1;
    if (keys['arrowright'] || keys['d'] || touchSteerRight) steerInput += 1;
    
    const speedRatio = car.speed / PHYSICS.maxSpeed;
    const canSteer = steerInput !== 0 && car.speed > PHYSICS.minSteerSpeed;
    const slipSign = Math.sign(car.slipAngle);
    const isCounter = isDrifting && canSteer && slipSign !== 0 && Math.sign(steerInput) !== slipSign;
    
    // Heading is independent of velocity. Planted: yaw at Andrew's turn rate.
    // Drift + steer into the slide: yaw faster so the tail steps out.
    // Drift + countersteer: hold heading near velocity ± targetSlip, then catch.
    if (canSteer) {
        if (isDrifting && isCounter && Math.abs(car.slipAngle) > 0.08) {
            const desiredHeading = car.velocityAngle + slipSign * PHYSICS.targetSlip;
            const err = wrapAngle(desiredHeading - car.heading);
            const maxTurn = PHYSICS.holdTurnRate * k;
            car.heading += Math.max(-maxTurn, Math.min(maxTurn, err));
        } else {
            const turnSpeed = isDrifting ? PHYSICS.driftTurnRate : PHYSICS.turnRate;
            car.heading += turnSpeed * steerInput * speedRatio * k;
        }
    }
    
    // Acceleration. Planted: along heading (matches main). Drifting: mostly
    // along velocity so throttle doesn't yank the car out of a slide.
    const velAngle = car.speed > 0.1 ? car.velocityAngle : car.heading;
    const accelMix = isDrifting ? PHYSICS.driftAccelMix : 1;
    let ax = Math.cos(car.heading) * accelMix + Math.cos(velAngle) * (1 - accelMix);
    let ay = Math.sin(car.heading) * accelMix + Math.sin(velAngle) * (1 - accelMix);
    const aLen = Math.hypot(ax, ay) || 1;
    car.vx += (ax / aLen) * PHYSICS.accel * k;
    car.vy += (ay / aLen) * PHYSICS.accel * k;
    
    // Speed and velocity angle
    car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    if (car.speed > 0.1) {
        car.velocityAngle = Math.atan2(car.vy, car.vx);
    }
    
    // Slip = heading − travel direction (positive = tail left / nose right)
    car.slipAngle = wrapAngle(car.heading - car.velocityAngle);
    
    // Hard cap: heading cannot run more than maxSlip ahead of velocity (no spin-outs)
    if (Math.abs(car.slipAngle) > PHYSICS.maxSlip) {
        car.heading = car.velocityAngle + Math.sign(car.slipAngle) * PHYSICS.maxSlip;
        car.slipAngle = wrapAngle(car.heading - car.velocityAngle);
    }
    
    // Linear damping
    let friction = PHYSICS.gripFriction;
    if (isDrifting) {
        friction = PHYSICS.driftFriction * PHYSICS.driftBleed;
    }
    const damp = Math.pow(friction, k);
    car.vx *= damp;
    car.vy *= damp;
    
    // Align velocity toward heading. Weak while drifting (tail stays out),
    // strong when planted. Blend on release so grip comes back smoothly.
    let alignPerFrame = PHYSICS.gripAlign * car.gripBlend + PHYSICS.driftAlign * (1 - car.gripBlend);
    if (isCounter) {
        alignPerFrame = Math.max(alignPerFrame, PHYSICS.counterAlign);
    }
    const align = lerpFactor(alignPerFrame, k);
    
    car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    if (car.speed > 0.1 && (isDrifting || Math.abs(car.slipAngle) > 0.02 || car.gripBlend < 1)) {
        const targetVx = Math.cos(car.heading) * car.speed;
        const targetVy = Math.sin(car.heading) * car.speed;
        car.vx += (targetVx - car.vx) * align;
        car.vy += (targetVy - car.vy) * align;
    }
    
    // Tire marks while sliding
    if (isDrifting && Math.abs(car.slipAngle) > 0.15 && tireMarks.length < MAX_TIRE_MARKS && Math.random() > 0.3) {
        const offsetDist = 10;
        tireMarks.push({
            x: car.x - Math.sin(car.heading) * offsetDist,
            y: car.y + Math.cos(car.heading) * offsetDist,
            angle: car.velocityAngle + (Math.random() - 0.5) * 0.3,
            alpha: 0.8
        });
    }
    
    car.slipRecoveryTimer = isDrifting ? 0 : Math.min(PHYSICS.gripRecoverTime, car.slipRecoveryTimer + dt);
    
    // Limit max speed (same cap as main)
    car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    if (car.speed > PHYSICS.maxSpeed) {
        const scale = PHYSICS.maxSpeed / car.speed;
        car.vx *= scale;
        car.vy *= scale;
        car.speed = PHYSICS.maxSpeed;
    }
    
    if (car.speed > 0.1) {
        car.velocityAngle = Math.atan2(car.vy, car.vx);
        car.slipAngle = wrapAngle(car.heading - car.velocityAngle);
    }
    
    // Position: vx is still "px per 60Hz frame", so multiply by k
    car.x += car.vx * k;
    car.y += car.vy * k;
    
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
    const tireFade = Math.pow(0.995, k);
    tireMarks.forEach(mark => {
        mark.alpha *= tireFade;
    });
    tireMarks.splice(0, tireMarks.filter(m => m.alpha < 0.1).length);
    
    // Update particles
    updateParticles(dt, k);
    
    // Update CLIP popups
    updateClipPopups(dt);
    
    // Update screen shake
    if (screenShake.intensity > 0) {
        screenShake.intensity *= Math.pow(0.85, k);
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

function updateParticles(dt, k = dt * 60) {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx * k;
        p.y += p.vy * k;
        p.vy += 0.2 * k; // Gravity
        p.vx *= Math.pow(0.98, k);
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

function closestTrackPoint(x, y) {
    // Nearest point on the closed centerline polyline (the real track, not a box)
    let minDist = Infinity;
    let nearestX = x;
    let nearestY = y;
    
    for (let i = 0; i < trackPoints.length; i++) {
        const p1 = trackPoints[i];
        const p2 = trackPoints[(i + 1) % trackPoints.length];
        const hit = closestPointOnSegment(x, y, p1.x, p1.y, p2.x, p2.y);
        if (hit.dist < minDist) {
            minDist = hit.dist;
            nearestX = hit.x;
            nearestY = hit.y;
        }
    }
    
    return { dist: minDist, x: nearestX, y: nearestY };
}

function closestPointOnSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    
    if (len2 === 0) {
        return { x: x1, y: y1, dist: Math.hypot(px - x1, py - y1) };
    }
    
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    
    const nx = x1 + t * dx;
    const ny = y1 + t * dy;
    return { x: nx, y: ny, dist: Math.hypot(px - nx, py - ny) };
}

function trackClearance(x, y) {
    // Positive = on track, 0 = on the edge, negative = off
    return trackWidth / 2 - closestTrackPoint(x, y).dist;
}

function resolveTrackCollision() {
    const info = closestTrackPoint(car.x, car.y);
    const halfW = trackWidth / 2;
    
    if (info.dist <= halfW - PHYSICS.wallInset) {
        return false;
    }
    
    // Outward normal from the centerline through the car
    let ox = car.x - info.x;
    let oy = car.y - info.y;
    const len = Math.hypot(ox, oy);
    if (len < 1e-6) {
        ox = 1;
        oy = 0;
    } else {
        ox /= len;
        oy /= len;
    }
    
    // Push back onto the track so the car can never leave the play area
    const inset = halfW - PHYSICS.wallInset;
    car.x = info.x + ox * inset;
    car.y = info.y + oy * inset;
    
    // Reflect the outward velocity component and scrub speed
    const vn = car.vx * ox + car.vy * oy;
    if (vn > 0) {
        car.vx -= (1 + PHYSICS.wallRestitution) * vn * ox;
        car.vy -= (1 + PHYSICS.wallRestitution) * vn * oy;
    }
    car.vx *= PHYSICS.wallSpeedKeep;
    car.vy *= PHYSICS.wallSpeedKeep;
    car.speed = Math.hypot(car.vx, car.vy);
    if (car.speed > 0.1) {
        car.velocityAngle = Math.atan2(car.vy, car.vx);
    }
    
    return true;
}

function checkCollisions() {
    const hit = resolveTrackCollision();
    if (!hit) return;
    
    // Always shake and stay in-bounds. After the start grace, a wall still ends the run.
    if (collisionGraceTime <= 0) {
        screenShake.intensity = PHYSICS.wallShake;
        endGame('crash');
    } else {
        screenShake.intensity = PHYSICS.wallShake * 0.6;
        playSound('wall');
    }
}

function isOnTrack(x, y) {
    return closestTrackPoint(x, y).dist < trackWidth / 2;
}

function checkCones() {
    if (gameState !== 'playing') return;
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
        
        // Check for cone collection (direct hit)
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
            screenShake.intensity = 3;
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
    if (gameState === 'ended') return;
    gameState = 'ended';
    
    // Kill drift / stacked tones first, then a single soft end cue
    stopAllAudio({ playEndCue: true });
    
    const finalScore = Math.floor(score);
    const oldBestScore = bestScore;
    const oldDailyBest = dailyBestScore;
    const isNewBest = finalScore > bestScore;
    const isNewDailyBest = finalScore > dailyBestScore;
    
    // Update all-time best
    if (isNewBest) {
        bestScore = finalScore;
        localStorage.setItem('paper86-best', bestScore.toString());
        
        // Save ghost recording with layout
        if (ghostRecording.length > 0) {
            const ghostData = {
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

function gameLoop(timestamp) {
    if (lastFrameTime === 0) lastFrameTime = timestamp || performance.now();
    const now = timestamp || performance.now();
    let dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    if (dt > 0.05) dt = 0.05;
    if (dt < 0) dt = 0;
    
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
