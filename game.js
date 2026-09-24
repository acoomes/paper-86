// Paper 86 v3 - 60-second drift racing game
// Canvas and game state
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

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

// Audio state
let audioContext = null;
let audioMuted = localStorage.getItem('paper86-muted') === 'true';
let driftOscillator = null;
let driftGain = null;

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
    width: 20,
    height: 36
};

// Physics constants
const ACCELERATION = 0.10;
const MAX_SPEED = 4.75;
const FRICTION = 0.97;
const TURN_SPEED = 0.06;
const DRIFT_TURN_SPEED = 0.09;
const DRIFT_FRICTION = 0.94;
const GRIP_FRICTION = 0.88;
const DRIFT_SPEED_BLEED = 0.97; // Speed loss while drifting
const SLIP_RECOVERY_TIME = 0.2; // Time to snap velocity to heading

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
    
    driftOscillator = audioContext.createOscillator();
    driftGain = audioContext.createGain();
    
    driftOscillator.connect(driftGain);
    driftGain.connect(audioContext.destination);
    
    driftOscillator.type = 'sawtooth';
    driftOscillator.frequency.setValueAtTime(80, now);
    
    driftGain.gain.setValueAtTime(0, now);
    driftGain.gain.linearRampToValueAtTime(0.04, now + 0.1);
    
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
        { x: 450, y: 740, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
        { x: 340, y: 700, hit: false, respawnTimer: 0, clipped: false, clipResetTimer: 0 },
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

// Initialize with random layout
currentLayout = Math.floor(Math.random() * coneLayouts.length);
let cones = JSON.parse(JSON.stringify(coneLayouts[currentLayout]));

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
    
    // Load ghost from localStorage
    const savedGhost = localStorage.getItem('paper86-ghost');
    if (savedGhost) {
        try {
            const ghostData = JSON.parse(savedGhost);
            if (ghostData.recording) {
                // New format with layout
                ghostPlayback = ghostData.recording;
            } else {
                // Old format, just array
                ghostPlayback = ghostData;
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
        const shareText = `I scored ${finalScore} in PAPER 86! 🏎️\nBest: ${bestScore}\n\nPlay: https://paper-86.vercel.app`;
        
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
    car.velocityAngle = car.heading;
    car.speed = 0;
    car.slipAngle = 0;
    car.slipRecoveryTimer = 0;
    tireMarks.length = 0;
    particles.length = 0;
    clipPopups.length = 0;
    ghostRecording = [];
    recordingTimer = 0;
    screenShake = { x: 0, y: 0, intensity: 0 };
    
    // Pick new layout
    currentLayout = Math.floor(Math.random() * coneLayouts.length);
    cones = JSON.parse(JSON.stringify(coneLayouts[currentLayout]));
    
    document.getElementById('end-screen').classList.add('hidden');
    lastConeTime = Date.now();
    lastClipTime = Date.now();
    playSound('start');
}

function updateCar(dt) {
    if (gameState !== 'playing') return;
    
    const isDrifting = drifting || touchDrifting;
    
    // Handle drift sound
    if (isDrifting && car.speed > 2 && !driftOscillator) {
        startDriftSound();
    } else if ((!isDrifting || car.speed <= 2) && driftOscillator) {
        stopDriftSound();
    }
    
    // Steering input
    let steerInput = 0;
    if (keys['arrowleft'] || keys['a'] || touchSteerLeft) steerInput -= 1;
    if (keys['arrowright'] || keys['d'] || touchSteerRight) steerInput += 1;
    
    // Update heading (car's facing direction) based on steering
    if (steerInput !== 0 && car.speed > 0.5) {
        const turnSpeed = isDrifting ? DRIFT_TURN_SPEED : TURN_SPEED;
        const turnAmount = turnSpeed * steerInput * (car.speed / MAX_SPEED);
        car.heading += turnAmount;
    }
    
    // Acceleration (always accelerating forward along heading)
    const accel = ACCELERATION;
    car.vx += Math.cos(car.heading) * accel;
    car.vy += Math.sin(car.heading) * accel;
    
    // Calculate speed and velocity angle
    car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    if (car.speed > 0.1) {
        car.velocityAngle = Math.atan2(car.vy, car.vx);
    }
    
    // Calculate slip angle (difference between heading and velocity)
    let slipAngle = car.heading - car.velocityAngle;
    // Normalize to -PI to PI
    while (slipAngle > Math.PI) slipAngle -= Math.PI * 2;
    while (slipAngle < -Math.PI) slipAngle += Math.PI * 2;
    car.slipAngle = slipAngle;
    
    // Apply friction and drift mechanics
    if (isDrifting && car.speed > 2) {
        // Drifting: rear slips out, speed bleeds
        car.vx *= DRIFT_FRICTION * DRIFT_SPEED_BLEED;
        car.vy *= DRIFT_FRICTION * DRIFT_SPEED_BLEED;
        
        // Counter-steering helps recover
        if (Math.sign(steerInput) !== Math.sign(slipAngle) && steerInput !== 0) {
            // Counter-steering: help align velocity toward heading
            const recoveryFactor = 0.15;
            const targetVx = Math.cos(car.heading) * car.speed;
            const targetVy = Math.sin(car.heading) * car.speed;
            car.vx += (targetVx - car.vx) * recoveryFactor;
            car.vy += (targetVy - car.vy) * recoveryFactor;
        }
        
        // Add tire marks when slip is meaningful
        if (Math.abs(slipAngle) > 0.15 && tireMarks.length < MAX_TIRE_MARKS && Math.random() > 0.3) {
            const offsetDist = 10;
            tireMarks.push({
                x: car.x - Math.sin(car.heading) * offsetDist,
                y: car.y + Math.cos(car.heading) * offsetDist,
                angle: car.velocityAngle + (Math.random() - 0.5) * 0.3,
                alpha: 0.8
            });
        }
        
        car.slipRecoveryTimer = 0;
    } else {
        // Not drifting: snap velocity toward heading
        car.vx *= FRICTION;
        car.vy *= FRICTION;
        
        if (Math.abs(slipAngle) > 0.05 && car.speed > 0.5) {
            // Strongly align velocity to heading when not drifting (grip mode)
            const gripFactor = 0.85;
            const targetVx = Math.cos(car.heading) * car.speed;
            const targetVy = Math.sin(car.heading) * car.speed;
            car.vx += (targetVx - car.vx) * gripFactor;
            car.vy += (targetVy - car.vy) * gripFactor;
        }
        
        car.slipRecoveryTimer = 0;
    }
    
    // Limit max speed
    car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
    if (car.speed > MAX_SPEED) {
        const scale = MAX_SPEED / car.speed;
        car.vx *= scale;
        car.vy *= scale;
        car.speed = MAX_SPEED;
    }
    
    // Update position
    car.x += car.vx;
    car.y += car.vy;
    
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

function checkCollisions() {
    // Check if car is on track (only after grace period)
    if (collisionGraceTime <= 0 && !isOnTrack(car.x, car.y)) {
        screenShake.intensity = 15;
        playSound('wall');
        endGame('crash');
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
        
        // Check for cone collection (direct hit)
        if (dist < coneRadius + car.width / 2) {
            cone.hit = true;
            combo++;
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
    const isNewBest = finalScore > bestScore;
    
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
    
    // Update end card title based on reason
    const endTitle = document.querySelector('.end-title');
    endTitle.textContent = reason === 'crash' ? 'CRASH' : "TIME'S UP";
    
    document.getElementById('final-score').textContent = finalScore;
    document.getElementById('best-score').textContent = bestScore;
    
    // Show new best badge
    const newBestBadge = document.getElementById('new-best-badge');
    if (isNewBest && finalScore > 0) {
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
    
    // Quiet pitch
    ctx.font = '13px Georgia, serif';
    ctx.fillStyle = '#5c5348';
    ctx.fillText('60s drift attack', 0, -50);
    
    // Controls - tighter, mobile-aware
    ctx.font = '12px "Courier New", monospace';
    ctx.fillStyle = '#2a241c';
    const isMobile = 'ontouchstart' in window;
    if (isMobile) {
        ctx.fillText('Hold left / right half to steer · hold to drift', 0, -10);
    } else {
        ctx.fillText('Arrows steer · Space drifts', 0, -10);
    }
    
    // Thread the cones hint
    ctx.font = '11px Georgia, serif';
    ctx.fillStyle = '#5c5348';
    ctx.fillText('Thread the cones', 0, 20);
    
    // BEST line (stamp-red Courier when present)
    if (bestScore > 0) {
        ctx.font = 'bold 16px "Courier New", monospace';
        ctx.fillStyle = '#8b1e1e';
        ctx.letterSpacing = '0.1em';
        ctx.fillText(`BEST  ${bestScore}`, 0, 65);
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
    const meterY = canvas.height - 80;
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
